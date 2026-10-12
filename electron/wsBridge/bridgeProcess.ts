import type { ChildProcessWithoutNullStreams } from "child_process";
import { NativeRuntimeError, type NativeFailureDiagnostics } from "../errors";
import { reportedBridgeFailure } from "../localTtsIpc";
import {
  NativeOutputTail,
  redactSecret,
  sanitizeNativeOutput,
  withNativeOutput,
} from "../nativeOutput";
import { delay } from "./connection";
import {
  MAX_PORT_ANNOUNCEMENT_BUFFER_BYTES,
  parsePortAnnouncement,
  parseStartupFailure,
} from "./protocol";

// How long a failure waits for a dead process's last output. 'exit' and the
// socket close can both arrive before the stderr pipe is drained, and the
// final lines are usually the panic or abort that explains the failure.
export const OUTPUT_DRAIN_GRACE_MS = 250;

export type BridgeOutputStream = "stdout" | "stderr";

export interface BridgeProcessOptions {
  /** The WebSocket token the process was started with, kept out of diagnostics. */
  authToken: string;
  /** How long the process gets to announce its port. */
  connectTimeoutMs: number;
  /** How long a terminated process gets before SIGKILL. */
  killGraceMs: number;
  /** Every chunk the process prints, after it has been added to the tails. */
  onOutput: (stream: BridgeOutputStream, chunk: Buffer) => void;
  /**
   * The process failed to spawn, exited, or closed its stdio. May be called
   * more than once for one process.
   */
  onExit: () => void;
}

/**
 * One `serve-ws` bridge process: its startup handshake (the `__PORT__` line or
 * a reported startup failure), its exit, and bounded tails of what it printed
 * — kept across requests so any failure, at startup or mid-request, can show
 * what the process last said.
 */
export class BridgeProcess {
  readonly child: ChildProcessWithoutNullStreams;
  /** Resolves with the announced WebSocket port, or rejects with why there is none. */
  readonly announcedPort: Promise<number>;
  /** Resolves once the process has failed to spawn, exited or closed its stdio. */
  readonly exited: Promise<void>;
  /** Resolves once the process's stdio has closed, i.e. all output is read. */
  readonly outputClosed: Promise<void>;
  readonly #authToken: string;
  readonly #killGraceMs: number;
  readonly #stdoutTail = new NativeOutputTail();
  readonly #stderrTail = new NativeOutputTail();
  #exitCode: number | null = null;
  #exitSignal: NodeJS.Signals | null = null;

  constructor(child: ChildProcessWithoutNullStreams, options: BridgeProcessOptions) {
    this.child = child;
    this.#authToken = options.authToken;
    this.#killGraceMs = options.killGraceMs;

    let resolveExited!: () => void;
    this.exited = new Promise((resolve) => {
      resolveExited = resolve;
    });
    let markOutputClosed!: () => void;
    this.outputClosed = new Promise((resolve) => {
      markOutputClosed = resolve;
    });
    let resolvePort!: (port: number) => void;
    let rejectPort!: (error: Error) => void;
    this.announcedPort = new Promise((resolve, reject) => {
      resolvePort = resolve;
      rejectPort = reject;
    });
    // A process that dies after its startup was abandoned rejects a promise
    // nobody awaits any more; that is not an unhandled failure.
    this.announcedPort.catch(() => undefined);

    let portSettled = false;
    let stdoutLineBuffer = "";
    const portTimeout = setTimeout(() => {
      settlePort(new Error("Timed out waiting for Rust local bridge WebSocket port."));
    }, options.connectTimeoutMs);
    portTimeout.unref?.();

    function settlePort(outcome: number | Error): void {
      if (portSettled) return;
      portSettled = true;
      clearTimeout(portTimeout);
      if (typeof outcome === "number") resolvePort(outcome);
      else rejectPort(outcome);
    }

    const readStartupLines = (chunk: Buffer) => {
      if (portSettled) return;
      stdoutLineBuffer += chunk.toString("utf-8");
      const lines = stdoutLineBuffer.split(/\r?\n/);
      stdoutLineBuffer = lines.pop() ?? "";
      for (const rawLine of lines) {
        const line = rawLine.trim();
        try {
          const startupFailure = parseStartupFailure(line);
          if (startupFailure) {
            settlePort(startupFailure);
            return;
          }
          const port = parsePortAnnouncement(line);
          if (port === null) continue;
          settlePort(port);
        } catch (error) {
          settlePort(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }
      if (Buffer.byteLength(stdoutLineBuffer, "utf-8") > MAX_PORT_ANNOUNCEMENT_BUFFER_BYTES) {
        settlePort(new Error(
          `Rust local bridge startup output exceeded ${MAX_PORT_ANNOUNCEMENT_BUFFER_BYTES} bytes before announcing its WebSocket port.`,
        ));
      }
    };

    const recordExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.hasExited()) return;
      this.#exitCode = code ?? null;
      this.#exitSignal = signal ?? null;
    };
    const exit = () => {
      resolveExited();
      options.onExit();
    };

    child.stdout.on("data", (chunk: Buffer) => {
      this.#stdoutTail.append(chunk);
      readStartupLines(chunk);
      options.onOutput("stdout", chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.#stderrTail.append(chunk);
      options.onOutput("stderr", chunk);
    });
    child.on("error", (error) => {
      // A child that failed to spawn has no output left to read.
      markOutputClosed();
      settlePort(new Error(`Rust local bridge worker failed before startup: ${error.message}`));
      exit();
    });
    child.on("close", (code, signal) => {
      recordExit(code, signal);
      markOutputClosed();
      settlePort(new Error(`Rust local bridge exited before announcing its WebSocket port (${this.exitStatus()}).`));
      exit();
    });
    child.on("exit", (code, signal) => {
      recordExit(code, signal);
      exit();
    });
  }

  hasExited(): boolean {
    return this.#exitCode !== null || this.#exitSignal !== null;
  }

  exitStatus(): string {
    return this.#exitSignal ? `signal ${this.#exitSignal}` : `code ${this.#exitCode ?? "unknown"}`;
  }

  /** Waits (bounded) for the last output of a process that is gone or going. */
  waitForOutput(): Promise<void> {
    return Promise.race([this.outputClosed, delay(OUTPUT_DRAIN_GRACE_MS)]);
  }

  /** SIGTERM now, SIGKILL after the grace period. Safe on an exited process. */
  hardKill(): void {
    const { child } = this;
    try {
      child.kill();
    } catch {
      // Already exited.
    }
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
    }, this.#killGraceMs).unref?.();
  }

  diagnostics(details?: string): NativeFailureDiagnostics {
    // The token is passed through the environment and never printed, but a
    // native crash dump is not something to trust with it.
    const stderr = sanitizeNativeOutput(redactSecret(this.#stderrTail.text, this.#authToken));
    const stdout = sanitizeNativeOutput(redactSecret(this.#stdoutTail.text, this.#authToken));
    return {
      ...(details ? { details } : {}),
      ...(stderr.trim() ? { stderr } : {}),
      ...(stdout.trim() ? { stdout } : {}),
      exitCode: this.#exitCode,
      signal: this.#exitSignal,
    };
  }

  /**
   * A failure only the process can explain (a crash, a hang, an output flood):
   * the message itself carries an excerpt of what the process last printed.
   */
  processFailure(message: string): NativeRuntimeError {
    const diagnostics = this.diagnostics();
    return new NativeRuntimeError(withNativeOutput(message, diagnostics.stderr ?? ""), diagnostics);
  }

  /**
   * A protocol or request failure: the message stays as is and the process
   * output travels only to the diagnostics log, with the bridge's full error
   * chain when it differs from the message.
   */
  requestFailure(message: string, details?: unknown): NativeRuntimeError {
    const fullChain = typeof details === "string" && details.trim() && details !== message ? details : undefined;
    return new NativeRuntimeError(message, this.diagnostics(fullChain));
  }

  /**
   * `summary` plus whatever the dead process can still say for itself: its
   * exit status once known, and the failure it reported on stdout before
   * exiting.
   */
  exitFailure(summary: string): NativeRuntimeError {
    const status = this.hasExited() ? ` (${this.exitStatus()})` : "";
    const reported = reportedBridgeFailure(this.#stdoutTail.text);
    return this.processFailure(`${summary}${status}${reported ? `: ${reported}` : "."}`);
  }
}
