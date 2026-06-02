import type { ChildProcessWithoutNullStreams } from "child_process";
import net from "net";

export interface WebSocketWorkerSpawnConfig {
  pythonBinary: string;
  scriptPath: string;
  cacheDir: string;
  env: NodeJS.ProcessEnv;
}

export interface WebSocketWorkerSpawnRuntimeConfig extends WebSocketWorkerSpawnConfig {
  host: string;
  port: number;
}

export type WebSocketWorkerSpawn<TModel extends string> = (
  model: TModel,
  config: WebSocketWorkerSpawnRuntimeConfig,
) => ChildProcessWithoutNullStreams;

export interface WebSocketWorkerRunOptions {
  requestId: string;
  payload: Record<string, unknown>;
  spawnConfig: WebSocketWorkerSpawnConfig;
  idleTimeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  onProgress: (payload: unknown) => void;
  onAudioChunk: (payload: WebSocketAudioChunk) => void;
}

export interface WebSocketWorkerRunResult {
  response: unknown;
  stdout: string;
  stderr: string;
}

export interface WebSocketAudioChunk {
  requestId: string;
  index: number;
  total: number;
  sampleRate: number;
  sampleCount: number;
  silenceAfterSamples: number;
  audio: ArrayBuffer;
}

export interface CreateWebSocketBridgeWorkerPoolOptions<TModel extends string> {
  spawn: WebSocketWorkerSpawn<TModel>;
  idleEvictMs: number;
  killGraceMs?: number;
  connectTimeoutMs?: number;
  host?: string;
}

export interface WebSocketBridgeWorkerPool<TModel extends string> {
  run: (model: TModel, options: WebSocketWorkerRunOptions) => Promise<WebSocketWorkerRunResult>;
  cancel: (requestId: string) => boolean;
  shutdown: (model: TModel) => void;
  shutdownAll: () => void;
  isRunning: (requestId: string) => boolean;
}

interface ActiveRequest {
  requestId: string;
  resolve: (result: WebSocketWorkerRunResult) => void;
  reject: (error: Error) => void;
  onProgress: (payload: unknown) => void;
  onAudioChunk: (payload: WebSocketAudioChunk) => void;
  idleTimeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  pendingAudioChunk: Omit<WebSocketAudioChunk, "audio"> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

interface Worker {
  child: ChildProcessWithoutNullStreams;
  socket: WebSocket;
  spawnKey: string;
  active: ActiveRequest | null;
  evictTimer: ReturnType<typeof setTimeout> | null;
  alive: boolean;
}

function spawnKeyOf(config: WebSocketWorkerSpawnConfig): string {
  const envPairs = Object.entries(config.env ?? {})
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([config.pythonBinary, config.scriptPath, config.cacheDir, envPairs]);
}

function isOpen(socket: WebSocket): boolean {
  return socket.readyState === WebSocket.OPEN;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function findAvailablePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a local WebSocket port.")));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

function openWebSocketOnce(url: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new Error(`Timed out connecting to ${url}.`));
    }, timeoutMs);
    timeout.unref?.();

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("error", handleError);
      socket.removeEventListener("close", handleClose);
      if (error) {
        try {
          socket.close();
        } catch {
          // Ignore cleanup failures for a failed connection attempt.
        }
        reject(error);
      } else {
        resolve(socket);
      }
    };

    const handleOpen = () => finish();
    const handleError = () => finish(new Error(`Failed connecting to ${url}.`));
    const handleClose = () => finish(new Error(`WebSocket closed before connecting to ${url}.`));

    socket.addEventListener("open", handleOpen);
    socket.addEventListener("error", handleError);
    socket.addEventListener("close", handleClose);
  });
}

async function openWebSocketWithRetry(
  url: string,
  timeoutMs: number,
  isWorkerAlive: () => boolean,
): Promise<WebSocket> {
  const started = Date.now();
  let lastError: Error | null = null;

  while (Date.now() - started < timeoutMs && isWorkerAlive()) {
    try {
      return await openWebSocketOnce(url, Math.min(1_000, timeoutMs - (Date.now() - started)));
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      await delay(50);
    }
  }

  throw lastError ?? new Error(`Timed out connecting to ${url}.`);
}

function dataToText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf-8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf-8");
  }
  return String(data);
}

function dataToArrayBuffer(data: unknown): ArrayBuffer | null {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    const copy = new Uint8Array(data.byteLength);
    copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    return copy.buffer;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAudioChunkMetadata(parsed: Record<string, unknown>, requestId: string): Omit<WebSocketAudioChunk, "audio"> {
  const fields = ["index", "total", "sampleRate", "sampleCount", "silenceAfterSamples"] as const;
  for (const field of fields) {
    if (typeof parsed[field] !== "number" || !Number.isInteger(parsed[field]) || parsed[field] < 0) {
      throw new Error(`WebSocket bridge returned invalid audio chunk \`${field}\`.`);
    }
  }
  return {
    requestId,
    index: Number(parsed.index),
    total: Number(parsed.total),
    sampleRate: Number(parsed.sampleRate),
    sampleCount: Number(parsed.sampleCount),
    silenceAfterSamples: Number(parsed.silenceAfterSamples),
  };
}

export function createWebSocketBridgeWorkerPool<TModel extends string>({
  spawn,
  idleEvictMs,
  killGraceMs = 2_000,
  connectTimeoutMs = 20_000,
  host = "127.0.0.1",
}: CreateWebSocketBridgeWorkerPoolOptions<TModel>): WebSocketBridgeWorkerPool<TModel> {
  const workers = new Map<TModel, Worker>();
  const requestModel = new Map<string, TModel>();
  const cancelledRequests = new Set<string>();
  const startingModels = new Set<TModel>();

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
    try {
      worker.socket.close();
    } catch {
      // Socket may already be closed.
    }
    hardKill(worker.child);
  }

  function armIdleTimer(model: TModel, worker: Worker, active: ActiveRequest): void {
    clearActiveIdleTimer(active);
    active.idleTimer = setTimeout(() => {
      settleActive(model, worker, {
        ok: false,
        error: new Error(
          `Python WebSocket bridge produced no output for ${active.idleTimeoutMs / 1000}s and was stopped (the process may be stuck).`,
        ),
      });
      killWorker(model, worker);
    }, active.idleTimeoutMs);
    active.idleTimer.unref?.();
  }

  function settleActive(
    model: TModel,
    worker: Worker,
    outcome: { ok: true; response: unknown } | { ok: false; error: Error },
  ): void {
    const active = worker.active;
    if (!active || active.settled) return;
    active.settled = true;
    clearActiveIdleTimer(active);
    worker.active = null;
    requestModel.delete(active.requestId);
    cancelledRequests.delete(active.requestId);

    if (outcome.ok) {
      active.resolve({ response: outcome.response, stdout: active.stdout, stderr: active.stderr });
      if (worker.alive && isOpen(worker.socket)) {
        if (worker.evictTimer) clearTimeout(worker.evictTimer);
        worker.evictTimer = setTimeout(() => killWorker(model, worker), idleEvictMs);
        worker.evictTimer.unref?.();
      }
    } else {
      active.reject(outcome.error);
    }
  }

  function handleChildOutput(
    model: TModel,
    worker: Worker,
    stream: "stdout" | "stderr",
    chunk: Buffer | string,
  ): void {
    const active = worker.active;
    if (!active || active.settled) return;
    armIdleTimer(model, worker, active);

    const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    const bytes = Buffer.byteLength(text, "utf-8");
    if (stream === "stdout") {
      active.stdoutBytes += bytes;
      if (active.stdoutBytes > active.maxStdoutBytes) {
        settleActive(model, worker, {
          ok: false,
          error: new Error(`Python bridge stdout exceeded ${active.maxStdoutBytes} bytes.`),
        });
        killWorker(model, worker);
        return;
      }
      active.stdout += text;
    } else {
      active.stderrBytes += bytes;
      if (active.stderrBytes > active.maxStderrBytes) {
        settleActive(model, worker, {
          ok: false,
          error: new Error(`Python bridge stderr exceeded ${active.maxStderrBytes} bytes.`),
        });
        killWorker(model, worker);
        return;
      }
      active.stderr += text;
    }
  }

  function handleWebSocketMessage(model: TModel, worker: Worker, data: unknown): void {
    const active = worker.active;
    if (!active || active.settled) return;
    armIdleTimer(model, worker, active);

    const binaryData = dataToArrayBuffer(data);
    if (binaryData) {
      const metadata = active.pendingAudioChunk;
      active.pendingAudioChunk = null;
      if (!metadata) {
        settleActive(model, worker, {
          ok: false,
          error: new Error("WebSocket bridge returned an audio binary frame without metadata."),
        });
        killWorker(model, worker);
        return;
      }
      if (binaryData.byteLength !== metadata.sampleCount * Float32Array.BYTES_PER_ELEMENT) {
        settleActive(model, worker, {
          ok: false,
          error: new Error("WebSocket bridge returned an audio binary frame with an unexpected byte length."),
        });
        killWorker(model, worker);
        return;
      }
      try {
        active.onAudioChunk({ ...metadata, audio: binaryData });
      } catch {
        // An audio chunk consumer must never break request handling.
      }
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(dataToText(data));
    } catch (err) {
      settleActive(model, worker, {
        ok: false,
        error: new Error(`Failed parsing WebSocket bridge message: ${err instanceof Error ? err.message : String(err)}`),
      });
      killWorker(model, worker);
      return;
    }

    if (!isRecord(parsed) || typeof parsed.type !== "string") {
      settleActive(model, worker, {
        ok: false,
        error: new Error("WebSocket bridge returned an invalid message."),
      });
      killWorker(model, worker);
      return;
    }

    if (typeof parsed.requestId === "string" && parsed.requestId !== active.requestId) {
      settleActive(model, worker, {
        ok: false,
        error: new Error(`WebSocket bridge returned a message for unexpected request ${parsed.requestId}.`),
      });
      killWorker(model, worker);
      return;
    }

    if (parsed.type === "progress") {
      try {
        active.onProgress(parsed);
      } catch {
        // A progress consumer must never break request handling.
      }
      return;
    }

    if (parsed.type === "audio_chunk") {
      try {
        active.pendingAudioChunk = parseAudioChunkMetadata(parsed, active.requestId);
      } catch (err) {
        settleActive(model, worker, {
          ok: false,
          error: err instanceof Error ? err : new Error(String(err)),
        });
        killWorker(model, worker);
      }
      return;
    }

    if (parsed.type === "result") {
      if (active.pendingAudioChunk) {
        settleActive(model, worker, {
          ok: false,
          error: new Error("WebSocket bridge returned a result before the pending audio binary frame."),
        });
        killWorker(model, worker);
        return;
      }
      settleActive(model, worker, { ok: true, response: parsed });
      return;
    }

    if (parsed.type === "error") {
      settleActive(model, worker, {
        ok: false,
        error: new Error(typeof parsed.error === "string" ? parsed.error : "Python WebSocket bridge failed."),
      });
      killWorker(model, worker);
      return;
    }

    settleActive(model, worker, {
      ok: false,
      error: new Error(`WebSocket bridge returned unsupported message type: ${parsed.type}.`),
    });
    killWorker(model, worker);
  }

  function handleWorkerExit(model: TModel, worker: Worker): void {
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
            ? "Python WebSocket bridge exited before returning a result."
            : "Python WebSocket bridge is no longer available.",
      ),
    });
  }

  function handleTransportFailure(model: TModel, worker: Worker, reason: string): void {
    const wasAlive = worker.alive;
    disposeWorker(model, worker);
    const active = worker.active;
    if (active && !active.settled) {
      const cancelled = cancelledRequests.has(active.requestId);
      settleActive(model, worker, {
        ok: false,
        error: new Error(cancelled ? "Generation cancelled." : reason),
      });
    }
    if (wasAlive) {
      hardKill(worker.child);
    }
  }

  async function spawnWorker(model: TModel, spawnConfig: WebSocketWorkerSpawnConfig): Promise<Worker> {
    const port = await findAvailablePort(host);
    const child = spawn(model, { ...spawnConfig, host, port });
    const worker = {
      child,
      socket: null as unknown as WebSocket,
      spawnKey: spawnKeyOf(spawnConfig),
      active: null,
      evictTimer: null,
      alive: true,
    };

    child.stdout.on("data", (chunk: Buffer) => handleChildOutput(model, worker, "stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => handleChildOutput(model, worker, "stderr", chunk));
    child.on("error", () => handleWorkerExit(model, worker));
    child.on("close", () => handleWorkerExit(model, worker));
    child.on("exit", () => handleWorkerExit(model, worker));

    try {
      worker.socket = await openWebSocketWithRetry(
        `ws://${host}:${port}`,
        connectTimeoutMs,
        () => worker.alive,
      );
      worker.socket.binaryType = "arraybuffer";
    } catch (err) {
      hardKill(child);
      throw err;
    }

    worker.socket.addEventListener("message", (event) => handleWebSocketMessage(model, worker, event.data));
    worker.socket.addEventListener("close", () => {
      handleTransportFailure(model, worker, "Python WebSocket bridge closed before returning a result.");
    });
    worker.socket.addEventListener("error", () => {
      handleTransportFailure(model, worker, "Python WebSocket bridge connection failed.");
    });

    workers.set(model, worker);
    return worker;
  }

  async function acquireWorker(model: TModel, spawnConfig: WebSocketWorkerSpawnConfig): Promise<Worker> {
    const existing = workers.get(model);
    const wantedKey = spawnKeyOf(spawnConfig);
    if (existing && existing.alive && existing.spawnKey === wantedKey && isOpen(existing.socket)) {
      return existing;
    }
    if (existing) killWorker(model, existing);
    return spawnWorker(model, spawnConfig);
  }

  return {
    async run(model, options) {
      const existing = workers.get(model);
      if (existing?.active || startingModels.has(model)) {
        throw new Error(`A ${model} generation is already running.`);
      }
      if (requestModel.has(options.requestId)) {
        throw new Error(`A request with id ${options.requestId} is already running.`);
      }

      startingModels.add(model);
      let worker: Worker;
      try {
        worker = await acquireWorker(model, options.spawnConfig);
      } catch (err) {
        throw new Error(`Failed to start Python WebSocket bridge worker: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        startingModels.delete(model);
      }

      if (worker.evictTimer) {
        clearTimeout(worker.evictTimer);
        worker.evictTimer = null;
      }

      return await new Promise<WebSocketWorkerRunResult>((resolve, reject) => {
        const active: ActiveRequest = {
          requestId: options.requestId,
          resolve,
          reject,
          onProgress: options.onProgress,
          onAudioChunk: options.onAudioChunk,
          idleTimeoutMs: options.idleTimeoutMs,
          maxStdoutBytes: options.maxStdoutBytes,
          maxStderrBytes: options.maxStderrBytes,
          stdout: "",
          stderr: "",
          stdoutBytes: 0,
          stderrBytes: 0,
          pendingAudioChunk: null,
          idleTimer: null,
          settled: false,
        };
        worker.active = active;
        requestModel.set(options.requestId, model);
        armIdleTimer(model, worker, active);

        try {
          worker.socket.send(JSON.stringify({ requestId: options.requestId, payload: options.payload }));
        } catch (err) {
          settleActive(model, worker, {
            ok: false,
            error: new Error(`Failed to send request to Python WebSocket bridge: ${err instanceof Error ? err.message : String(err)}`),
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
      startingModels.clear();
    },

    isRunning(requestId) {
      const model = requestModel.get(requestId);
      if (model === undefined) return false;
      return workers.get(model)?.active?.requestId === requestId;
    },
  };
}
