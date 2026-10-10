import { spawn as spawnChild, type ChildProcessWithoutNullStreams } from "child_process";
import { parseBridgeResult, type BridgeProbeResult, type LocalModel } from "../localTtsIpc";

export type SpawnBridgeProcess = (
  command: string,
  args: string[],
  options: { stdio: ["pipe", "pipe", "pipe"]; env: NodeJS.ProcessEnv; cwd: string },
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
            cwd: cacheDir,
          },
        );
        children.set(requestId, child);

        // Collected as fragments and joined once at close. Repeated `+=` on a
        // multi-megabyte string reallocates the whole buffer on every data event.
        const stdoutParts: string[] = [];
        const stderrParts: string[] = [];
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
          stdoutParts.push(chunk.toString("utf-8"));
        });

        child.stderr.on("data", (chunk: Buffer) => {
          stderrBytes += chunk.byteLength;
          if (stderrBytes > maxStderrBytes) {
            rejectForOutputLimit("stderr", maxStderrBytes);
            return;
          }
          stderrParts.push(chunk.toString("utf-8"));
        });

        child.on("error", (err) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error(`Failed to run Rust local bridge: ${err.message}`));
        });

        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          cleanup();

          const stderr = stderrParts.join("");
          if (code !== 0) {
            if (stderr.trim()) {
              console.error(`[local-tts:probe] Rust local bridge stderr\n${stderr}`);
            }
            reject(new Error(stderr.trim() || `Rust local bridge exited with code ${code ?? "unknown"}.`));
            return;
          }

          try {
            resolve(parseBridgeResult(stdoutParts.join(""), stderr));
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
      terminateChild(child, killGraceMs);
      return true;
    },

    terminateAll() {
      const running = [...children.values()];
      for (const child of running) {
        terminateChild(child, killGraceMs);
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
