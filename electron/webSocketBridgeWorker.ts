import type { ChildProcessWithoutNullStreams } from "child_process";
import { randomBytes } from "crypto";
import {
  errorMessage,
  generationCancelledError,
  LOCAL_RUNTIME_SHUTTING_DOWN_MESSAGE,
  nativeFailureDiagnostics,
  NativeRuntimeError,
} from "./errors";
import { isRecord } from "./guards";
import { AudioStreamValidator } from "./wsBridge/audioStreamValidator";
import { BridgeProcess, type BridgeOutputStream } from "./wsBridge/bridgeProcess";
import {
  closeQuietly,
  delay,
  isOpen,
  openWebSocketWithRetry,
} from "./wsBridge/connection";
import {
  dataToArrayBuffer,
  DEFAULT_MAX_REQUEST_AUDIO_BYTES,
  DEFAULT_MAX_REQUEST_TEXT_BYTES,
  encodeCancel,
  encodeRequest,
  isTerminalResultFor,
  parseBridgeMessage,
  SHUTDOWN_COMMAND,
  UNIT_GAP_MESSAGE_TYPE,
  type BridgeCommand,
  type BridgeMessage,
  type WebSocketAudioChunk,
  type WebSocketUnitGap,
} from "./wsBridge/protocol";
import { RequestWatchdog } from "./wsBridge/requestWatchdog";

export type { WebSocketAudioChunk, WebSocketUnitGap } from "./wsBridge/protocol";

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
  command?: BridgeCommand;
  spawnConfig: WebSocketWorkerSpawnConfig;
  idleTimeoutMs: number;
  /** Maximum interval without a WebSocket protocol frame. Child heartbeat
   * output does not extend this deadline. */
  progressTimeoutMs?: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  onProgress: (payload: unknown) => void;
  onAudioChunk: (payload: WebSocketAudioChunk) => void;
  /** Told of the silence after a finished text unit, in stream order with the chunks. */
  onAudioGap?: (payload: WebSocketUnitGap) => void;
  /**
   * Names what this request leaves loaded in the worker (for Qwen3, the model
   * folder). Once the request succeeds the worker is resident with this key,
   * and its idle eviction is timed by `idleEvictMs(model, residencyKey)`. Any
   * failure or cancellation leaves the worker without one.
   */
  residencyKey?: string;
}

export interface WebSocketWorkerRunResult {
  response: unknown;
}

/**
 * Why a worker that had connected went away: evicted after idling, stopped on
 * purpose (shutdown, a cache clear, a respawn with new settings), or failed (a
 * crash, a protocol violation, a deadline, a cancel the bridge never
 * acknowledged). Its loaded model is gone in every case.
 */
export type WorkerExitReason = "idle" | "stopped" | "failed";

export interface CreateWebSocketBridgeWorkerPoolOptions<TModel extends string> {
  spawn: WebSocketWorkerSpawn<TModel>;
  /** How long an idle worker stays resident, given what it has loaded. */
  idleEvictMs: number | ((model: TModel, residencyKey: string | null) => number);
  killGraceMs?: number;
  connectTimeoutMs?: number;
  host?: string;
  maxRequestAudioBytes?: number;
  maxRequestTextBytes?: number;
  cancelDrainMs?: number;
  /**
   * Told the first time a request's progress or audio listener throws. The
   * pool keeps serving the request either way: a consumer bug must never
   * break the transport.
   */
  onListenerError?: (error: unknown, details: { requestId: string; listener: "progress" | "audioChunk" | "audioGap" }) => void;
  /** Told once for every worker that had connected, when it goes away. */
  onWorkerExit?: (model: TModel, details: { reason: WorkerExitReason }) => void;
}

export interface WebSocketBridgeWorkerPool<TModel extends string> {
  run: (model: TModel, options: WebSocketWorkerRunOptions) => Promise<WebSocketWorkerRunResult>;
  cancel: (requestId: string) => boolean;
  shutdown: (model: TModel) => Promise<boolean>;
  shutdownAll: () => Promise<void>;
  isRunning: (requestId: string) => boolean;
  /**
   * Re-times `model`'s idle worker with whatever `idleEvictMs` returns now,
   * still counted from when the worker went idle: a change of window never
   * restarts the clock. A busy or draining worker is left alone: its clock
   * starts when it next goes idle.
   */
  refreshIdleEviction: (model: TModel) => void;
}

type StreamListener = "progress" | "audioChunk" | "audioGap";

interface ActiveRequest {
  requestId: string;
  residencyKey: string | null;
  resolve: (result: WebSocketWorkerRunResult) => void;
  reject: (error: Error) => void;
  onProgress: (payload: unknown) => void;
  onAudioChunk: (payload: WebSocketAudioChunk) => void;
  onAudioGap: ((payload: WebSocketUnitGap) => void) | null;
  idleTimeoutMs: number;
  progressTimeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  stdoutBytes: number;
  stderrBytes: number;
  stream: AudioStreamValidator;
  // Armed once the request is published on its worker.
  watchdog: RequestWatchdog | null;
  settled: boolean;
  // Set while a failure waits for the dead process's last output to drain.
  failing: boolean;
  reportedListenerErrors: Set<StreamListener>;
}

interface Worker {
  process: BridgeProcess;
  // Null while the worker is still spawning (port wait + WebSocket connect).
  socket: WebSocket | null;
  // Set once spawning finished: the worker is connected and can hold a model.
  ready: boolean;
  spawnKey: string;
  active: ActiveRequest | null;
  // Set between a cancel being sent and the bridge acknowledging it. The run
  // promise has already settled; the worker is finishing its unwind and is not
  // yet safe to hand a new request.
  draining: DrainState | null;
  evictTimer: ReturnType<typeof setTimeout> | null;
  // When the worker last went idle (Date.now()); its eviction is timed from here.
  idleSince: number;
  alive: boolean;
  // What the last successful request left loaded (see residencyKey).
  residencyKey: string | null;
}

interface DrainState {
  requestId: string;
  timer: ReturnType<typeof setTimeout> | null;
  promise: Promise<void>;
  resolve: () => void;
}

// How long the bridge gets to acknowledge a cancel and return to idle before
// the worker is killed instead. Cancellation is observed between text units, so
// this only needs to cover one unit of inference.
const DEFAULT_CANCEL_DRAIN_MS = 20_000;

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

export function createWebSocketBridgeWorkerPool<TModel extends string>({
  spawn,
  idleEvictMs,
  killGraceMs = 2_000,
  connectTimeoutMs = 20_000,
  host = "127.0.0.1",
  maxRequestAudioBytes = DEFAULT_MAX_REQUEST_AUDIO_BYTES,
  maxRequestTextBytes = DEFAULT_MAX_REQUEST_TEXT_BYTES,
  cancelDrainMs = DEFAULT_CANCEL_DRAIN_MS,
  onListenerError,
  onWorkerExit,
}: CreateWebSocketBridgeWorkerPoolOptions<TModel>): WebSocketBridgeWorkerPool<TModel> {
  const maxRequestAudioSamples = Math.floor(maxRequestAudioBytes / Float32Array.BYTES_PER_ELEMENT);
  if (!Number.isSafeInteger(maxRequestAudioSamples) || maxRequestAudioSamples <= 0) {
    throw new Error("WebSocket bridge audio limit must allow at least one Float32 sample.");
  }
  if (!Number.isSafeInteger(maxRequestTextBytes) || maxRequestTextBytes <= 0) {
    throw new Error("WebSocket bridge text limit must be a positive safe integer.");
  }
  const streamLimits = { maxRequestAudioSamples, maxRequestAudioBytes };
  const workers = new Map<TModel, Worker>();
  const requestModel = new Map<string, TModel>();
  const cancelledRequests = new Set<string>();
  const startingModels = new Set<TModel>();
  const stoppingModels = new Map<TModel, Promise<boolean>>();
  // Dead workers whose request is still collecting the process's last output
  // (see failActiveAfterOutput). The model stays busy until that settles.
  const failingWorkers = new Map<TModel, Worker>();
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;
  const idleEvictionDelay = (model: TModel, residencyKey: string | null): number => (
    typeof idleEvictMs === "function" ? idleEvictMs(model, residencyKey) : idleEvictMs
  );

  /** A deliberate stop wins over whatever failure raced it. */
  function cancelledOr(active: ActiveRequest, failure: () => Error): Error {
    return cancelledRequests.has(active.requestId) ? generationCancelledError() : failure();
  }

  function notifyWorkerExit(model: TModel, reason: WorkerExitReason): void {
    try {
      onWorkerExit?.(model, { reason });
    } catch {
      // An observer must not break teardown.
    }
  }

  function disposeWorker(model: TModel, worker: Worker, reason: WorkerExitReason): void {
    const wasResident = worker.alive && worker.ready;
    worker.alive = false;
    if (worker.evictTimer) {
      clearTimeout(worker.evictTimer);
      worker.evictTimer = null;
    }
    // A dying worker will never acknowledge its cancel; release anyone waiting
    // on the drain so acquireWorker cannot hang on a dead process.
    finishDrain(worker);
    if (workers.get(model) === worker) {
      workers.delete(model);
    }
    if (wasResident) notifyWorkerExit(model, reason);
  }

  // Starts the idle-eviction clock of a worker that has just gone idle, or
  // (`restart: false`) re-times the running one without moving its start, so
  // the window can change but never restarts without real activity.
  function armIdleEviction(model: TModel, worker: Worker, { restart = true }: { restart?: boolean } = {}): void {
    if (!worker.alive || !isOpen(worker.socket)) return;
    if (worker.evictTimer) clearTimeout(worker.evictTimer);
    if (restart) worker.idleSince = Date.now();
    const remaining = worker.idleSince + idleEvictionDelay(model, worker.residencyKey) - Date.now();
    worker.evictTimer = setTimeout(() => killWorker(model, worker, "idle"), Math.max(0, remaining));
    worker.evictTimer.unref?.();
  }

  function finishDrain(worker: Worker): void {
    const draining = worker.draining;
    if (!draining) return;
    if (draining.timer) clearTimeout(draining.timer);
    worker.draining = null;
    draining.resolve();
  }

  // Ask the bridge to abort `requestId` and keep the worker (and its loaded
  // model) alive. The run promise has already settled as cancelled; this only
  // governs when the worker becomes reusable.
  function beginDrain(model: TModel, worker: Worker, requestId: string): void {
    finishDrain(worker);
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => {
      resolve = settle;
    });
    const timer = setTimeout(() => {
      // The bridge never came back — it may be stuck inside an inference step
      // that never reaches a cancel checkpoint. Fall back to killing it.
      killWorker(model, worker, "failed");
    }, cancelDrainMs);
    timer.unref?.();
    worker.draining = { requestId, timer, promise, resolve };
  }

  // Send the bridge a cancel and start draining. Falls back to killing the
  // worker when the socket cannot carry the request, which is the only way to
  // stop a bridge that will never hear about it.
  function requestBridgeCancel(model: TModel, worker: Worker, requestId: string): void {
    if (!worker.alive || !isOpen(worker.socket)) {
      killWorker(model, worker, "failed");
      return;
    }
    try {
      worker.socket.send(encodeCancel(requestId));
    } catch {
      killWorker(model, worker, "failed");
      return;
    }
    beginDrain(model, worker, requestId);
  }

  // While draining, the only frame that matters is the bridge's terminal
  // result for the cancelled request. Progress and audio still in flight are
  // dropped: the caller already saw the cancellation.
  function handleDrainMessage(model: TModel, worker: Worker, data: unknown): void {
    const draining = worker.draining;
    if (!draining || !isTerminalResultFor(data, draining.requestId)) return;
    finishDrain(worker);
    // The worker is idle and still holding its model; restart the eviction
    // clock that settleActive started when the run promise was rejected.
    armIdleEviction(model, worker);
  }

  function killWorker(model: TModel, worker: Worker, reason: WorkerExitReason): void {
    try {
      if (isOpen(worker.socket)) {
        worker.socket.send(SHUTDOWN_COMMAND);
      }
    } catch {
      // Best-effort graceful shutdown before hard kill.
    }
    disposeWorker(model, worker, reason);
    closeQuietly(worker.socket);
    worker.process.hardKill();
  }

  async function killWorkerAndWait(model: TModel, worker: Worker): Promise<void> {
    killWorker(model, worker, "stopped");
    await Promise.race([
      worker.process.exited,
      delay(killGraceMs + 500),
    ]);
  }

  function settleActive(
    model: TModel,
    worker: Worker,
    outcome: { ok: true; response: unknown } | { ok: false; error: Error },
  ): void {
    const active = worker.active;
    if (!active || active.settled) return;
    active.settled = true;
    active.watchdog?.stop();
    worker.active = null;
    requestModel.delete(active.requestId);
    cancelledRequests.delete(active.requestId);
    // A settled request can no longer be cancelled, so a crashed worker stops
    // holding the model; a Stop settles it before the output grace ends.
    if (failingWorkers.get(model) === worker) failingWorkers.delete(model);
    // A request that finished cleanly says what the worker now holds. One
    // that failed or was cancelled leaves an already-loaded model in place
    // when it targeted that model (the bridge keeps it through a handled
    // failure or a drained cancel); otherwise what is loaded is unknown.
    if (outcome.ok) worker.residencyKey = active.residencyKey;
    else if (active.residencyKey !== worker.residencyKey) worker.residencyKey = null;

    if (outcome.ok) {
      active.resolve({ response: outcome.response });
    } else {
      active.reject(outcome.error);
    }
    armIdleEviction(model, worker);
  }

  // Settles the active request as failed and, unless the bridge is known to
  // remain usable, stops the worker: a bridge that broke the protocol, missed
  // a deadline or flooded its output is not trusted with another request.
  function fail(model: TModel, worker: Worker, error: Error, { kill }: { kill: boolean }): void {
    settleActive(model, worker, { ok: false, error });
    if (kill) killWorker(model, worker, "failed");
  }

  function handleChildOutput(
    model: TModel,
    worker: Worker,
    stream: BridgeOutputStream,
    chunk: Buffer,
  ): void {
    const active = worker.active;
    if (!active || active.settled || active.failing) return;
    active.watchdog?.outputSeen();

    let bytes: number;
    let limit: number;
    if (stream === "stdout") {
      bytes = active.stdoutBytes += chunk.byteLength;
      limit = active.maxStdoutBytes;
    } else {
      bytes = active.stderrBytes += chunk.byteLength;
      limit = active.maxStderrBytes;
    }
    if (bytes > limit) {
      fail(model, worker, worker.process.processFailure(`Rust local bridge ${stream} exceeded ${limit} bytes.`), {
        kill: true,
      });
    }
  }

  function deliver(active: ActiveRequest, listener: StreamListener, send: () => void): void {
    try {
      send();
    } catch (error) {
      // A consumer must never break request handling; report it once.
      if (active.reportedListenerErrors.has(listener)) return;
      active.reportedListenerErrors.add(listener);
      try {
        onListenerError?.(error, { requestId: active.requestId, listener });
      } catch {
        // Reporting a consumer failure must not become one.
      }
    }
  }

  // The process is gone or going. Unless the request was cancelled, hold the
  // settlement until its stdio has closed (bounded) so the failure carries its
  // last output; the message is built then, when the exit status is known too.
  // The worker has already left `workers`, so it is parked in `failingWorkers`
  // meanwhile: that keeps the model busy, so no replacement worker can start
  // that a late cancel for this request would then mistake for its own.
  function failActiveAfterOutput(model: TModel, worker: Worker, summary: string): void {
    const active = worker.active;
    if (!active || active.settled || active.failing) return;
    if (cancelledRequests.has(active.requestId)) {
      settleActive(model, worker, { ok: false, error: generationCancelledError() });
      return;
    }
    active.failing = true;
    active.watchdog?.stop();
    failingWorkers.set(model, worker);
    void worker.process.waitForOutput().then(() => {
      settleActive(model, worker, {
        ok: false,
        error: cancelledOr(active, () => worker.process.exitFailure(summary)),
      });
    });
  }

  function handleWebSocketMessage(model: TModel, worker: Worker, data: unknown): void {
    const active = worker.active;
    if (!active || active.settled) {
      handleDrainMessage(model, worker, data);
      return;
    }
    if (cancelledRequests.has(active.requestId)) {
      // A cancel raced the transport. Settle as cancelled, then let the drain
      // path collect the bridge's terminal frame so the worker survives.
      settleActive(model, worker, { ok: false, error: generationCancelledError() });
      requestBridgeCancel(model, worker, active.requestId);
      handleDrainMessage(model, worker, data);
      return;
    }
    // Frames the process sent just before it died are still honoured (its
    // final result can race the exit), but they no longer extend watchdogs
    // the pending failure has already retired.
    active.watchdog?.frameSeen();
    try {
      handleRequestFrame(model, worker, active, data);
    } catch (err) {
      fail(model, worker, worker.process.requestFailure(errorMessage(err)), { kill: true });
    }
  }

  // Applies one frame of the active request. A thrown error is a protocol
  // violation: the caller fails the request and stops the worker.
  function handleRequestFrame(model: TModel, worker: Worker, active: ActiveRequest, data: unknown): void {
    const audio = dataToArrayBuffer(data);
    if (audio) {
      const chunk = active.stream.acceptBinary(audio);
      deliver(active, "audioChunk", () => active.onAudioChunk(chunk));
      return;
    }

    const message = parseBridgeMessage(data);
    if (typeof message.requestId !== "string") {
      throw new Error("WebSocket bridge returned a request-scoped message without a request id.");
    }
    if (message.requestId !== active.requestId) {
      // The bridge reports failures it cannot attribute to a request — an
      // unparseable request envelope, say — with an empty id. Surface its
      // message instead of discarding it behind an id-mismatch error.
      const unattributed = message.requestId === ""
        && (message.type === "result" || message.type === "error")
        && message.ok !== true
        && typeof message.error === "string"
        && message.error.trim() !== "";
      fail(model, worker, unattributed
        ? worker.process.requestFailure(String(message.error), message.details)
        : worker.process.requestFailure(`WebSocket bridge returned a message for unexpected request ${message.requestId}.`), {
        kill: true,
      });
      return;
    }

    switch (message.type) {
      case "progress":
        deliver(active, "progress", () => active.onProgress(message));
        return;
      case "audio_chunk":
        active.stream.acceptMetadata(message);
        return;
      case UNIT_GAP_MESSAGE_TYPE: {
        const gap = active.stream.acceptGap(message);
        const onAudioGap = active.onAudioGap;
        if (onAudioGap) deliver(active, "audioGap", () => onAudioGap(gap));
        return;
      }
      case "result":
        handleResult(model, worker, active, message);
        return;
      case "error":
        fail(model, worker, worker.process.requestFailure(
          typeof message.error === "string" ? message.error : "Rust local bridge failed.",
          message.details,
        ), { kill: true });
        return;
      default:
        throw new Error(`WebSocket bridge returned unsupported message type: ${message.type}.`);
    }
  }

  function handleResult(model: TModel, worker: Worker, active: ActiveRequest, message: BridgeMessage): void {
    if (active.stream.hasPendingChunk) {
      throw new Error("WebSocket bridge returned a result before the pending audio binary frame.");
    }
    if (message.ok === false) {
      if (typeof message.error !== "string" || !message.error.trim()) {
        throw new Error("WebSocket bridge returned a malformed failure envelope.");
      }
      // The bridge handled this failure and stays usable; its full error
      // chain (`details`) goes to the diagnostics log.
      fail(model, worker, worker.process.requestFailure(message.error, message.details), { kill: false });
      return;
    }
    if (message.ok !== true || !isRecord(message.result)) {
      throw new Error("WebSocket bridge returned a malformed result envelope.");
    }
    active.stream.verifyResult(message);
    settleActive(model, worker, { ok: true, response: message });
  }

  function handleWorkerExit(model: TModel, worker: Worker): void {
    const wasAlive = worker.alive;
    disposeWorker(model, worker, "failed");
    failActiveAfterOutput(
      model,
      worker,
      wasAlive ? "Rust local bridge exited before returning a result" : "Rust local bridge is no longer available",
    );
  }

  function handleTransportFailure(model: TModel, worker: Worker, summary: string): void {
    const wasAlive = worker.alive;
    disposeWorker(model, worker, "failed");
    failActiveAfterOutput(model, worker, summary);
    if (wasAlive) {
      worker.process.hardKill();
    }
  }

  async function spawnWorker(model: TModel, spawnConfig: WebSocketWorkerSpawnConfig): Promise<Worker> {
    const authToken = randomBytes(32).toString("hex");
    const child = spawn(model, { ...spawnConfig, authToken, host, port: 0 });
    const bridge = new BridgeProcess(child, {
      authToken,
      connectTimeoutMs,
      killGraceMs,
      onOutput: (stream, chunk) => handleChildOutput(model, worker, stream, chunk),
      onExit: () => handleWorkerExit(model, worker),
    });
    const worker: Worker = {
      process: bridge,
      socket: null,
      ready: false,
      spawnKey: spawnKeyOf(spawnConfig),
      active: null,
      draining: null,
      evictTimer: null,
      idleSince: 0,
      alive: true,
      residencyKey: null,
    };
    // Register the worker before the (potentially long) port wait + WebSocket
    // connect so shutdown/shutdownAll/cancel can kill a mid-spawn child instead
    // of leaking it.
    workers.set(model, worker);

    let socket: WebSocket;
    try {
      const port = await bridge.announcedPort;
      socket = await openWebSocketWithRetry(
        `ws://${host}:${port}/${authToken}`,
        connectTimeoutMs,
        () => worker.alive,
      );
      socket.binaryType = "arraybuffer";
      if (!worker.alive) {
        // Killed (cancel/shutdown) while the connection was being established.
        closeQuietly(socket);
        throw new Error("Rust local bridge process exited during startup.");
      }
    } catch (err) {
      disposeWorker(model, worker, "failed");
      bridge.hardKill();
      // A child that died on its own may still have its last words in the pipe.
      if (bridge.hasExited()) await bridge.waitForOutput();
      throw bridge.processFailure(errorMessage(err));
    }

    worker.socket = socket;
    if (!isOpen(socket)) {
      // The socket closed between connect resolving and listeners attaching;
      // fail fast instead of letting a later send() on CLOSED silently drop.
      disposeWorker(model, worker, "failed");
      bridge.hardKill();
      throw new Error("Rust local bridge connection closed during startup.");
    }
    socket.addEventListener("message", (event) => handleWebSocketMessage(model, worker, event.data));
    socket.addEventListener("close", () => {
      handleTransportFailure(model, worker, "Rust local bridge closed before returning a result");
    });
    socket.addEventListener("error", () => {
      handleTransportFailure(model, worker, "Rust local bridge connection failed");
    });
    worker.ready = true;
    return worker;
  }

  async function acquireWorker(
    model: TModel,
    spawnConfig: WebSocketWorkerSpawnConfig,
    requestId: string,
  ): Promise<Worker> {
    const draining = workers.get(model)?.draining;
    if (draining) {
      // Let the previous cancel finish unwinding so this request can reuse the
      // still-loaded model. beginDrain's timer bounds the wait: if the bridge
      // never acknowledges, it is killed and this falls through to a respawn.
      await draining.promise;
    }
    // Shutdown and cancellation both release a drain. The request waiting on
    // it must stop here, before it can create a replacement process that was
    // absent from shutdown's worker snapshot.
    if (cancelledRequests.has(requestId) || shuttingDown || stoppingModels.has(model)) {
      throw generationCancelledError();
    }
    const existing = workers.get(model);
    const wantedKey = spawnKeyOf(spawnConfig);
    if (existing && existing.alive && existing.spawnKey === wantedKey && isOpen(existing.socket)) {
      return existing;
    }
    if (existing) killWorker(model, existing, "stopped");
    return spawnWorker(model, spawnConfig);
  }

  return {
    async run(model, options) {
      if (shuttingDown || stoppingModels.has(model)) {
        throw new Error(LOCAL_RUNTIME_SHUTTING_DOWN_MESSAGE);
      }
      const existing = workers.get(model);
      if (existing?.active || startingModels.has(model) || failingWorkers.has(model)) {
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
        worker = await acquireWorker(model, options.spawnConfig, options.requestId);
      } catch (err) {
        const cancelled = cancelledRequests.has(options.requestId);
        requestModel.delete(options.requestId);
        cancelledRequests.delete(options.requestId);
        if (cancelled) {
          throw generationCancelledError();
        }
        const message = `Failed to start Rust local bridge worker: ${errorMessage(err)}`;
        const diagnostics = nativeFailureDiagnostics(err);
        throw diagnostics ? new NativeRuntimeError(message, diagnostics) : new Error(message);
      } finally {
        startingModels.delete(model);
      }

      if (cancelledRequests.has(options.requestId)) {
        requestModel.delete(options.requestId);
        cancelledRequests.delete(options.requestId);
        killWorker(model, worker, "stopped");
        throw generationCancelledError();
      }

      if (worker.evictTimer) {
        clearTimeout(worker.evictTimer);
        worker.evictTimer = null;
      }

      return await new Promise<WebSocketWorkerRunResult>((resolve, reject) => {
        const expectAudio = options.command == null;
        const active: ActiveRequest = {
          requestId: options.requestId,
          residencyKey: options.residencyKey ?? null,
          resolve,
          reject,
          onProgress: options.onProgress,
          onAudioChunk: options.onAudioChunk,
          onAudioGap: options.onAudioGap ?? null,
          idleTimeoutMs: options.idleTimeoutMs,
          progressTimeoutMs: Math.max(
            options.idleTimeoutMs,
            options.progressTimeoutMs ?? options.idleTimeoutMs * 15,
          ),
          maxStdoutBytes: options.maxStdoutBytes,
          maxStderrBytes: options.maxStderrBytes,
          stdoutBytes: 0,
          stderrBytes: 0,
          stream: new AudioStreamValidator(options.requestId, expectAudio, streamLimits),
          watchdog: null,
          settled: false,
          failing: false,
          reportedListenerErrors: new Set(),
        };
        worker.active = active;
        // Cancellation is registered before worker acquisition. Re-check only
        // after publishing `worker.active` so a cancel that lands at the
        // acquisition/activation boundary always settles this promise as a
        // cancellation and never falls through to a transport-send error.
        if (cancelledRequests.has(options.requestId)) {
          settleActive(model, worker, { ok: false, error: generationCancelledError() });
          killWorker(model, worker, "stopped");
          return;
        }
        active.watchdog = new RequestWatchdog({
          idleTimeoutMs: active.idleTimeoutMs,
          progressTimeoutMs: active.progressTimeoutMs,
          // A cancel can land in the same tick a deadline elapses (cancel
          // records the id but settlement comes from the async exit/close).
          // A deliberate Stop is reported as a cancellation rather than a
          // misleading "process may be stuck" error.
          onIdle: () => fail(model, worker, cancelledOr(active, () => worker.process.processFailure(
            `Rust local bridge produced no output for ${active.idleTimeoutMs / 1000}s and was stopped (the process may be stuck).`,
          )), { kill: true }),
          onStalled: () => fail(model, worker, cancelledOr(active, () => worker.process.processFailure(
            `Rust local bridge produced no protocol progress for ${active.progressTimeoutMs / 1000}s and was stopped.`,
          )), { kill: true }),
        });

        try {
          if (!isOpen(worker.socket)) {
            throw new Error("worker socket is not connected");
          }
          worker.socket.send(encodeRequest(options.requestId, options.command, options.payload, maxRequestTextBytes));
        } catch (err) {
          const cancelled = cancelledRequests.has(options.requestId) || active.settled;
          fail(model, worker, cancelled
            ? generationCancelledError()
            : worker.process.requestFailure(`Failed to send request to Rust local bridge: ${errorMessage(err)}`), {
            kill: true,
          });
        }
      });
    },

    cancel(requestId) {
      const model = requestModel.get(requestId);
      if (model === undefined) return false;
      const worker = workers.get(model);
      if (!worker) {
        // A dead worker may have released acquisition's drain wait before its
        // continuation runs. The registered request still owns cancellation.
        cancelledRequests.add(requestId);
        // Or the request's bridge just died and it is collecting the last
        // output; a Stop still settles it at once.
        const failing = failingWorkers.get(model);
        if (failing?.active?.requestId === requestId) {
          settleActive(model, failing, { ok: false, error: generationCancelledError() });
        }
        return true;
      }
      // A worker with no active request is still spawning for this request
      // (run registers the request before acquiring the worker). Killing it
      // rejects the pending run with a cancellation error.
      if (worker.active && worker.active.requestId !== requestId) return false;
      cancelledRequests.add(requestId);
      if (!worker.active) {
        killWorker(model, worker, "stopped");
        return true;
      }
      // Settle the caller immediately — Stop must feel instant — then ask the
      // bridge to unwind rather than killing it. A killed worker drops the
      // model it just spent seconds loading, so the next generation pays for
      // it again; draining keeps the process warm and reusable.
      settleActive(model, worker, { ok: false, error: generationCancelledError() });
      requestBridgeCancel(model, worker, requestId);
      return true;
    },

    shutdown(model) {
      const stopping = stoppingModels.get(model);
      if (stopping) return stopping;
      // shutdown(model) backs cache clearing as well as explicit teardown. Any
      // request already assigned to that model is deliberately cancelled, not
      // a startup failure or an unexplained bridge crash.
      for (const [requestId, requestModelName] of requestModel) {
        if (requestModelName === model) cancelledRequests.add(requestId);
      }
      const worker = workers.get(model);
      if (!worker) return Promise.resolve(false);
      const shutdown = killWorkerAndWait(model, worker).then(() => true).finally(() => {
        stoppingModels.delete(model);
      });
      stoppingModels.set(model, shutdown);
      return shutdown;
    },

    shutdownAll() {
      if (shutdownPromise) return shutdownPromise;
      shuttingDown = true;
      // Mark every in-flight request cancelled before killing so a slow worker
      // that settles after the bounded wait (via handleWorkerExit) reports the
      // deliberate shutdown as a cancellation rather than a crash. The settle
      // paths delete each request's entries themselves, so no unconditional
      // clear here — that would erase the state a late settlement consults.
      for (const requestId of requestModel.keys()) {
        cancelledRequests.add(requestId);
      }
      shutdownPromise = Promise.all([
        ...stoppingModels.values(),
        ...[...workers.entries()].map(([model, worker]) => killWorkerAndWait(model, worker)),
      ]).then(() => undefined);
      return shutdownPromise;
    },

    isRunning(requestId) {
      const model = requestModel.get(requestId);
      if (model === undefined) return false;
      return workers.get(model)?.active?.requestId === requestId;
    },

    refreshIdleEviction(model) {
      const worker = workers.get(model);
      // Only an idle worker has an eviction clock running.
      if (!worker?.evictTimer || worker.active || worker.draining) return;
      armIdleEviction(model, worker, { restart: false });
    },
  };
}
