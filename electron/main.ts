import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { createShutdownCoordinator, type ShutdownParticipant } from "./appShutdown";
import { createMainWindow, registerAppScheme, registerSessionSecurity } from "./appWindow";
import { registerAudio8Ipc } from "./ipc/registerAudio8Ipc";
import { registerDocumentIpc } from "./ipc/registerDocumentIpc";
import { registerReaderLibraryIpc } from "./ipc/registerReaderLibraryIpc";
import { createTrustedIpc } from "./ipc/trusted";
import { createGenerateRateLimiter } from "./generateRateLimiter";
import { runHfXetDownloader } from "./hfXetDownload";
import {
  adoptLegacyQwen3ModelDir,
  createQwen3ModelDownloadCoordinator,
  createSafeProgressSender,
  downloadQwen3Model,
  inspectQwen3ModelDir,
  isStructurallyValidQwen3ModelDir,
  requestUrl,
  type Qwen3ModelDownloadResult,
} from "./qwen3ModelDownload";
import {
  getDefaultQwen3Profile,
  getQwen3Profile,
  getQwen3Profiles,
  qwen3ProfileSupportsRuntime,
  type Qwen3Profile,
} from "./qwen3Profiles";
import {
  createWebSocketBridgeWorkerPool,
  type WebSocketBridgeWorkerPool,
} from "./webSocketBridgeWorker";
import { configureApplicationMenu } from "./applicationMenu";
import { LocalModelLifecycle } from "./localModelLifecycle";
import { getDirectorySizeBytes } from "./directorySize";
import {
  assertLocalModel,
  isRecord,
  parseBridgeEnvelopeResult,
  parseBridgeProgressResult,
  parseBridgeResult,
  parseBridgeWarmResult,
  parseRequestId,
  sanitizeCacheRequest,
  sanitizeCancelRequest,
  sanitizeGeneratePayload,
  sanitizeGenerationContinuation,
  sanitizeWarmRequest,
  type BridgeAction,
  type LocalCacheInfo,
  type LocalModel,
  type ValidatedLocalBridgeRequest,
} from "./localTtsIpc";

const isDev = !app.isPackaged;
const RUST_BRIDGE_TIMEOUT_MS = 5 * 60 * 1000;

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
const RUST_CANCEL_KILL_AFTER_MS = 2_000;
const GENERATE_RATE_WINDOW_MS = 500;
// Generation reuses a resident WebSocket worker (load once, serve many). The
// worker is killed after this much idle time to release model memory; the next
// request transparently respawns it.
const RUST_BRIDGE_WORKER_IDLE_EVICT_MS = 5 * 60 * 1000;
// Qwen's MLX/Metal backend has a much larger working set than the CPU-oriented
// local runtimes. Keep its warm-start grace short so macOS can reclaim unified
// memory promptly after the user finishes a generation.
const QWEN3_BRIDGE_WORKER_IDLE_EVICT_MS = 60 * 1000;
const windowOptions = { isDev, appDirectory: __dirname };
registerAppScheme();

// Only `probe` runs as a one-shot subprocess now; this lets a probe child be
// force-killed by handleCancel/before-quit. Generation runs on the WebSocket
// worker pool, which owns its own cancellation.
const activeBridgeProcesses = new Map<string, ChildProcessWithoutNullStreams>();
interface ActiveBridgeRequestOwner {
  model: LocalModel;
  senderId: number;
  kind: BridgeAction | "warm";
}
const activeBridgeRequestOwners = new Map<string, ActiveBridgeRequestOwner>();
const cancelledBridgeRequests = new Set<string>();
const monitoredBridgeSenders = new WeakSet<WebContents>();
let bridgeShuttingDown = false;
const generateRateLimiter = createGenerateRateLimiter<LocalModel>({
  rateWindowMs: GENERATE_RATE_WINDOW_MS,
});
let webSocketBridgeWorkers: WebSocketBridgeWorkerPool<LocalModel> | null = null;
const localModelLifecycle = new LocalModelLifecycle<LocalModel>();
// Best-effort Qwen model warm-up. At most one
// warm-up runs per model; a generate request that arrives while one is in
// flight waits for it (the warm-up is doing exactly the model load the
// generation would otherwise pay) instead of failing with "already running".
interface PendingWarmup {
  requestId: string;
  targetKey: string;
  promise: Promise<void>;
}
const pendingWarmups = new Map<LocalModel, PendingWarmup>();
// Generate requests currently waiting on a warm-up, so cancel can reach them
// before they are registered with the worker pool.
const warmWaiters = new Map<string, LocalModel>();
const cancelledWarmWaiters = new Set<string>();

function warmTargetKey(model: LocalModel, payload: Record<string, unknown>): string {
  if (model === "qwen3") {
    return [model, payload.mode, payload.modelRepo, payload.modelPath].map(String).join("\0");
  }
  return [model, payload.modelRepo ?? "neuphonic/neutts-nano-q4-gguf"].map(String).join("\0");
}

function cancelPendingWarmup(pending: PendingWarmup): void {
  cancelledBridgeRequests.add(pending.requestId);
  cancelBridgeRequestNow(pending.requestId);
}

function assertBridgeAcceptingRequests(): void {
  if (bridgeShuttingDown) throw new Error("The local runtime is shutting down.");
}

function cancelBridgeRequestNow(requestId: string): void {
  const warmModel = warmWaiters.get(requestId);
  if (warmModel !== undefined) {
    cancelledWarmWaiters.add(requestId);
    const pendingWarm = pendingWarmups.get(warmModel);
    if (pendingWarm) {
      cancelledBridgeRequests.add(pendingWarm.requestId);
      webSocketBridgeWorkers?.cancel(pendingWarm.requestId);
    }
  }
  if (webSocketBridgeWorkers?.cancel(requestId)) return;
  const child = activeBridgeProcesses.get(requestId);
  if (child) terminateBridgeChild(child);
}

function cancelBridgeRequestsForSender(senderId: number): void {
  for (const [requestId, owner] of activeBridgeRequestOwners) {
    if (owner.senderId !== senderId) continue;
    cancelledBridgeRequests.add(requestId);
    cancelBridgeRequestNow(requestId);
  }
}

function monitorBridgeSender(sender: WebContents): void {
  if (monitoredBridgeSenders.has(sender)) return;
  monitoredBridgeSenders.add(sender);
  const senderId = sender.id;
  const cancelOwnedRequests = () => cancelBridgeRequestsForSender(senderId);
  const cancelForNavigation = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
    if (details.isMainFrame && !details.isSameDocument) cancelOwnedRequests();
  };
  sender.on("render-process-gone", cancelOwnedRequests);
  sender.on("did-start-navigation", cancelForNavigation);
  sender.once("destroyed", () => {
    cancelOwnedRequests();
    sender.removeListener("render-process-gone", cancelOwnedRequests);
    sender.removeListener("did-start-navigation", cancelForNavigation);
  });
}

function registerBridgeRequestOwner(
  requestId: string,
  model: LocalModel,
  kind: ActiveBridgeRequestOwner["kind"],
  event?: IpcMainInvokeEvent,
): ActiveBridgeRequestOwner {
  if (activeBridgeRequestOwners.has(requestId)) {
    throw new Error(`A request with id ${requestId} is already running.`);
  }
  if (event) monitorBridgeSender(event.sender);
  const owner = { model, senderId: event?.sender.id ?? -1, kind };
  activeBridgeRequestOwners.set(requestId, owner);
  return owner;
}

function releaseBridgeRequestOwner(requestId: string, owner: ActiveBridgeRequestOwner): void {
  if (activeBridgeRequestOwners.get(requestId) === owner) {
    activeBridgeRequestOwners.delete(requestId);
  }
  cancelledBridgeRequests.delete(requestId);
}

function getWebSocketBridgeWorkers(): WebSocketBridgeWorkerPool<LocalModel> {
  assertBridgeAcceptingRequests();
  if (!webSocketBridgeWorkers) {
    webSocketBridgeWorkers = createWebSocketBridgeWorkerPool<LocalModel>({
      idleEvictMs: (model) => (
        model === "qwen3"
          ? QWEN3_BRIDGE_WORKER_IDLE_EVICT_MS
          : RUST_BRIDGE_WORKER_IDLE_EVICT_MS
      ),
      killGraceMs: RUST_CANCEL_KILL_AFTER_MS,
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
            cwd: cacheDir,
          },
        ),
    });
  }
  return webSocketBridgeWorkers;
}

async function sanitizeLocalBridgeRequest(
  action: BridgeAction,
  request: unknown,
): Promise<ValidatedLocalBridgeRequest> {
  if (!isRecord(request)) throw new Error("Invalid IPC request payload.");
  const model = assertLocalModel(String(request.model));
  const requestId = parseRequestId(request.requestId, { required: true });
  const payload = action === "generate"
    ? sanitizeGeneratePayload(model, request.payload, process.platform, process.arch)
    : {};
  const continuation = action === "generate"
    ? sanitizeGenerationContinuation(request.continuation)
    : undefined;

  if (action === "generate" && model === "qwen3") {
    const profile = getQwen3Profile(String(payload.modelRepo));
    const modelPath = String(payload.modelPath);
    if (!profile || !(await isStructurallyValidQwen3ModelDir(modelPath, profile))) {
      throw new Error("The selected Qwen3 model directory is missing required files or does not match the selected profile.");
    }
  }

  return { model, requestId, payload, ...(continuation ? { continuation } : {}) };
}

function getCacheDir(model: LocalModel): string {
  return path.join(app.getPath("userData"), "local-model-cache", model);
}

function getRustBridgeBinaryName(): string {
  return process.platform === "win32" ? "open-tts-local-bridge.exe" : "open-tts-local-bridge";
}

function getHfXetDownloaderBinaryName(): string {
  return process.platform === "win32" ? "open-tts-hf-xet-downloader.exe" : "open-tts-hf-xet-downloader";
}

function getRustBridgeBinaryPath(): string {
  const binaryName = getRustBridgeBinaryName();
  if (isDev) {
    return path.join(app.getAppPath(), "dist-rust", binaryName);
  }
  return path.join(process.resourcesPath, "dist-rust", binaryName);
}

function getHfXetDownloaderBinaryPath(): string {
  const binaryName = getHfXetDownloaderBinaryName();
  if (isDev) return path.join(app.getAppPath(), "dist-rust", binaryName);
  return path.join(process.resourcesPath, "dist-rust", binaryName);
}

function shouldForwardRustBridgeEnv(key: string): boolean {
  return [
    "CUDA_",
    "HF_",
    "HUGGINGFACE_",
    "OPEN_TTS_NEUCODEC_",
    "TTS_",
  ].some((prefix) => key.startsWith(prefix))
    || [
      "HOME",
      "LANG",
      "LC_ALL",
      "LOGNAME",
      "PATH",
      "REQUESTS_CA_BUNDLE",
      "SSL_CERT_FILE",
      "SHELL",
      "SystemRoot",
      "TEMP",
      "TMP",
      "TMPDIR",
      "USER",
      "USERPROFILE",
      "WINDIR",
    ].includes(key);
}

function buildRustBridgeEnv(cacheDir: string): NodeJS.ProcessEnv {
  const hfHome = path.join(cacheDir, "huggingface");
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && shouldForwardRustBridgeEnv(key)) {
      env[key] = value;
    }
  }

  env.HF_HOME = hfHome;
  env.HF_HUB_CACHE = path.join(hfHome, "hub");
  env.HUGGINGFACE_HUB_CACHE = path.join(hfHome, "hub");

  return env;
}

function getQwen3ModelDir(profile: Qwen3Profile): string {
  const dirName = profile.repo.split("/").at(-1);
  if (!dirName || !/^[A-Za-z0-9._-]+$/.test(dirName)) throw new Error("Invalid Qwen3 model repository.");
  return path.join(getCacheDir("qwen3"), profile.provider, `${dirName}-${profile.revision.slice(0, 12)}`);
}

function getLegacyQwen3ModelDir(profile: Qwen3Profile): string {
  const dirName = profile.repo.split("/").at(-1);
  if (!dirName || !/^[A-Za-z0-9._-]+$/.test(dirName)) throw new Error("Invalid Qwen3 model repository.");
  return path.join(getCacheDir("qwen3"), profile.provider, dirName);
}

async function resolveQwen3ModelDir(profile: Qwen3Profile): Promise<string> {
  return adoptLegacyQwen3ModelDir(profile, getQwen3ModelDir(profile), getLegacyQwen3ModelDir(profile));
}

function getRequestedQwen3Profile(request: unknown): Qwen3Profile {
  const repo = isRecord(request) && typeof request.modelRepo === "string"
    ? request.modelRepo.trim()
    : getDefaultQwen3Profile(process.platform, process.arch).repo;
  const profile = getQwen3Profile(repo);
  if (!profile || !qwen3ProfileSupportsRuntime(profile, process.platform, process.arch)) {
    throw new Error("Unsupported Qwen3 model profile for this platform.");
  }
  return profile;
}

const qwen3ModelDownloads = createQwen3ModelDownloadCoordinator(
  (profile, modelDir, onProgress, _request, _xetDownloader, signal) => downloadQwen3Model(
    profile,
    modelDir,
    onProgress,
    requestUrl,
    ({ revision, fileName, destination, onProgress: reportFileProgress, signal }) => runHfXetDownloader({
      binaryPath: getHfXetDownloaderBinaryPath(),
      modelRepo: profile.repo,
      revision,
      fileName,
      destination,
      onProgress: reportFileProgress,
      signal,
    }),
    signal,
  ),
);

async function handleQwen3Setup(request: unknown): Promise<{
  provider: Qwen3Profile["provider"];
  profiles: Array<Qwen3Profile & { modelDir: string; readiness: "missing" | "structural" | "verified"; reason?: string }>;
  recommendedModelRepo: string;
  recommendedModelDir: string;
}> {
  return localModelLifecycle.run("qwen3", async (signal) => {
  const selected = getRequestedQwen3Profile(request);
  // Adoption may rename a model directory. Join every branch before releasing
  // the lifecycle lease, including when another profile fails or is cancelled.
  const inspections = await Promise.allSettled(getQwen3Profiles(process.platform, process.arch).map(async (profile) => {
    const modelDir = await resolveQwen3ModelDir(profile);
    const inspection = await inspectQwen3ModelDir(modelDir, profile, signal);
    return { ...profile, modelDir, ...inspection };
  }));
  const profiles = inspections.map((inspection) => {
    if (inspection.status === "rejected") throw inspection.reason;
    return inspection.value;
  });
  return {
    provider: selected.provider,
    profiles,
    recommendedModelRepo: selected.repo,
    recommendedModelDir: await resolveQwen3ModelDir(selected),
  };
  });
}

async function handleDownloadQwen3Model(
  request: unknown,
  event: IpcMainInvokeEvent,
): Promise<Qwen3ModelDownloadResult> {
  assertBridgeAcceptingRequests();
  return localModelLifecycle.run("qwen3", async (signal) => {
  const profile = getRequestedQwen3Profile(request);
  const modelDir = await resolveQwen3ModelDir(profile);
  const download = qwen3ModelDownloads.download(
    profile,
    modelDir,
    createSafeProgressSender(event.sender, "local-tts:qwen3-download-progress"),
    signal,
  );
  return download;
  });
}

async function handleChooseQwen3ModelDir(request: unknown): Promise<{
  path: string | null;
  readiness?: "missing" | "structural" | "verified";
  reason?: string;
}> {
  const profile = getRequestedQwen3Profile(request);
  const result = await dialog.showOpenDialog({
    title: "Choose Qwen3 model directory",
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { path: null };
  }
  const modelPath = result.filePaths[0];
  const inspection = await inspectQwen3ModelDir(modelPath, profile);
  if (inspection.readiness === "missing") return { path: modelPath, ...inspection };
  return {
    path: modelPath,
    readiness: "structural",
    reason: "The selected manual folder passed structural checks but is not a managed, revision-verified download.",
  };
}

function terminateBridgeChild(child: ChildProcessWithoutNullStreams): void {
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
  }, RUST_CANCEL_KILL_AFTER_MS).unref();
}

async function runRustBridge(
  action: BridgeAction,
  request: unknown,
  event?: IpcMainInvokeEvent,
): Promise<unknown> {
  assertBridgeAcceptingRequests();
  if (!isRecord(request)) throw new Error("Invalid IPC request payload.");
  const requestedModel = assertLocalModel(String(request.model));
  const requestedId = parseRequestId(request.requestId, { required: true })!;
  const owner = registerBridgeRequestOwner(requestedId, requestedModel, action, event);
  try {
  return await localModelLifecycle.run(requestedModel, async (signal) => {
  const cancel = () => {
    cancelledBridgeRequests.add(requestedId);
    cancelBridgeRequestNow(requestedId);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
  const sanitized = await sanitizeLocalBridgeRequest(action, request);
  if (cancelledBridgeRequests.has(requestedId)) throw new Error("Generation cancelled.");
  const model = sanitized.model;
  const cacheDir = getCacheDir(model);
  const bridgeBinary = getRustBridgeBinaryPath();
  const requestId = sanitized.requestId;

  const runWebSocketGenerate = async (): Promise<unknown> => {
    const generateRequestId = requestId!; // generate always carries a requestId.

    // Until the request registers with the worker pool (synchronously inside
    // run()), a cancel can only find it here. Keep the entry alive across the
    // whole pre-pool window (fs waits, warm-up handoff) so a cancel in that
    // window records intent instead of returning { cancelled: false }.
    warmWaiters.set(generateRequestId, model);
    let runPromise: Promise<{ response: unknown }>;
    try {
      await fs.access(bridgeBinary);
      await fs.mkdir(cacheDir, { recursive: true });
      if (cancelledBridgeRequests.has(generateRequestId)) {
        throw new Error("Generation cancelled.");
      }

      const generateWarmTarget = warmTargetKey(model, sanitized.payload);
      for (;;) {
        const pendingWarm = pendingWarmups.get(model);
        if (!pendingWarm) break;
        if (pendingWarm.targetKey !== generateWarmTarget) {
          cancelPendingWarmup(pendingWarm);
        }
        await pendingWarm.promise;
      }
      if (cancelledWarmWaiters.has(generateRequestId)) {
        throw new Error("Generation cancelled.");
      }

    const onProgress = (payload: unknown) => {
      if (!event || event.sender.isDestroyed()) return;
      try {
        const progress = parseBridgeProgressResult(payload);
        event.sender.send("local-tts:progress", { requestId: generateRequestId, model, ...progress });
      } catch (err) {
        console.warn(
          `[local-tts:generate] Failed parsing WebSocket bridge progress: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };

    const onAudioChunk = (payload: {
      requestId: string;
      index: number;
      total: number;
      sampleRate: number;
      sampleCount: number;
      silenceAfterSamples: number;
      textUnitIndex?: number;
      textUnitTotal?: number;
      audio: ArrayBuffer;
    }) => {
      if (!event || event.sender.isDestroyed()) return;
      event.sender.send("local-tts:audio-chunk", { model, ...payload });
    };

      // run() registers the request with the pool synchronously, so once it
      // returns cancel is routed there; the warm-waiter entry can be dropped.
      runPromise = getWebSocketBridgeWorkers().run(model, {
        requestId: generateRequestId,
        payload: sanitized.payload,
        spawnConfig: { bridgeBinary, cacheDir, env: buildRustBridgeEnv(cacheDir) },
        idleTimeoutMs: RUST_BRIDGE_GENERATE_IDLE_TIMEOUT_MS,
        progressTimeoutMs: RUST_BRIDGE_GENERATE_PROGRESS_TIMEOUT_MS,
        maxStdoutBytes: RUST_BRIDGE_WS_DIAGNOSTIC_MAX_STDOUT_BYTES,
        maxStderrBytes: RUST_BRIDGE_WS_DIAGNOSTIC_MAX_STDERR_BYTES,
        onProgress,
        onAudioChunk,
      });
    } finally {
      warmWaiters.delete(generateRequestId);
      cancelledWarmWaiters.delete(generateRequestId);
    }
    const { response } = await runPromise;
    return parseBridgeEnvelopeResult(response);
  };

  // One-shot subprocess path, used only for `probe`: it runs to a single
  // absolute deadline and parses the stdout result envelope with
  // parseBridgeResult. The probe prints nothing but that result line.
  const runProbeBridge = async () => {
    await fs.access(bridgeBinary);
    await fs.mkdir(cacheDir, { recursive: true });
    if (cancelledBridgeRequests.has(requestId!)) throw new Error("Generation cancelled.");

    if (requestId && activeBridgeProcesses.has(requestId)) {
      throw new Error(`A request with id ${requestId} is already running.`);
    }

    return await new Promise((resolve, reject) => {
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
          env: buildRustBridgeEnv(cacheDir),
          cwd: cacheDir,
        },
      );

      if (requestId) {
        activeBridgeProcesses.set(requestId, child);
      }

      // Collected as fragments and joined once at close. Repeated `+=` on a
      // multi-megabyte string reallocates the whole buffer on every data event.
      const stdoutParts: string[] = [];
      const stderrParts: string[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;

      const timeoutMs = RUST_BRIDGE_TIMEOUT_MS;
      const onTimeout = () => {
        if (settled) return;
        settled = true;
        terminateBridgeChild(child);
        if (requestId) {
          activeBridgeProcesses.delete(requestId);
        }
        reject(new Error(`Local bridge timed out after ${timeoutMs / 1000}s.`));
      };
      const timeoutHandle = setTimeout(onTimeout, timeoutMs);

      const cleanup = () => {
        clearTimeout(timeoutHandle);
        if (requestId) {
          activeBridgeProcesses.delete(requestId);
        }
      };

      const rejectForOutputLimit = (streamName: "stdout" | "stderr", limitBytes: number) => {
        if (settled) return true;
        settled = true;
        terminateBridgeChild(child);
        cleanup();
        reject(new Error(`Local bridge ${streamName} exceeded ${limitBytes} bytes.`));
        return true;
      };

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > RUST_BRIDGE_WS_DIAGNOSTIC_MAX_STDOUT_BYTES) {
          rejectForOutputLimit("stdout", RUST_BRIDGE_WS_DIAGNOSTIC_MAX_STDOUT_BYTES);
          return;
        }
        stdoutParts.push(chunk.toString("utf-8"));
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > RUST_BRIDGE_WS_DIAGNOSTIC_MAX_STDERR_BYTES) {
          rejectForOutputLimit("stderr", RUST_BRIDGE_WS_DIAGNOSTIC_MAX_STDERR_BYTES);
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
            console.error(`[local-tts:${action}] Rust local bridge stderr\n${stderr}`);
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

      const payload = sanitized.payload;
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    });
  };

  return await (action === "generate"
    ? generateRateLimiter.run(model, runWebSocketGenerate, sanitized.continuation)
    : runProbeBridge());
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  });
  } finally {
    releaseBridgeRequestOwner(requestedId, owner);
  }
}

async function handleCacheInfo(request: unknown): Promise<LocalCacheInfo> {
  const { model } = sanitizeCacheRequest(request);
  const cachePath = getCacheDir(model);

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
}

async function handleClearCache(request: unknown): Promise<{ path: string; cleared: boolean }> {
  const { model } = sanitizeCacheRequest(request);
  const cachePath = getCacheDir(model);
  return localModelLifecycle.clear(model, async () => {
  await webSocketBridgeWorkers?.shutdown(model);
  await fs.rm(cachePath, { recursive: true, force: true });
  return { path: cachePath, cleared: true };
  });
}

// Pre-load the selected Qwen model in the resident Rust worker so the model's
// WebSocket worker so the first generation skips the model load. Failures
// degrade to `warmed: false` — warm-up must never surface an error the
// generation path would explain better.
async function handleWarm(
  request: unknown,
  event: IpcMainInvokeEvent,
): Promise<{ warmed: boolean; message?: string }> {
  assertBridgeAcceptingRequests();
  const { model, modelRepo, payload } = sanitizeWarmRequest(request, process.platform, process.arch);
  return localModelLifecycle.run(model, async (signal) => {
  const targetKey = warmTargetKey(model, { ...payload, ...(modelRepo ? { modelRepo } : {}) });
  for (;;) {
    const pendingWarm = pendingWarmups.get(model);
    if (!pendingWarm) break;
    if (pendingWarm.targetKey === targetKey) {
      return { warmed: false, message: "This model is already warming." };
    }
    cancelPendingWarmup(pendingWarm);
    await pendingWarm.promise;
  }
  if (signal.aborted) return { warmed: false, message: "Warm-up cancelled." };
  const warmRequestId = `${model}-warm-${randomUUID()}`;
  let resolveWarmCompletion!: () => void;
  const warmCompletion = new Promise<void>((resolve) => {
    resolveWarmCompletion = resolve;
  });
  const reservation = { requestId: warmRequestId, targetKey, promise: warmCompletion };
  pendingWarmups.set(model, reservation);
  const owner = registerBridgeRequestOwner(warmRequestId, model, "warm", event);
  const cancel = () => cancelPendingWarmup(reservation);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (model === "qwen3") {
      const profile = modelRepo ? getQwen3Profile(modelRepo) : undefined;
      const modelPath = String(payload.modelPath ?? "");
      if (!profile || !(await isStructurallyValidQwen3ModelDir(modelPath, profile))) {
        return { warmed: false, message: "The selected Qwen3 model directory is incomplete or incompatible." };
      }
    }
    if (cancelledBridgeRequests.has(warmRequestId)) {
      return { warmed: false, message: "Warm-up cancelled." };
    }

    const cacheDir = getCacheDir(model);
    const bridgeBinary = getRustBridgeBinaryPath();
    await fs.access(bridgeBinary);
    await fs.mkdir(cacheDir, { recursive: true });
    if (cancelledBridgeRequests.has(warmRequestId)) {
      return { warmed: false, message: "Warm-up cancelled." };
    }

    const runPromise = getWebSocketBridgeWorkers().run(model, {
      requestId: warmRequestId,
      payload,
      command: "warm",
      spawnConfig: { bridgeBinary, cacheDir, env: buildRustBridgeEnv(cacheDir) },
      idleTimeoutMs: RUST_BRIDGE_GENERATE_IDLE_TIMEOUT_MS,
      progressTimeoutMs: RUST_BRIDGE_GENERATE_PROGRESS_TIMEOUT_MS,
      maxStdoutBytes: RUST_BRIDGE_WS_DIAGNOSTIC_MAX_STDOUT_BYTES,
      maxStderrBytes: RUST_BRIDGE_WS_DIAGNOSTIC_MAX_STDERR_BYTES,
      onProgress: () => {},
      onAudioChunk: () => {},
    });
    const { response } = await runPromise;
    return parseBridgeWarmResult(response);
  } catch (err) {
    return { warmed: false, message: err instanceof Error ? err.message : String(err) };
  } finally {
    signal.removeEventListener("abort", cancel);
    resolveWarmCompletion();
    if (pendingWarmups.get(model) === reservation) pendingWarmups.delete(model);
    releaseBridgeRequestOwner(warmRequestId, owner);
  }
  });
}

async function handleCancel(
  request: unknown,
  event: IpcMainInvokeEvent,
): Promise<{ cancelled: boolean }> {
  const { model, requestId } = sanitizeCancelRequest(request);
  const owner = activeBridgeRequestOwners.get(requestId);
  if (!owner) return { cancelled: false };
  if (owner.model !== model || owner.senderId !== event.sender.id) {
    throw new Error("Cancellation request does not own the active local-runtime request.");
  }
  cancelledBridgeRequests.add(requestId);
  cancelBridgeRequestNow(requestId);
  return { cancelled: true };
}

// WebGPU powers all browser-native inference. Chromium still gates it behind this
// switch on Linux and on some blocklisted GPUs; Linux additionally needs Vulkan,
// which Electron does not enable on its own.
app.commandLine.appendSwitch("enable-unsafe-webgpu");
if (process.platform === "linux") {
  app.commandLine.appendSwitch("enable-features", "Vulkan");
}

app.whenReady().then(() => {
  configureApplicationMenu(process.platform, !isDev);
  registerSessionSecurity(windowOptions);
  createMainWindow(windowOptions);
  const ipc = createTrustedIpc(ipcMain, { allowDevServer: isDev });
  shutdown.register(registerReaderLibraryIpc(ipc, {
    workerPath: path.join(__dirname, "readerLibraryWorker.js"),
    databasePath: () => path.join(app.getPath("userData"), "reader-library.sqlite3"),
  }));
  shutdown.register(registerDocumentIpc(ipc, {
    parseWorkerPath: path.join(__dirname, "documentParseWorker.js"),
  }));
  shutdown.register(localRuntimeShutdown);
  shutdown.register(registerAudio8Ipc(ipc, { userDataPath: () => app.getPath("userData") }));

  ipc.handle("local-tts:probe", async (event, request) => {
    const probe = await runRustBridge("probe", request, event);
    return probe;
  });

  ipc.handle("local-tts:generate", (event, request) => {
    return runRustBridge("generate", request, event);
  });

  ipc.handle("local-tts:warm", (event, request) => {
    return handleWarm(request, event);
  });

  ipc.handle("local-tts:cancel", (event, request) => {
    return handleCancel(request, event);
  });

  ipc.handle("local-tts:cache-info", (_event, request) => {
    return handleCacheInfo(request);
  });

  ipc.handle("local-tts:clear-cache", (_event, request) => {
    return handleClearCache(request);
  });

  ipc.handle("local-tts:qwen3-setup", (_event, request) => {
    return handleQwen3Setup(request);
  });

  ipc.handle("local-tts:download-qwen3-model", (event, request) => {
    return handleDownloadQwen3Model(request, event);
  });

  ipc.handle("local-tts:choose-qwen3-model-dir", (_event, request) => {
    return handleChooseQwen3ModelDir(request);
  });

});

// Holds the quit for the worker pool shutdown and any one-shot probe children
// (SIGTERM + SIGKILL escalation), and for every lifecycle activity to unwind.
const localRuntimeShutdown: ShutdownParticipant = {
  name: "local-tts",
  beginShutdown() {
    bridgeShuttingDown = true;
    const localModelsBusy = localModelLifecycle.busy;
    const localModelsShutdown = localModelLifecycle.close();
    for (const requestId of activeBridgeRequestOwners.keys()) {
      cancelledBridgeRequests.add(requestId);
    }
    const probeChildren = [...activeBridgeProcesses.values()];
    for (const child of probeChildren) {
      terminateBridgeChild(child);
    }
    activeBridgeProcesses.clear();
    if (!webSocketBridgeWorkers && probeChildren.length === 0 && !localModelsBusy) return null;
    const probeExits = probeChildren.map((child) =>
      child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise<void>((resolve) => child.once("exit", () => resolve())),
    );
    return Promise.all([
      webSocketBridgeWorkers?.shutdownAll() ?? Promise.resolve(),
      ...probeExits,
      localModelsShutdown,
    ]);
  },
};

// The Reader flush is bounded by its own timeout, which this outer one caps.
const shutdown = createShutdownCoordinator({
  timeoutMs: RUST_CANCEL_KILL_AFTER_MS + 500,
  quit: () => app.quit(),
});
app.on("before-quit", (event) => shutdown.handleBeforeQuit(event));

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    // Re-create window on macOS dock click
    createMainWindow(windowOptions);
  }
});
