import type { ChildProcessWithoutNullStreams } from "child_process";
import { BRIDGE_PROGRESS_PREFIX, BRIDGE_RESULT_PREFIX } from "./localTtsIpc";

// A pool of long-lived Python bridge workers, keyed by model. Spawning a fresh
// interpreter per generation re-imports torch and reloads the model (and pays
// the first-inference accelerator warmup) every time; for Qwen3 that is the bulk
// of the wall time. A resident worker loads once via the bridge's `serve` action
// and answers many requests over stdin, so only the first request after a (re)spawn
// pays those costs.
//
// Requests are serialized by the caller (one generation per model in flight), so a
// worker handles strictly one request at a time. This module owns process
// lifecycle, newline-framed request/response correlation, per-request stall
// detection, output caps, cancellation, and idle eviction to release model memory.

export interface PersistentWorkerSpawnConfig {
  pythonBinary: string;
  scriptPath: string;
  cacheDir: string;
  env: NodeJS.ProcessEnv;
}

export type PersistentWorkerSpawn<TModel extends string> = (
  model: TModel,
  config: PersistentWorkerSpawnConfig,
) => ChildProcessWithoutNullStreams;

export interface PersistentWorkerRunOptions {
  requestId: string;
  payload: Record<string, unknown>;
  spawnConfig: PersistentWorkerSpawnConfig;
  // Stall watchdog: reject (and kill the worker) when no output arrives for this
  // long. Any stdout/stderr re-arms it, so steady heartbeats keep a slow-but-
  // working request alive — it only fires when the worker goes truly silent.
  idleTimeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  // Receives each raw `__PROGRESS__` line for this request; the caller parses it.
  onProgressLine: (line: string) => void;
}

export interface PersistentWorkerRunResult {
  stdout: string;
  stderr: string;
}

export interface CreatePersistentBridgeWorkerPoolOptions<TModel extends string> {
  spawn: PersistentWorkerSpawn<TModel>;
  // How long a worker may sit idle (no in-flight request) before it is killed to
  // free the resident model's memory. The next request transparently respawns.
  idleEvictMs: number;
  // SIGTERM, then SIGKILL after this delay, when cancelling/evicting.
  killGraceMs?: number;
}

export interface PersistentBridgeWorkerPool<TModel extends string> {
  run: (model: TModel, options: PersistentWorkerRunOptions) => Promise<PersistentWorkerRunResult>;
  cancel: (requestId: string) => boolean;
  shutdown: (model: TModel) => void;
  shutdownAll: () => void;
  isRunning: (requestId: string) => boolean;
}

interface ActiveRequest {
  requestId: string;
  resolve: (result: PersistentWorkerRunResult) => void;
  reject: (error: Error) => void;
  onProgressLine: (line: string) => void;
  idleTimeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

interface Worker {
  child: ChildProcessWithoutNullStreams;
  spawnKey: string;
  stdoutLineBuffer: string;
  active: ActiveRequest | null;
  evictTimer: ReturnType<typeof setTimeout> | null;
  alive: boolean;
}

function spawnKeyOf(config: PersistentWorkerSpawnConfig): string {
  const envPairs = Object.entries(config.env ?? {})
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([config.pythonBinary, config.scriptPath, config.cacheDir, envPairs]);
}

export function createPersistentBridgeWorkerPool<TModel extends string>({
  spawn,
  idleEvictMs,
  killGraceMs = 2_000,
}: CreatePersistentBridgeWorkerPoolOptions<TModel>): PersistentBridgeWorkerPool<TModel> {
  const workers = new Map<TModel, Worker>();
  const requestModel = new Map<string, TModel>();
  const cancelledRequests = new Set<string>();

  function clearActiveIdleTimer(active: ActiveRequest): void {
    if (active.idleTimer) {
      clearTimeout(active.idleTimer);
      active.idleTimer = null;
    }
  }

  function disposeWorker(model: TModel, worker: Worker): void {
    worker.alive = false;
    if (worker.evictTimer) {
      clearTimeout(worker.evictTimer);
      worker.evictTimer = null;
    }
    if (workers.get(model) === worker) {
      workers.delete(model);
    }
  }

  function hardKill(child: ChildProcessWithoutNullStreams): void {
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
    }, killGraceMs).unref?.();
  }

  function killWorker(model: TModel, worker: Worker): void {
    disposeWorker(model, worker);
    hardKill(worker.child);
  }

  function settleActive(
    model: TModel,
    worker: Worker,
    outcome: { ok: true } | { ok: false; error: Error },
  ): void {
    const active = worker.active;
    if (!active || active.settled) return;
    active.settled = true;
    clearActiveIdleTimer(active);
    worker.active = null;
    requestModel.delete(active.requestId);
    cancelledRequests.delete(active.requestId);

    if (outcome.ok) {
      active.resolve({ stdout: active.stdout, stderr: active.stderr });
      // Worker stays warm; start the idle-eviction countdown.
      if (worker.alive) {
        if (worker.evictTimer) clearTimeout(worker.evictTimer);
        worker.evictTimer = setTimeout(() => killWorker(model, worker), idleEvictMs);
        worker.evictTimer.unref?.();
      }
    } else {
      active.reject(outcome.error);
    }
  }

  function armIdleTimer(model: TModel, worker: Worker, active: ActiveRequest): void {
    clearActiveIdleTimer(active);
    active.idleTimer = setTimeout(() => {
      settleActive(model, worker, {
        ok: false,
        error: new Error(
          `Python bridge produced no output for ${active.idleTimeoutMs / 1000}s and was stopped (the process may be stuck).`,
        ),
      });
      killWorker(model, worker);
    }, active.idleTimeoutMs);
    active.idleTimer.unref?.();
  }

  function handleStdout(model: TModel, worker: Worker, chunk: Buffer | string): void {
    const active = worker.active;
    if (!active || active.settled) return;
    armIdleTimer(model, worker, active);

    const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    active.stdoutBytes += Buffer.byteLength(text, "utf-8");
    if (active.stdoutBytes > active.maxStdoutBytes) {
      const error = new Error(`Python bridge stdout exceeded ${active.maxStdoutBytes} bytes.`);
      settleActive(model, worker, { ok: false, error });
      killWorker(model, worker);
      return;
    }

    worker.stdoutLineBuffer += text;
    const lines = worker.stdoutLineBuffer.split(/\r?\n/);
    worker.stdoutLineBuffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      if (worker.active !== active || active.settled) break;
      active.stdout += `${rawLine}\n`;
      const line = rawLine.trim();
      if (line.startsWith(BRIDGE_PROGRESS_PREFIX)) {
        try {
          active.onProgressLine(line);
        } catch {
          // A progress consumer must never break request handling.
        }
      } else if (line.startsWith(BRIDGE_RESULT_PREFIX)) {
        settleActive(model, worker, { ok: true });
      }
    }
  }

  function handleStderr(model: TModel, worker: Worker, chunk: Buffer | string): void {
    const active = worker.active;
    if (!active || active.settled) return;
    armIdleTimer(model, worker, active);
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    active.stderrBytes += Buffer.byteLength(text, "utf-8");
    if (active.stderrBytes > active.maxStderrBytes) {
      const error = new Error(`Python bridge stderr exceeded ${active.maxStderrBytes} bytes.`);
      settleActive(model, worker, { ok: false, error });
      killWorker(model, worker);
      return;
    }
    active.stderr += text;
  }

  function handleExit(model: TModel, worker: Worker): void {
    const wasAlive = worker.alive;
    disposeWorker(model, worker);
    const active = worker.active;
    if (!active || active.settled) return;
    const cancelled = cancelledRequests.has(active.requestId);
    settleActive(model, worker, {
      ok: false,
      error: new Error(
        cancelled
          ? "Generation cancelled."
          : wasAlive
            ? "Python bridge worker exited before returning a result."
            : "Python bridge worker is no longer available.",
      ),
    });
  }

  function spawnWorker(model: TModel, spawnConfig: PersistentWorkerSpawnConfig): Worker {
    const child = spawn(model, spawnConfig);
    const worker: Worker = {
      child,
      spawnKey: spawnKeyOf(spawnConfig),
      stdoutLineBuffer: "",
      active: null,
      evictTimer: null,
      alive: true,
    };

    child.stdout.on("data", (chunk: Buffer) => handleStdout(model, worker, chunk));
    child.stderr.on("data", (chunk: Buffer) => handleStderr(model, worker, chunk));
    child.on("error", () => handleExit(model, worker));
    child.on("close", () => handleExit(model, worker));
    child.on("exit", () => handleExit(model, worker));

    workers.set(model, worker);
    return worker;
  }

  function acquireWorker(model: TModel, spawnConfig: PersistentWorkerSpawnConfig): Worker {
    const existing = workers.get(model);
    const wantedKey = spawnKeyOf(spawnConfig);
    if (existing && existing.alive && existing.spawnKey === wantedKey) {
      return existing;
    }
    // Identity (binary/script/cache/env) changed or the worker is gone: replace it.
    if (existing) killWorker(model, existing);
    return spawnWorker(model, spawnConfig);
  }

  return {
    run(model, options) {
      return new Promise<PersistentWorkerRunResult>((resolve, reject) => {
        const existing = workers.get(model);
        if (existing?.active) {
          reject(new Error(`A ${model} generation is already running.`));
          return;
        }
        if (requestModel.has(options.requestId)) {
          reject(new Error(`A request with id ${options.requestId} is already running.`));
          return;
        }

        let worker: Worker;
        try {
          worker = acquireWorker(model, options.spawnConfig);
        } catch (err) {
          reject(new Error(`Failed to start Python bridge worker: ${err instanceof Error ? err.message : String(err)}`));
          return;
        }

        if (worker.evictTimer) {
          clearTimeout(worker.evictTimer);
          worker.evictTimer = null;
        }

        const active: ActiveRequest = {
          requestId: options.requestId,
          resolve,
          reject,
          onProgressLine: options.onProgressLine,
          idleTimeoutMs: options.idleTimeoutMs,
          maxStdoutBytes: options.maxStdoutBytes,
          maxStderrBytes: options.maxStderrBytes,
          stdout: "",
          stderr: "",
          stdoutBytes: 0,
          stderrBytes: 0,
          idleTimer: null,
          settled: false,
        };
        worker.active = active;
        worker.stdoutLineBuffer = "";
        requestModel.set(options.requestId, model);
        armIdleTimer(model, worker, active);

        try {
          worker.child.stdin.write(`${JSON.stringify({ requestId: options.requestId, payload: options.payload })}\n`);
        } catch (err) {
          settleActive(model, worker, {
            ok: false,
            error: new Error(`Failed to send request to Python bridge worker: ${err instanceof Error ? err.message : String(err)}`),
          });
          killWorker(model, worker);
        }
      });
    },

    cancel(requestId) {
      const model = requestModel.get(requestId);
      if (model === undefined) return false;
      const worker = workers.get(model);
      if (!worker || worker.active?.requestId !== requestId) return false;
      cancelledRequests.add(requestId);
      // The exit handler rejects the in-flight request with "Generation cancelled."
      killWorker(model, worker);
      return true;
    },

    shutdown(model) {
      const worker = workers.get(model);
      if (worker) killWorker(model, worker);
    },

    shutdownAll() {
      for (const [model, worker] of [...workers.entries()]) {
        killWorker(model, worker);
      }
      requestModel.clear();
      cancelledRequests.clear();
    },

    isRunning(requestId) {
      const model = requestModel.get(requestId);
      if (model === undefined) return false;
      return workers.get(model)?.active?.requestId === requestId;
    },
  };
}
