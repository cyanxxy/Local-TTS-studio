import type { IpcMainInvokeEvent } from "electron";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import type { ShutdownParticipant } from "../appShutdown";
import type { DiagnosticsLogger } from "../diagnostics";
import { getDirectorySizeBytes } from "../directorySize";
import { removeTreeOptions } from "../fsRetry";
import {
  describeError,
  errorMessage,
  generationCancelledError,
  isGenerationCancelled,
  LOCAL_RUNTIME_SHUTTING_DOWN_MESSAGE,
} from "../errors";
import { createGenerateRateLimiter } from "../generateRateLimiter";
import { isRecord } from "../guards";
import { LocalModelLifecycle } from "../localModelLifecycle";
import {
  assertLocalModel,
  parseBridgeEnvelopeResult,
  parseBridgeProgressResult,
  parseBridgeWarmResult,
  parseRequestId,
  sanitizeCacheRequest,
  sanitizeCancelRequest,
  sanitizeGeneratePayload,
  sanitizeGenerationContinuation,
  sanitizeKeepWarmRequest,
  sanitizeReleaseKeepWarmRequest,
  sanitizeWarmRequest,
  type BridgeAction,
  type BridgeGenerateResult,
  type BridgeProbeResult,
  type BridgeWarmResult,
  type LocalCacheInfo,
  type LocalModel,
} from "../localTtsIpc";
import type { Qwen3ModelDownloadResult } from "../qwen3ModelDownload";
import { isStructurallyValidQwen3ModelDir } from "../qwen3ModelDownload";
import { getQwen3Profile } from "../qwen3Profiles";
import {
  createWebSocketBridgeWorkerPool,
  type WebSocketAudioChunk,
  type WebSocketUnitGap,
  type WebSocketBridgeWorkerPool,
  type WebSocketWorkerRunResult,
  type WorkerExitReason,
} from "../webSocketBridgeWorker";
import {
  bridgeWorkingDirectory,
  buildRustBridgeEnv,
  createBridgeEnvironment,
  type BridgeEnvironmentOptions,
} from "./bridgeEnvironment";
import { KeepWarmLeases } from "./keepWarmLeases";
import { createModelDirValidationCache } from "./modelDirValidationCache";
import { createProbeRunner } from "./probeRunner";
import { createQwen3SetupHandlers, type Qwen3ModelDirChoice, type Qwen3SetupResult } from "./qwen3Setup";
import { BridgeRequestRegistry } from "./requestRegistry";
import { WarmupCoordinator, warmTargetKey, type PendingWarmup } from "./warmups";

// Generation (model download + inference) can legitimately run for many minutes.
// A short liveness watchdog is extended by Rust heartbeats or socket traffic.
// A second, longer protocol-progress deadline is extended only by WebSocket
// frames, so a live heartbeat thread cannot mask a permanently stuck inference
// while long Reader synthesis can continue unit-by-unit.
const RUST_BRIDGE_GENERATE_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const RUST_BRIDGE_GENERATE_PROGRESS_TIMEOUT_MS = 30 * 60 * 1000;
// On the WebSocket path stdout/stderr are diagnostic-only (results travel over
// the socket), so keep modest caps that still tolerate native-provider startup logs.
const RUST_BRIDGE_WS_DIAGNOSTIC_MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const RUST_BRIDGE_WS_DIAGNOSTIC_MAX_STDERR_BYTES = 16 * 1024 * 1024;
// The one-shot probe runs to this absolute deadline.
const RUST_BRIDGE_PROBE_TIMEOUT_MS = 5 * 60 * 1000;
// How long a terminated bridge child gets before SIGKILL.
export const RUST_CANCEL_KILL_AFTER_MS = 2_000;
const GENERATE_RATE_WINDOW_MS = 500;
// Generation reuses a resident WebSocket worker (load once, serve many). The
// worker is killed after this much idle time to release model memory; the next
// request transparently respawns it.
const RUST_BRIDGE_WORKER_IDLE_EVICT_MS = 5 * 60 * 1000;
// Qwen's MLX/Metal backend has a much larger working set than the CPU-oriented
// local runtimes. Keep its warm-start grace short so macOS can reclaim unified
// memory promptly after the user finishes a generation.
const QWEN3_BRIDGE_WORKER_IDLE_EVICT_MS = 60 * 1000;
// While a renderer holds a keep-warm lease on the Qwen3 model a worker has
// loaded, the worker idles this long instead. The cap still frees the memory
// of a window left open with a model selected, or of a lease never released.
export const QWEN3_KEEP_WARM_IDLE_EVICT_MS = 30 * 60 * 1000;

/** A resident worker went away, and the model it had loaded with it. */
export interface LocalModelEvictedEvent {
  model: LocalModel;
  reason: WorkerExitReason;
}

export interface LocalTtsRuntimeOptions extends BridgeEnvironmentOptions {
  /** Failures that never reach a renderer as an IPC rejection are logged here. */
  logger: DiagnosticsLogger;
  /** Told whenever a worker that had connected goes away (see WorkerExitReason). */
  onModelEvicted?: (event: LocalModelEvictedEvent) => void;
}

export interface LocalTtsRuntime {
  probe(request: unknown, event: IpcMainInvokeEvent): Promise<BridgeProbeResult>;
  generate(request: unknown, event: IpcMainInvokeEvent): Promise<BridgeGenerateResult>;
  warm(request: unknown, event: IpcMainInvokeEvent): Promise<BridgeWarmResult>;
  keepWarm(request: unknown, event: IpcMainInvokeEvent): Promise<void>;
  releaseKeepWarm(request: unknown, event: IpcMainInvokeEvent): Promise<{ released: boolean }>;
  cancel(request: unknown, event: IpcMainInvokeEvent): Promise<{ cancelled: boolean }>;
  cacheInfo(request: unknown): Promise<LocalCacheInfo>;
  clearCache(request: unknown): Promise<{ path: string; cleared: boolean }>;
  qwen3Setup(request: unknown): Promise<Qwen3SetupResult>;
  downloadQwen3Model(request: unknown, event: IpcMainInvokeEvent): Promise<Qwen3ModelDownloadResult>;
  chooseQwen3ModelDir(request: unknown, event: IpcMainInvokeEvent): Promise<Qwen3ModelDirChoice>;
  readonly shutdown: ShutdownParticipant;
}

interface BridgeRequestTarget {
  model: LocalModel;
  requestId: string;
  fields: Record<string, unknown>;
}

/**
 * The local Rust runtimes (NeuTTS, Qwen3): generation on resident WebSocket
 * workers, one-shot probes, warm-ups, cancellation, cache management and Qwen3
 * model setup.
 */
export function createLocalTtsRuntime(options: LocalTtsRuntimeOptions): LocalTtsRuntime {
  const { logger } = options;
  const environment = createBridgeEnvironment(options);
  const lifecycle = new LocalModelLifecycle<LocalModel>();
  const generateRateLimiter = createGenerateRateLimiter<LocalModel>({
    rateWindowMs: GENERATE_RATE_WINDOW_MS,
  });
  const warmups = new WarmupCoordinator();
  const probes = createProbeRunner({
    timeoutMs: RUST_BRIDGE_PROBE_TIMEOUT_MS,
    killGraceMs: RUST_CANCEL_KILL_AFTER_MS,
    maxStdoutBytes: RUST_BRIDGE_WS_DIAGNOSTIC_MAX_STDOUT_BYTES,
    maxStderrBytes: RUST_BRIDGE_WS_DIAGNOSTIC_MAX_STDERR_BYTES,
  });
  const registry = new BridgeRequestRegistry(stopRequestNow);
  const qwen3ModelDirs = createModelDirValidationCache({ validate: isStructurallyValidQwen3ModelDir });
  let webSocketBridgeWorkers: WebSocketBridgeWorkerPool<LocalModel> | null = null;
  // A lease taken or dropped re-times the model's idle worker at once.
  const keepWarmLeases = new KeepWarmLeases((model) => webSocketBridgeWorkers?.refreshIdleEviction(model));
  let shuttingDown = false;

  function assertAcceptingRequests(): void {
    if (shuttingDown) throw new Error(LOCAL_RUNTIME_SHUTTING_DOWN_MESSAGE);
  }

  // Reaches a request wherever it currently runs: waiting on a warm-up (which
  // is stopped too, so the waiter is released promptly), in the worker pool, or
  // as a probe child.
  function stopRequestNow(requestId: string): void {
    const blockingWarmup = warmups.cancelWaiter(requestId);
    if (blockingWarmup) {
      registry.markCancelled(blockingWarmup.requestId);
      webSocketBridgeWorkers?.cancel(blockingWarmup.requestId);
    }
    if (webSocketBridgeWorkers?.cancel(requestId)) return;
    probes.terminate(requestId);
  }

  function cancelPendingWarmup(pending: PendingWarmup): void {
    registry.cancel(pending.requestId);
  }

  function getWebSocketBridgeWorkers(): WebSocketBridgeWorkerPool<LocalModel> {
    assertAcceptingRequests();
    if (!webSocketBridgeWorkers) {
      webSocketBridgeWorkers = createWebSocketBridgeWorkerPool<LocalModel>({
        idleEvictMs: (model, residencyKey) => {
          if (model !== "qwen3") return RUST_BRIDGE_WORKER_IDLE_EVICT_MS;
          return keepWarmLeases.covers(model, residencyKey)
            ? QWEN3_KEEP_WARM_IDLE_EVICT_MS
            : QWEN3_BRIDGE_WORKER_IDLE_EVICT_MS;
        },
        killGraceMs: RUST_CANCEL_KILL_AFTER_MS,
        onListenerError: (error, { requestId, listener }) => {
          logger.error("A bridge stream consumer failed", { requestId, listener, error: describeError(error) });
        },
        onWorkerExit: (model, { reason }) => {
          logger.debug("A resident bridge worker went away", { model, reason });
          options.onModelEvicted?.({ model, reason });
        },
        spawn: (model, { bridgeBinary, cacheDir, env, authToken, host, port }) =>
          spawn(
            bridgeBinary,
            [
              "--action",
              "serve-ws",
              "--model",
              model,
              "--cache-dir",
              cacheDir,
              "--host",
              host,
              "--port",
              String(port),
            ],
            {
              stdio: ["pipe", "pipe", "pipe"],
              env: { ...env, OPEN_TTS_WS_AUTH_TOKEN: authToken },
              cwd: bridgeWorkingDirectory(cacheDir),
              windowsHide: true,
            },
          ),
      });
    }
    return webSocketBridgeWorkers;
  }

  // Claims the request id for its renderer, holds a lifecycle lease on the
  // model (so cache deletion waits for or cancels it) and routes the lease's
  // abort into a cancellation.
  async function withBridgeRequest<T>(
    kind: BridgeAction,
    request: unknown,
    event: IpcMainInvokeEvent,
    run: (target: BridgeRequestTarget) => Promise<T>,
  ): Promise<T> {
    assertAcceptingRequests();
    if (!isRecord(request)) throw new Error("Invalid IPC request payload.");
    const model = assertLocalModel(String(request.model));
    const requestId = parseRequestId(request.requestId, { required: true })!;
    const owner = registry.register(requestId, model, kind, event.sender);
    try {
      return await lifecycle.run(model, async (signal) => {
        const cancel = () => registry.cancel(requestId);
        signal.addEventListener("abort", cancel, { once: true });
        try {
          return await run({ model, requestId, fields: request });
        } finally {
          signal.removeEventListener("abort", cancel);
        }
      });
    } finally {
      registry.release(requestId, owner);
    }
  }

  async function assertQwen3ModelDir(payload: Record<string, unknown>): Promise<void> {
    const profile = getQwen3Profile(String(payload.modelRepo));
    const modelPath = String(payload.modelPath);
    if (!profile || !(await qwen3ModelDirs.isValid(modelPath, profile))) {
      throw new Error("The selected Qwen3 model directory is missing required files or does not match the selected profile.");
    }
  }

  async function runWebSocketGenerate(
    model: LocalModel,
    requestId: string,
    payload: Record<string, unknown>,
    event: IpcMainInvokeEvent,
  ): Promise<BridgeGenerateResult> {
    const cacheDir = environment.cacheDir(model);
    const bridgeBinary = environment.bridgeBinaryPath();

    // Until the request registers with the worker pool (synchronously inside
    // run()), a cancel can only find it here. Keep the entry alive across the
    // whole pre-pool window (fs waits, warm-up handoff) so a cancel in that
    // window records intent instead of returning { cancelled: false }.
    warmups.addWaiter(requestId, model);
    let runPromise: Promise<WebSocketWorkerRunResult>;
    try {
      await fs.access(bridgeBinary);
      await fs.mkdir(cacheDir, { recursive: true });
      if (registry.isCancelled(requestId)) {
        throw generationCancelledError();
      }

      const generateWarmTarget = warmTargetKey(model, payload);
      for (;;) {
        const pendingWarm = warmups.pending(model);
        if (!pendingWarm) break;
        if (pendingWarm.targetKey !== generateWarmTarget) {
          cancelPendingWarmup(pendingWarm);
        }
        await pendingWarm.promise;
      }
      if (warmups.isWaiterCancelled(requestId)) {
        throw generationCancelledError();
      }

      let reportedMalformedProgress = false;
      const onProgress = (progressPayload: unknown) => {
        if (event.sender.isDestroyed()) return;
        try {
          const progress = parseBridgeProgressResult(progressPayload);
          event.sender.send("local-tts:progress", { requestId, model, ...progress });
        } catch (err) {
          // Progress is advisory: skip the frame, and log the first per request.
          if (reportedMalformedProgress) return;
          reportedMalformedProgress = true;
          logger.warn("Ignored a malformed bridge progress frame", { model, requestId, error: errorMessage(err) });
        }
      };

      const onAudioChunk = (chunk: WebSocketAudioChunk) => {
        if (event.sender.isDestroyed()) return;
        event.sender.send("local-tts:audio-stream", { type: "chunk", model, ...chunk });
      };

      const onAudioGap = (gap: WebSocketUnitGap) => {
        if (event.sender.isDestroyed()) return;
        event.sender.send("local-tts:audio-stream", { type: "gap", model, ...gap });
      };

      // run() registers the request with the pool synchronously, so once it
      // returns cancel is routed there; the warm-waiter entry can be dropped.
      runPromise = getWebSocketBridgeWorkers().run(model, {
        requestId,
        payload,
        residencyKey: generateWarmTarget,
        spawnConfig: { bridgeBinary, cacheDir, env: buildRustBridgeEnv(cacheDir) },
        idleTimeoutMs: RUST_BRIDGE_GENERATE_IDLE_TIMEOUT_MS,
        progressTimeoutMs: RUST_BRIDGE_GENERATE_PROGRESS_TIMEOUT_MS,
        maxStdoutBytes: RUST_BRIDGE_WS_DIAGNOSTIC_MAX_STDOUT_BYTES,
        maxStderrBytes: RUST_BRIDGE_WS_DIAGNOSTIC_MAX_STDERR_BYTES,
        onProgress,
        onAudioChunk,
        onAudioGap,
      });
    } finally {
      warmups.removeWaiter(requestId);
    }
    try {
      const { response } = await runPromise;
      return parseBridgeEnvelopeResult(response);
    } finally {
      // The end marker follows the last chunk on the same ordered channel and
      // goes out before the invoke reply, which Electron may still deliver
      // first: once the preload sees it, every chunk of this request has
      // reached the renderer.
      if (!event.sender.isDestroyed()) {
        event.sender.send("local-tts:audio-stream", { type: "end", model, requestId });
      }
    }
  }

  const qwen3 = createQwen3SetupHandlers({
    environment,
    lifecycle,
    assertAcceptingRequests,
    onModelDirsChanged: () => qwen3ModelDirs.invalidate(),
  });

  return {
    probe(request, event) {
      return withBridgeRequest("probe", request, event, async ({ model, requestId }) => {
        if (registry.isCancelled(requestId)) throw generationCancelledError();
        const cacheDir = environment.cacheDir(model);
        const bridgeBinary = environment.bridgeBinaryPath();
        await fs.access(bridgeBinary);
        await fs.mkdir(cacheDir, { recursive: true });
        if (registry.isCancelled(requestId)) throw generationCancelledError();
        return probes.run({ requestId, model, bridgeBinary, cacheDir, env: buildRustBridgeEnv(cacheDir) });
      });
    },

    generate(request, event) {
      return withBridgeRequest("generate", request, event, async ({ model, requestId, fields }) => {
        const payload = sanitizeGeneratePayload(model, fields.payload, process.platform, process.arch);
        const continuation = sanitizeGenerationContinuation(fields.continuation);
        if (model === "qwen3") await assertQwen3ModelDir(payload);
        if (registry.isCancelled(requestId)) throw generationCancelledError();
        return generateRateLimiter.run(
          model,
          () => {
            // The limiter may have held the request through its cooldown.
            if (registry.isCancelled(requestId)) throw generationCancelledError();
            return runWebSocketGenerate(model, requestId, payload, event);
          },
          continuation,
        );
      });
    },

    // Pre-loads the selected model in its resident WebSocket worker so the
    // first generation skips the model load. Failures degrade to
    // `warmed: false` — warm-up must never surface an error the generation path
    // would explain better.
    async warm(request, event) {
      assertAcceptingRequests();
      const { model, modelRepo, payload } = sanitizeWarmRequest(request, process.platform, process.arch);
      return lifecycle.run(model, async (signal) => {
        const targetKey = warmTargetKey(model, { ...payload, ...(modelRepo ? { modelRepo } : {}) });
        for (;;) {
          const pendingWarm = warmups.pending(model);
          if (!pendingWarm) break;
          if (pendingWarm.targetKey === targetKey) {
            return { warmed: false, message: "This model is already warming." };
          }
          cancelPendingWarmup(pendingWarm);
          await pendingWarm.promise;
        }
        if (signal.aborted) return { warmed: false, message: "Warm-up cancelled." };
        const warmRequestId = `${model}-warm-${randomUUID()}`;
        const { warmup, settle } = warmups.begin(model, warmRequestId, targetKey);
        const owner = registry.register(warmRequestId, model, "warm", event.sender);
        const cancel = () => cancelPendingWarmup(warmup);
        signal.addEventListener("abort", cancel, { once: true });
        try {
          if (model === "qwen3") {
            const profile = modelRepo ? getQwen3Profile(modelRepo) : undefined;
            const modelPath = String(payload.modelPath ?? "");
            if (!profile || !(await qwen3ModelDirs.isValid(modelPath, profile))) {
              return { warmed: false, message: "The selected Qwen3 model directory is incomplete or incompatible." };
            }
          }
          if (registry.isCancelled(warmRequestId)) {
            return { warmed: false, message: "Warm-up cancelled." };
          }

          const cacheDir = environment.cacheDir(model);
          const bridgeBinary = environment.bridgeBinaryPath();
          await fs.access(bridgeBinary);
          await fs.mkdir(cacheDir, { recursive: true });
          if (registry.isCancelled(warmRequestId)) {
            return { warmed: false, message: "Warm-up cancelled." };
          }

          const { response } = await getWebSocketBridgeWorkers().run(model, {
            requestId: warmRequestId,
            payload,
            command: "warm",
            residencyKey: targetKey,
            spawnConfig: { bridgeBinary, cacheDir, env: buildRustBridgeEnv(cacheDir) },
            idleTimeoutMs: RUST_BRIDGE_GENERATE_IDLE_TIMEOUT_MS,
            progressTimeoutMs: RUST_BRIDGE_GENERATE_PROGRESS_TIMEOUT_MS,
            maxStdoutBytes: RUST_BRIDGE_WS_DIAGNOSTIC_MAX_STDOUT_BYTES,
            maxStderrBytes: RUST_BRIDGE_WS_DIAGNOSTIC_MAX_STDERR_BYTES,
            onProgress: () => {},
            onAudioChunk: () => {},
          });
          return parseBridgeWarmResult(response);
        } catch (err) {
          // The renderer only learns `warmed: false`, so this is the one place
          // a failing warm-up leaves its diagnostics.
          if (!isGenerationCancelled(err)) logger.warn("Warm-up failed", { model, error: describeError(err) });
          return { warmed: false, message: errorMessage(err) };
        } finally {
          signal.removeEventListener("abort", cancel);
          settle();
          registry.release(warmRequestId, owner);
        }
      });
    },

    // Keeps the named Qwen3 model resident for as long as the lease is held
    // (bounded by QWEN3_KEEP_WARM_IDLE_EVICT_MS of idling). Taking a lease
    // loads nothing: the renderer warms the model as before.
    async keepWarm(request, event) {
      assertAcceptingRequests();
      const { leaseId, model, payload } = sanitizeKeepWarmRequest(request, process.platform, process.arch);
      keepWarmLeases.acquire(event.sender, leaseId, model, warmTargetKey(model, payload));
    },

    async releaseKeepWarm(request, event) {
      const { leaseId } = sanitizeReleaseKeepWarmRequest(request);
      return { released: keepWarmLeases.release(event.sender.id, leaseId) };
    },

    async cancel(request, event) {
      const { model, requestId } = sanitizeCancelRequest(request);
      const owner = registry.owner(requestId);
      if (!owner) return { cancelled: false };
      if (owner.model !== model || owner.senderId !== event.sender.id) {
        throw new Error("Cancellation request does not own the active local-runtime request.");
      }
      registry.cancel(requestId);
      return { cancelled: true };
    },

    async cacheInfo(request) {
      const { model } = sanitizeCacheRequest(request);
      const cachePath = environment.cacheDir(model);

      try {
        const stats = await fs.stat(cachePath);
        if (!stats.isDirectory()) {
          return { path: cachePath, exists: false, sizeBytes: 0 };
        }
      } catch {
        return { path: cachePath, exists: false, sizeBytes: 0 };
      }

      const sizeBytes = await getDirectorySizeBytes(cachePath);
      return { path: cachePath, exists: true, sizeBytes };
    },

    async clearCache(request) {
      const { model } = sanitizeCacheRequest(request);
      const cachePath = environment.cacheDir(model);
      return lifecycle.clear(model, async () => {
        await webSocketBridgeWorkers?.shutdown(model);
        try {
          await fs.rm(cachePath, removeTreeOptions());
        } finally {
          // Managed Qwen3 folders live inside this cache; even a partial
          // removal must be noticed by the next request.
          if (model === "qwen3") qwen3ModelDirs.invalidate();
        }
        return { path: cachePath, cleared: true };
      });
    },

    qwen3Setup: (request) => qwen3.setup(request),
    downloadQwen3Model: (request, event) => qwen3.download(request, event.sender),
    chooseQwen3ModelDir: (request, event) => qwen3.chooseModelDir(request, event.sender),

    // Holds the quit for the worker pool shutdown and any one-shot probe
    // children (SIGTERM + SIGKILL escalation), and for every lifecycle activity
    // to unwind.
    shutdown: {
      name: "local-tts",
      beginShutdown() {
        shuttingDown = true;
        const localModelsBusy = lifecycle.busy;
        const localModelsShutdown = lifecycle.close();
        registry.markAllCancelled();
        const probeExits = probes.terminateAll();
        if (!webSocketBridgeWorkers && probeExits.length === 0 && !localModelsBusy) return null;
        return Promise.all([
          webSocketBridgeWorkers?.shutdownAll() ?? Promise.resolve(),
          ...probeExits,
          localModelsShutdown,
        ]);
      },
    },
  };
}
