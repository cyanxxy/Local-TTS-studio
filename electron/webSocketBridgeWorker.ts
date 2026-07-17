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
  command?: "warm";
  spawnConfig: WebSocketWorkerSpawnConfig;
  idleTimeoutMs: number;
  /** Maximum interval without a WebSocket protocol frame. Child heartbeat
   * output does not extend this deadline. */
  progressTimeoutMs?: number;
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
  textUnitIndex?: number;
  textUnitTotal?: number;
  audio: ArrayBuffer;
}

export interface CreateWebSocketBridgeWorkerPoolOptions<TModel extends string> {
  spawn: WebSocketWorkerSpawn<TModel>;
  idleEvictMs: number | ((model: TModel) => number);
  killGraceMs?: number;
  connectTimeoutMs?: number;
  host?: string;
  maxRequestAudioBytes?: number;
  maxRequestTextBytes?: number;
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
  progressTimeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  pendingAudioChunk: PendingAudioChunkMetadata | null;
  audioChunkTotal: number | null;
  audioSampleRate: number | null;
  receivedAudioChunkIndexes: Set<number>;
  receivedAudioOutputSamples: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  progressTimer: ReturnType<typeof setTimeout> | null;
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
const BRIDGE_RESULT_PREFIX = "__RESULT__";
const WEBSOCKET_TARGET_LABEL = "Rust local bridge WebSocket";
const MAX_PORT_ANNOUNCEMENT_BUFFER_BYTES = 64 * 1024;
const MAX_STARTUP_ERROR_CHARS = 2_000;

// Mirror the Rust protocol ceiling so one binary frame is at most 1 MiB of
// Float32 data. Inter-unit silence is currently 0.2 seconds; one second at the
// highest accepted rate leaves ample headroom without permitting a large
// renderer-side allocation from metadata alone.
const MAX_AUDIO_CHUNK_SAMPLES = 262_144;
const MAX_AUDIO_SILENCE_SAMPLES = 192_000;
const MAX_REQUEST_AUDIO_CHUNKS = 10_000;
const DEFAULT_MAX_REQUEST_AUDIO_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_REQUEST_TEXT_BYTES = 64 * 1024 * 1024;
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

function isOpen(socket: WebSocket | null): socket is WebSocket {
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
      finish(new Error(`Timed out connecting to ${WEBSOCKET_TARGET_LABEL}.`));
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
    const handleError = () => finish(new Error(`Failed connecting to ${WEBSOCKET_TARGET_LABEL}.`));
    const handleClose = () => finish(new Error(`${WEBSOCKET_TARGET_LABEL} closed before connecting.`));

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
      ? `Timed out connecting to ${WEBSOCKET_TARGET_LABEL}.`
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

function parseStartupFailure(line: string): Error | null {
  if (!line.startsWith(BRIDGE_RESULT_PREFIX)) return null;
  try {
    const parsed = JSON.parse(line.slice(BRIDGE_RESULT_PREFIX.length));
    if (!isRecord(parsed) || parsed.ok !== false || typeof parsed.error !== "string") {
      return new Error("Rust local bridge returned an invalid startup result.");
    }
    const message = [...parsed.error]
      .map((character) => {
        const code = character.charCodeAt(0);
        return code <= 0x1F || code === 0x7F ? " " : character;
      })
      .join("")
      .trim()
      .slice(0, MAX_STARTUP_ERROR_CHARS);
    return new Error(message || "Rust local bridge reported a startup failure.");
  } catch {
    return new Error("Rust local bridge returned an invalid startup result.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pcm16ToFloat32Buffer(pcm: ArrayBuffer): ArrayBuffer {
  const source = new Int16Array(pcm);
  const target = new Float32Array(source.length);
  for (let i = 0; i < source.length; i += 1) {
    target[i] = source[i] / 32768;
  }
  return target.buffer;
}

// Internal metadata for a chunk whose binary frame has not arrived yet. The
// bridge sends `encoding: "pcm16"` when the binary frame carries Int16 PCM
// (half the bytes of Float32); the worker converts before delivery so
// consumers always see Float32 audio.
type PendingAudioChunkMetadata = Omit<WebSocketAudioChunk, "audio"> & { pcm16: boolean };

function parseAudioChunkMetadata(parsed: Record<string, unknown>, requestId: string): PendingAudioChunkMetadata {
  const fields = ["index", "total", "sampleRate", "sampleCount", "silenceAfterSamples"] as const;
  for (const field of fields) {
    if (typeof parsed[field] !== "number" || !Number.isSafeInteger(parsed[field]) || parsed[field] < 0) {
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
  if (index >= MAX_REQUEST_AUDIO_CHUNKS || total > MAX_REQUEST_AUDIO_CHUNKS) {
    throw new Error("WebSocket bridge returned too many audio chunks.");
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
  if (parsed.encoding !== undefined && parsed.encoding !== "pcm16") {
    throw new Error("WebSocket bridge returned an audio chunk with an unsupported encoding.");
  }
  const hasTextUnitIndex = parsed.textUnitIndex !== undefined;
  const hasTextUnitTotal = parsed.textUnitTotal !== undefined;
  if (hasTextUnitIndex !== hasTextUnitTotal) {
    throw new Error("WebSocket bridge returned incomplete text-unit metadata.");
  }
  let textUnitMetadata: Pick<PendingAudioChunkMetadata, "textUnitIndex" | "textUnitTotal"> = {};
  if (hasTextUnitIndex && hasTextUnitTotal) {
    const textUnitIndex = Number(parsed.textUnitIndex);
    const textUnitTotal = Number(parsed.textUnitTotal);
    if (
      !Number.isSafeInteger(textUnitIndex)
      || !Number.isSafeInteger(textUnitTotal)
      || textUnitIndex < 0
      || textUnitTotal <= 0
      || textUnitIndex >= textUnitTotal
      || textUnitTotal > MAX_REQUEST_AUDIO_CHUNKS
    ) {
      throw new Error("WebSocket bridge returned invalid text-unit metadata.");
    }
    textUnitMetadata = { textUnitIndex, textUnitTotal };
  }
  return {
    requestId,
    index,
    total,
    sampleRate,
    sampleCount,
    silenceAfterSamples,
    ...textUnitMetadata,
    pcm16: parsed.encoding === "pcm16",
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
    || !Number.isSafeInteger(audioChunkCount)
    || audioChunkCount <= 0
  ) {
    throw new Error("WebSocket bridge returned a successful result with an invalid audio chunk count.");
  }
  const sampleRate = parsed.result.sampleRate;
  if (
    typeof sampleRate !== "number"
    || !Number.isSafeInteger(sampleRate)
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
  maxRequestAudioBytes = DEFAULT_MAX_REQUEST_AUDIO_BYTES,
  maxRequestTextBytes = DEFAULT_MAX_REQUEST_TEXT_BYTES,
}: CreateWebSocketBridgeWorkerPoolOptions<TModel>): WebSocketBridgeWorkerPool<TModel> {
  const maxRequestAudioSamples = Math.floor(maxRequestAudioBytes / Float32Array.BYTES_PER_ELEMENT);
  if (!Number.isSafeInteger(maxRequestAudioSamples) || maxRequestAudioSamples <= 0) {
    throw new Error("WebSocket bridge audio limit must allow at least one Float32 sample.");
  }
  if (!Number.isSafeInteger(maxRequestTextBytes) || maxRequestTextBytes <= 0) {
    throw new Error("WebSocket bridge text limit must be a positive safe integer.");
  }
  const workers = new Map<TModel, Worker>();
  const requestModel = new Map<string, TModel>();
  const cancelledRequests = new Set<string>();
  const startingModels = new Set<TModel>();
  const idleEvictionDelay = (model: TModel): number => (
    typeof idleEvictMs === "function" ? idleEvictMs(model) : idleEvictMs
  );

  function clearActiveTimers(active: ActiveRequest): void {
    if (active.idleTimer) {
      clearTimeout(active.idleTimer);
      active.idleTimer = null;
    }
    if (active.progressTimer) {
      clearTimeout(active.progressTimer);
      active.progressTimer = null;
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
    if (active.idleTimer) clearTimeout(active.idleTimer);
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

  function armProgressTimer(
    model: TModel,
    worker: Worker,
    active: ActiveRequest,
    progressTimeoutMs: number,
  ): void {
    if (active.progressTimer) clearTimeout(active.progressTimer);
    active.progressTimer = setTimeout(() => {
      const cancelled = cancelledRequests.has(active.requestId);
      settleActive(model, worker, {
        ok: false,
        error: new Error(
          cancelled
            ? "Generation cancelled."
            : `Rust local bridge produced no protocol progress for ${progressTimeoutMs / 1000}s and was stopped.`,
        ),
      });
      killWorker(model, worker);
    }, progressTimeoutMs);
    active.progressTimer.unref?.();
  }

  function settleActive(
    model: TModel,
    worker: Worker,
    outcome: { ok: true; response: unknown } | { ok: false; error: Error },
  ): void {
    const active = worker.active;
    if (!active || active.settled) return;
    active.settled = true;
    clearActiveTimers(active);
    worker.active = null;
    requestModel.delete(active.requestId);
    cancelledRequests.delete(active.requestId);

    if (outcome.ok) {
      active.resolve({ response: outcome.response, stdout: active.stdout, stderr: active.stderr });
    } else {
      active.reject(outcome.error);
    }
    if (worker.alive && isOpen(worker.socket)) {
      if (worker.evictTimer) clearTimeout(worker.evictTimer);
      worker.evictTimer = setTimeout(() => killWorker(model, worker), idleEvictionDelay(model));
      worker.evictTimer.unref?.();
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
    if (cancelledRequests.has(active.requestId)) {
      settleActive(model, worker, {
        ok: false,
        error: new Error("Generation cancelled."),
      });
      killWorker(model, worker);
      return;
    }
    armIdleTimer(model, worker, active);
    armProgressTimer(
      model,
      worker,
      active,
      Math.max(active.idleTimeoutMs, active.progressTimeoutMs),
    );

    const binaryData = dataToArrayBuffer(data);
    if (binaryData) {
      if (!active.expectAudio) {
        settleActive(model, worker, {
          ok: false,
          error: new Error("WebSocket bridge returned unexpected audio for a command request."),
        });
        killWorker(model, worker);
        return;
      }
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
      const bytesPerSample = metadata.pcm16 ? Int16Array.BYTES_PER_ELEMENT : Float32Array.BYTES_PER_ELEMENT;
      if (binaryData.byteLength !== metadata.sampleCount * bytesPerSample) {
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
      active.receivedAudioOutputSamples += metadata.sampleCount + metadata.silenceAfterSamples;
      const { pcm16, ...chunkMetadata } = metadata;
      const audio = pcm16 ? pcm16ToFloat32Buffer(binaryData) : binaryData;
      try {
        active.onAudioChunk({ ...chunkMetadata, audio });
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
        if (!active.expectAudio) {
          throw new Error("WebSocket bridge returned unexpected audio for a command request.");
        }
        if (active.pendingAudioChunk) {
          throw new Error("WebSocket bridge returned audio chunk metadata before the pending binary frame.");
        }
        const metadata = parseAudioChunkMetadata(parsed, active.requestId);
        if (
          metadata.sampleCount + metadata.silenceAfterSamples
          > maxRequestAudioSamples - active.receivedAudioOutputSamples
        ) {
          throw new Error(
            `WebSocket bridge audio exceeded the ${maxRequestAudioBytes}-byte request limit.`,
          );
        }
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
      if (parsed.ok === false) {
        if (typeof parsed.error !== "string" || !parsed.error.trim()) {
          settleActive(model, worker, {
            ok: false,
            error: new Error("WebSocket bridge returned a malformed failure envelope."),
          });
          killWorker(model, worker);
          return;
        }
        settleActive(model, worker, { ok: false, error: new Error(parsed.error) });
        return;
      }
      if (parsed.ok !== true || !isRecord(parsed.result)) {
        settleActive(model, worker, {
          ok: false,
          error: new Error("WebSocket bridge returned a malformed result envelope."),
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
          const line = rawLine.trim();
          const startupFailure = parseStartupFailure(line);
          if (startupFailure) {
            rejectPortIfPending(startupFailure);
            return;
          }
          const port = parsePortAnnouncement(line);
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
      if (Buffer.byteLength(stdoutLineBuffer, "utf-8") > MAX_PORT_ANNOUNCEMENT_BUFFER_BYTES) {
        rejectPortIfPending(new Error(
          `Rust local bridge startup output exceeded ${MAX_PORT_ANNOUNCEMENT_BUFFER_BYTES} bytes before announcing its WebSocket port.`,
        ));
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
    child.on("close", (code, signal) => {
      const status = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      rejectPortIfPending(new Error(
        `Rust local bridge exited before announcing its WebSocket port (${status}).`,
      ));
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
    if (!isOpen(socket)) {
      // The socket closed between connect resolving and listeners attaching;
      // fail fast instead of letting a later send() on CLOSED silently drop.
      disposeWorker(model, worker);
      hardKill(child);
      throw new Error("Rust local bridge connection closed during startup.");
    }
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
          progressTimeoutMs: Math.max(
            options.idleTimeoutMs,
            options.progressTimeoutMs ?? options.idleTimeoutMs * 15,
          ),
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
          receivedAudioOutputSamples: 0,
          idleTimer: null,
          progressTimer: null,
          settled: false,
        };
        worker.active = active;
        // Cancellation is registered before worker acquisition. Re-check only
        // after publishing `worker.active` so a cancel that lands at the
        // acquisition/activation boundary always settles this promise as a
        // cancellation and never falls through to a transport-send error.
        if (cancelledRequests.has(options.requestId)) {
          settleActive(model, worker, {
            ok: false,
            error: new Error("Generation cancelled."),
          });
          killWorker(model, worker);
          return;
        }
        armIdleTimer(model, worker, active);
        armProgressTimer(
          model,
          worker,
          active,
          active.progressTimeoutMs,
        );

        try {
          if (!isOpen(worker.socket)) {
            throw new Error("worker socket is not connected");
          }
          const requestBody = JSON.stringify({
            requestId: options.requestId,
            ...(options.command != null ? { command: options.command } : {}),
            payload: options.payload,
          });
          if (Buffer.byteLength(requestBody, "utf-8") > maxRequestTextBytes) {
            throw new Error(`request exceeds the ${maxRequestTextBytes}-byte WebSocket text limit`);
          }
          worker.socket.send(requestBody);
        } catch (err) {
          const cancelled = cancelledRequests.has(options.requestId) || active.settled;
          settleActive(model, worker, {
            ok: false,
            error: new Error(
              cancelled
                ? "Generation cancelled."
                : `Failed to send request to Rust local bridge: ${err instanceof Error ? err.message : String(err)}`,
            ),
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
      if (worker.active) {
        settleActive(model, worker, {
          ok: false,
          error: new Error("Generation cancelled."),
        });
      }
      killWorker(model, worker);
      return true;
    },

    shutdown(model) {
      const worker = workers.get(model);
      if (!worker) return Promise.resolve(false);
      // shutdown(model) backs cache clearing as well as explicit teardown. Any
      // request already assigned to that model is deliberately cancelled, not
      // a startup failure or an unexplained bridge crash.
      for (const [requestId, requestModelName] of requestModel) {
        if (requestModelName === model) cancelledRequests.add(requestId);
      }
      return killWorkerAndWait(model, worker).then(() => true);
    },

    async shutdownAll() {
      // Mark every in-flight request cancelled before killing so a slow worker
      // that settles after the bounded wait (via handleWorkerExit) reports the
      // deliberate shutdown as a cancellation rather than a crash. The settle
      // paths delete each request's entries themselves, so no unconditional
      // clear here — that would erase the state a late settlement consults.
      for (const requestId of requestModel.keys()) {
        cancelledRequests.add(requestId);
      }
      await Promise.all([...workers.entries()].map(([model, worker]) => killWorkerAndWait(model, worker)));
      startingModels.clear();
    },

    isRunning(requestId) {
      const model = requestModel.get(requestId);
      if (model === undefined) return false;
      return workers.get(model)?.active?.requestId === requestId;
    },
  };
}
