import type { ChildProcessWithoutNullStreams } from "child_process";
import { randomBytes } from "crypto";

export interface WebSocketWorkerSpawnConfig {
  bridgeBinary: string;
  cacheDir: string;
  env: NodeJS.ProcessEnv;
}

export interface WebSocketWorkerSpawnRuntimeConfig extends WebSocketWorkerSpawnConfig {
  authToken: string;
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
  /** Optional bridge command (e.g. "warm"). Command requests return a result
   * frame without streamed audio, so audio-count validation is skipped. */
  command?: string;
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
  shutdown: (model: TModel) => Promise<boolean>;
  shutdownAll: () => Promise<void>;
  isRunning: (requestId: string) => boolean;
}

interface ActiveRequest {
  requestId: string;
  expectAudio: boolean;
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
  audioChunkTotal: number | null;
  audioSampleRate: number | null;
  receivedAudioChunkIndexes: Set<number>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

interface Worker {
  child: ChildProcessWithoutNullStreams;
  // Null while the worker is still spawning (port wait + WebSocket connect).
  socket: WebSocket | null;
  spawnKey: string;
  active: ActiveRequest | null;
  evictTimer: ReturnType<typeof setTimeout> | null;
  alive: boolean;
  exitPromise: Promise<void>;
  resolveExit: () => void;
}

const BRIDGE_PORT_PREFIX = "__PORT__";

// Defensive ceiling on a single audio chunk's declared sample count. The
// binary-frame handler accepts exactly `sampleCount * 4` bytes, so without a
// cap a misbehaving bridge could dictate an unbounded (multi-GB) allocation
// from one metadata field. The bridge streams audio in chunks and ships
// 24kHz/44.1kHz output, so 10 minutes at 48kHz per chunk cannot reject a
// legitimate frame.
const MAX_AUDIO_CHUNK_SAMPLES = 48_000 * 600;
const MAX_AUDIO_SILENCE_SAMPLES = 48_000 * 60;
const MIN_AUDIO_SAMPLE_RATE = 8_000;
const MAX_AUDIO_SAMPLE_RATE = 192_000;

// On the WebSocket path the bridge result and audio travel over the socket, so
// the child's stdout/stderr are diagnostic-only and never read for the result.
// Retain just a bounded tail (the over-limit byte counters still enforce the
// hard cap) so a chatty/long generation can't hold tens of MB of dead string.
const RETAINED_OUTPUT_TAIL_CHARS = 64 * 1024;

function appendBoundedTail(existing: string, text: string): string {
  const combined = existing + text;
  return combined.length > RETAINED_OUTPUT_TAIL_CHARS
    ? combined.slice(combined.length - RETAINED_OUTPUT_TAIL_CHARS)
    : combined;
}

function spawnKeyOf(config: WebSocketWorkerSpawnConfig): string {
  const envPairs = Object.entries(config.env ?? {})
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([
    config.bridgeBinary,
    config.cacheDir,
    envPairs,
  ]);
}

function isOpen(socket: WebSocket | null): boolean {
  return socket !== null && socket.readyState === WebSocket.OPEN;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
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

  if (lastError) throw lastError;
  throw new Error(
    isWorkerAlive()
      ? `Timed out connecting to ${url}.`
      : "Rust local bridge process exited during startup.",
  );
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

function parsePortAnnouncement(line: string): number | null {
  if (!line.startsWith(BRIDGE_PORT_PREFIX)) return null;
  const port = Number(line.slice(BRIDGE_PORT_PREFIX.length).trim());
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("Rust local bridge announced an invalid WebSocket port.");
  }
  return port;
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
  const index = Number(parsed.index);
  const total = Number(parsed.total);
  const sampleRate = Number(parsed.sampleRate);
  const sampleCount = Number(parsed.sampleCount);
  const silenceAfterSamples = Number(parsed.silenceAfterSamples);
  if (total < 0) {
    throw new Error("WebSocket bridge returned an audio chunk with an invalid total.");
  }
  if (total > 0 && index >= total) {
    throw new Error("WebSocket bridge returned an audio chunk index outside the declared total.");
  }
  if (
    sampleRate < MIN_AUDIO_SAMPLE_RATE
    || sampleRate > MAX_AUDIO_SAMPLE_RATE
    || sampleCount <= 0
  ) {
    throw new Error("WebSocket bridge returned an audio chunk with invalid sample metadata.");
  }
  if (sampleCount > MAX_AUDIO_CHUNK_SAMPLES) {
    throw new Error("WebSocket bridge returned an audio chunk exceeding the maximum sample count.");
  }
  if (silenceAfterSamples > MAX_AUDIO_SILENCE_SAMPLES) {
    throw new Error("WebSocket bridge returned an audio chunk with excessive trailing silence.");
  }
  return {
    requestId,
    index,
    total,
    sampleRate,
    sampleCount,
    silenceAfterSamples,
  };
}

function parseResultAudioMetadata(parsed: Record<string, unknown>): { audioChunkCount: number; sampleRate: number } | null {
  if (parsed.ok !== true) return null;
  if (!isRecord(parsed.result)) {
    throw new Error("WebSocket bridge returned a successful result without a result object.");
  }
  const audioChunkCount = parsed.result.audioChunkCount;
  if (
    typeof audioChunkCount !== "number"
    || !Number.isInteger(audioChunkCount)
    || audioChunkCount <= 0
  ) {
    throw new Error("WebSocket bridge returned a successful result with an invalid audio chunk count.");
  }
  const sampleRate = parsed.result.sampleRate;
  if (
    typeof sampleRate !== "number"
    || !Number.isInteger(sampleRate)
    || sampleRate < MIN_AUDIO_SAMPLE_RATE
    || sampleRate > MAX_AUDIO_SAMPLE_RATE
  ) {
    throw new Error("WebSocket bridge returned a successful result with an invalid sample rate.");
  }
  return { audioChunkCount, sampleRate };
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
    try {
      if (isOpen(worker.socket)) {
        worker.socket.send(JSON.stringify({ command: "shutdown" }));
      }
    } catch {
      // Best-effort graceful shutdown before hard kill.
    }
    disposeWorker(model, worker);
    try {
      worker.socket?.close();
    } catch {
      // Socket may already be closed.
    }
    hardKill(worker.child);
  }

  async function killWorkerAndWait(model: TModel, worker: Worker): Promise<void> {
    killWorker(model, worker);
    await Promise.race([
      worker.exitPromise,
      delay(killGraceMs + 500),
    ]);
  }

  function armIdleTimer(model: TModel, worker: Worker, active: ActiveRequest): void {
    clearActiveIdleTimer(active);
    active.idleTimer = setTimeout(() => {
      // A cancel can land in the same tick the deadline elapses (cancel records
      // the id but settlement comes from the async exit/close). Mirror the
      // other terminal paths so a deliberate Stop is reported as a cancellation
      // rather than a misleading "process may be stuck" error.
      const cancelled = cancelledRequests.has(active.requestId);
      settleActive(model, worker, {
        ok: false,
        error: new Error(
          cancelled
            ? "Generation cancelled."
            : `Rust local bridge produced no output for ${active.idleTimeoutMs / 1000}s and was stopped (the process may be stuck).`,
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
          error: new Error(`Rust local bridge stdout exceeded ${active.maxStdoutBytes} bytes.`),
        });
        killWorker(model, worker);
        return;
      }
      active.stdout = appendBoundedTail(active.stdout, text);
    } else {
      active.stderrBytes += bytes;
      if (active.stderrBytes > active.maxStderrBytes) {
        settleActive(model, worker, {
          ok: false,
          error: new Error(`Rust local bridge stderr exceeded ${active.maxStderrBytes} bytes.`),
        });
        killWorker(model, worker);
        return;
      }
      active.stderr = appendBoundedTail(active.stderr, text);
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
      if (metadata.total > 0) {
        active.audioChunkTotal = metadata.total;
      }
      active.receivedAudioChunkIndexes.add(metadata.index);
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

    if (typeof parsed.requestId !== "string") {
      settleActive(model, worker, {
        ok: false,
        error: new Error("WebSocket bridge returned a request-scoped message without a request id."),
      });
      killWorker(model, worker);
      return;
    }

    if (parsed.requestId !== active.requestId) {
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
        if (active.pendingAudioChunk) {
          throw new Error("WebSocket bridge returned audio chunk metadata before the pending binary frame.");
        }
        const metadata = parseAudioChunkMetadata(parsed, active.requestId);
        if (active.audioChunkTotal != null && metadata.total > 0 && metadata.total !== active.audioChunkTotal) {
          throw new Error("WebSocket bridge changed the audio chunk total mid-stream.");
        }
        if (active.receivedAudioChunkIndexes.has(metadata.index)) {
          throw new Error("WebSocket bridge returned a duplicate audio chunk index.");
        }
        if (metadata.index !== active.receivedAudioChunkIndexes.size) {
          throw new Error("WebSocket bridge returned audio chunks out of sequence.");
        }
        if (active.audioSampleRate == null) {
          active.audioSampleRate = metadata.sampleRate;
        } else if (metadata.sampleRate !== active.audioSampleRate) {
          throw new Error("WebSocket bridge changed the audio sample rate mid-stream.");
        }
        if (metadata.total > 0) {
          active.audioChunkTotal = metadata.total;
        }
        active.pendingAudioChunk = metadata;
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
      try {
        const expectedAudioMetadata = active.expectAudio ? parseResultAudioMetadata(parsed) : null;
        if (expectedAudioMetadata != null) {
          const receivedAudioChunkCount = active.receivedAudioChunkIndexes.size;
          if (
            expectedAudioMetadata.audioChunkCount !== receivedAudioChunkCount
            || (active.audioChunkTotal != null && expectedAudioMetadata.audioChunkCount !== active.audioChunkTotal)
          ) {
            settleActive(model, worker, {
              ok: false,
              error: new Error("WebSocket bridge result did not match the streamed audio chunk count."),
            });
            killWorker(model, worker);
            return;
          }
          if (active.audioSampleRate != null && expectedAudioMetadata.sampleRate !== active.audioSampleRate) {
            settleActive(model, worker, {
              ok: false,
              error: new Error("WebSocket bridge result did not match the streamed audio sample rate."),
            });
            killWorker(model, worker);
            return;
          }
        }
      } catch (err) {
        settleActive(model, worker, {
          ok: false,
          error: err instanceof Error ? err : new Error(String(err)),
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
        error: new Error(typeof parsed.error === "string" ? parsed.error : "Rust local bridge failed."),
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
    worker.resolveExit();
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
            ? "Rust local bridge exited before returning a result."
            : "Rust local bridge is no longer available.",
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
    const authToken = randomBytes(32).toString("hex");
    const child = spawn(model, { ...spawnConfig, authToken, host, port: 0 });
    let resolveExit!: () => void;
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const worker: Worker = {
      child,
      socket: null,
      spawnKey: spawnKeyOf(spawnConfig),
      active: null,
      evictTimer: null,
      alive: true,
      exitPromise,
      resolveExit,
    };
    // Register the worker before the (potentially long) port wait + WebSocket
    // connect so shutdown/shutdownAll/cancel can kill a mid-spawn child instead
    // of leaking it.
    workers.set(model, worker);
    let stdoutLineBuffer = "";
    let portSettled = false;
    let resolvePort!: (port: number) => void;
    let rejectPort!: (error: Error) => void;
    const announcedPort = new Promise<number>((resolve, reject) => {
      resolvePort = resolve;
      rejectPort = reject;
    });
    const portTimeout = setTimeout(() => {
      if (portSettled) return;
      portSettled = true;
      rejectPort(new Error("Timed out waiting for Rust local bridge WebSocket port."));
    }, connectTimeoutMs);
    portTimeout.unref?.();

    const rejectPortIfPending = (error: Error) => {
      if (portSettled) return;
      portSettled = true;
      clearTimeout(portTimeout);
      rejectPort(error);
    };

    const handlePortStdout = (chunk: Buffer) => {
      if (portSettled) return;
      stdoutLineBuffer += chunk.toString("utf-8");
      const lines = stdoutLineBuffer.split(/\r?\n/);
      stdoutLineBuffer = lines.pop() ?? "";
      for (const rawLine of lines) {
        try {
          const port = parsePortAnnouncement(rawLine.trim());
          if (port === null) continue;
          portSettled = true;
          clearTimeout(portTimeout);
          resolvePort(port);
          return;
        } catch (error) {
          rejectPortIfPending(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      handlePortStdout(chunk);
      handleChildOutput(model, worker, "stdout", chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => handleChildOutput(model, worker, "stderr", chunk));
    child.on("error", (error) => {
      rejectPortIfPending(new Error(`Rust local bridge worker failed before startup: ${error.message}`));
      handleWorkerExit(model, worker);
    });
    child.on("close", () => {
      rejectPortIfPending(new Error("Rust local bridge exited before announcing its WebSocket port."));
      handleWorkerExit(model, worker);
    });
    child.on("exit", () => handleWorkerExit(model, worker));

    let socket: WebSocket;
    try {
      const port = await announcedPort;
      socket = await openWebSocketWithRetry(
        `ws://${host}:${port}/${authToken}`,
        connectTimeoutMs,
        () => worker.alive,
      );
      socket.binaryType = "arraybuffer";
      if (!worker.alive) {
        // Killed (cancel/shutdown) while the connection was being established.
        try {
          socket.close();
        } catch {
          // Socket may already be closed.
        }
        throw new Error("Rust local bridge process exited during startup.");
      }
    } catch (err) {
      disposeWorker(model, worker);
      hardKill(child);
      throw err;
    }

    worker.socket = socket;
    socket.addEventListener("message", (event) => handleWebSocketMessage(model, worker, event.data));
    socket.addEventListener("close", () => {
      handleTransportFailure(model, worker, "Rust local bridge closed before returning a result.");
    });
    socket.addEventListener("error", () => {
      handleTransportFailure(model, worker, "Rust local bridge connection failed.");
    });

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
      // Register the request before acquiring the worker so a cancel that
      // arrives during the (potentially long) spawn can find and kill it.
      requestModel.set(options.requestId, model);

      startingModels.add(model);
      let worker: Worker;
      try {
        worker = await acquireWorker(model, options.spawnConfig);
      } catch (err) {
        const cancelled = cancelledRequests.has(options.requestId);
        requestModel.delete(options.requestId);
        cancelledRequests.delete(options.requestId);
        if (cancelled) {
          throw new Error("Generation cancelled.");
        }
        throw new Error(`Failed to start Rust local bridge worker: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        startingModels.delete(model);
      }

      if (cancelledRequests.has(options.requestId)) {
        requestModel.delete(options.requestId);
        cancelledRequests.delete(options.requestId);
        killWorker(model, worker);
        throw new Error("Generation cancelled.");
      }

      if (worker.evictTimer) {
        clearTimeout(worker.evictTimer);
        worker.evictTimer = null;
      }

      return await new Promise<WebSocketWorkerRunResult>((resolve, reject) => {
        const active: ActiveRequest = {
          requestId: options.requestId,
          expectAudio: options.command == null,
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
          audioChunkTotal: null,
          audioSampleRate: null,
          receivedAudioChunkIndexes: new Set<number>(),
          idleTimer: null,
          settled: false,
        };
        worker.active = active;
        armIdleTimer(model, worker, active);

        try {
          if (!worker.socket) {
            throw new Error("worker socket is not connected");
          }
          worker.socket.send(JSON.stringify({
            requestId: options.requestId,
            ...(options.command != null ? { command: options.command } : {}),
            payload: options.payload,
          }));
        } catch (err) {
          settleActive(model, worker, {
            ok: false,
            error: new Error(`Failed to send request to Rust local bridge: ${err instanceof Error ? err.message : String(err)}`),
          });
          killWorker(model, worker);
        }
      });
    },

    cancel(requestId) {
      const model = requestModel.get(requestId);
      if (model === undefined) return false;
      const worker = workers.get(model);
      if (!worker) return false;
      // A worker with no active request is still spawning for this request
      // (run registers the request before acquiring the worker). Killing it
      // rejects the pending run with a cancellation error.
      if (worker.active && worker.active.requestId !== requestId) return false;
      cancelledRequests.add(requestId);
      killWorker(model, worker);
      return true;
    },

    shutdown(model) {
      const worker = workers.get(model);
      return worker ? killWorkerAndWait(model, worker).then(() => true) : Promise.resolve(false);
    },

    async shutdownAll() {
      await Promise.all([...workers.entries()].map(([model, worker]) => killWorkerAndWait(model, worker)));
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
