import { spawn as spawnChild, type ChildProcessWithoutNullStreams } from "child_process";
import { generationCancelledError, NativeRuntimeError } from "../errors";
import {
  parseBridgeResult,
  reportedBridgeFailure,
  type BridgeProbeResult,
  type LocalModel,
} from "../localTtsIpc";
import {
  NATIVE_OUTPUT_TAIL_CHARS,
  NativeOutputTail,
  nativeOutputExcerpt,
  sanitizeNativeOutput,
  withNativeOutput,
} from "../nativeOutput";
import { bridgeWorkingDirectory } from "./bridgeEnvironment";

export type SpawnBridgeProcess = (
  command: string,
  args: string[],
  options: { stdio: ["pipe", "pipe", "pipe"]; env: NodeJS.ProcessEnv; cwd: string; windowsHide: boolean },
) => ChildProcessWithoutNullStreams;

export interface ProbeRequest {
  requestId: string;
  model: LocalModel;
  bridgeBinary: string;
  cacheDir: string;
  env: NodeJS.ProcessEnv;
}

export interface ProbeRunnerOptions {
  /** Absolute deadline for one probe. */
  timeoutMs: number;
  /** How long a terminated probe gets before SIGKILL. */
  killGraceMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  spawn?: SpawnBridgeProcess;
}

export interface ProbeRunner {
  run(request: ProbeRequest): Promise<BridgeProbeResult>;
  /** Stops a running probe; false when `requestId` has no probe child. */
  terminate(requestId: string): boolean;
  /** Stops every probe and returns their exits, for the quit barrier. */
  terminateAll(): Promise<void>[];
}

/** SIGTERM now, SIGKILL after the grace period if the child is still there. */
export function terminateChild(child: ChildProcessWithoutNullStreams, killGraceMs: number): void {
  try {
    child.kill();
  } catch {
    // The process may have already exited.
  }
  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may have already exited.
    }
  }, killGraceMs).unref();
}

/**
 * Runs the one-shot `--action probe` bridge subprocess — the only bridge action
 * left on the stdout protocol, now that generation runs on the WebSocket worker
 * pool. Each probe runs to a single absolute deadline and reports through the
 * stdout result envelope.
 */
export function createProbeRunner({
  timeoutMs,
  killGraceMs,
  maxStdoutBytes,
  maxStderrBytes,
  spawn = spawnChild,
}: ProbeRunnerOptions): ProbeRunner {
  // Tracked so a probe child can be force-killed by cancellation and the quit.
  const children = new Map<string, ChildProcessWithoutNullStreams>();
  // Children stopped on purpose; their exit is a cancellation, not a failure.
  const stopped = new WeakSet<ChildProcessWithoutNullStreams>();

  function stop(child: ChildProcessWithoutNullStreams): void {
    stopped.add(child);
    terminateChild(child, killGraceMs);
  }

  return {
    run({ requestId, model, bridgeBinary, cacheDir, env }) {
      if (children.has(requestId)) {
        return Promise.reject(new Error(`A request with id ${requestId} is already running.`));
      }

      return new Promise((resolve, reject) => {
        const child = spawn(
          bridgeBinary,
          [
            "--action",
            "probe",
            "--model",
            model,
            "--cache-dir",
            cacheDir,
          ],
          {
            stdio: ["pipe", "pipe", "pipe"],
            env,
            cwd: bridgeWorkingDirectory(cacheDir),
            // The bridge is a console program; without this a packaged
            // Windows app opens a console window for every probe.
            windowsHide: true,
          },
        );
        children.set(requestId, child);

        // stdout carries the result line, so it is kept whole (up to its cap)
        // and decoded once at close: per-chunk decoding can split a multi-byte
        // character, and repeated `+=` on a multi-megabyte string reallocates
        // it on every data event. stderr is only ever diagnostics, so a
        // bounded tail does.
        const stdoutChunks: Buffer[] = [];
        const stderrTail = new NativeOutputTail();
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let settled = false;

        const onTimeout = () => {
          if (settled) return;
          settled = true;
          terminateChild(child, killGraceMs);
          children.delete(requestId);
          reject(new Error(`Local bridge timed out after ${timeoutMs / 1000}s.`));
        };
        const timeoutHandle = setTimeout(onTimeout, timeoutMs);

        const cleanup = () => {
          clearTimeout(timeoutHandle);
          children.delete(requestId);
        };

        const rejectForOutputLimit = (streamName: "stdout" | "stderr", limitBytes: number) => {
          if (settled) return;
          settled = true;
          terminateChild(child, killGraceMs);
          cleanup();
          reject(new Error(`Local bridge ${streamName} exceeded ${limitBytes} bytes.`));
        };

        child.stdout.on("data", (chunk: Buffer) => {
          stdoutBytes += chunk.byteLength;
          if (stdoutBytes > maxStdoutBytes) {
            rejectForOutputLimit("stdout", maxStdoutBytes);
            return;
          }
          stdoutChunks.push(chunk);
        });

        child.stderr.on("data", (chunk: Buffer) => {
          stderrBytes += chunk.byteLength;
          if (stderrBytes > maxStderrBytes) {
            rejectForOutputLimit("stderr", maxStderrBytes);
            return;
          }
          stderrTail.append(chunk);
        });

        child.on("error", (err) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error(`Failed to run Rust local bridge: ${err.message}`));
        });

        child.on("close", (code, signal) => {
          if (settled) return;
          settled = true;
          cleanup();

          if (stopped.has(child)) {
            reject(generationCancelledError());
            return;
          }
          const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
          if (code !== 0) {
            // The bridge prints why it failed as its last stdout result line;
            // stderr then explains what led there.
            const stderr = sanitizeNativeOutput(stderrTail.text);
            const stdoutTail = sanitizeNativeOutput(stdout.slice(-NATIVE_OUTPUT_TAIL_CHARS));
            const summary = reportedBridgeFailure(stdout)
              ?? `Rust local bridge exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}.`;
            reject(new NativeRuntimeError(withNativeOutput(summary, stderr), {
              ...(stderr.trim() ? { stderr } : {}),
              ...(stdoutTail.trim() ? { stdout: stdoutTail } : {}),
              exitCode: code,
              signal,
            }));
            return;
          }

          try {
            resolve(parseBridgeResult(stdout, nativeOutputExcerpt(stderrTail.text)));
          } catch (err) {
            reject(err);
          }
        });

        child.stdin.write(JSON.stringify({}));
        child.stdin.end();
      });
    },

    terminate(requestId) {
      const child = children.get(requestId);
      if (!child) return false;
      stop(child);
      return true;
    },

    terminateAll() {
      const running = [...children.values()];
      for (const child of running) {
        stop(child);
      }
      children.clear();
      return running.map((child) =>
        child.exitCode !== null || child.signalCode !== null
          ? Promise.resolve()
          : new Promise<void>((resolve) => child.once("exit", () => resolve())),
      );
    },
  };
}
