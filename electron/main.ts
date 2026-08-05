import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  session,
  shell,
  type IpcMainInvokeEvent,
  type MessagePortMain,
  type WebContents,
} from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { ELECTRON_APP_SCHEME, getElectronAppUrl, resolveElectronAppPath } from "./appProtocol";
import {
  MAX_IMPORT_PAGES,
  importDocumentFromDialog,
  type DocumentParser,
} from "./documentImport";
import { DocumentParseWorkerClient } from "./documentParseWorkerClient";
import { importRemoteDocument } from "./urlImport";
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
import {
  buildContentSecurityPolicy,
  DEV_SERVER_URL,
  isAllowedAppUrl,
  isSafeExternalUrl,
  shouldGrantPermission,
} from "./security";
import { ReaderLibraryWorkerClient } from "./readerLibraryWorkerClient";
import { getDirectorySizeBytes } from "./directorySize";
import {
  clearAudio8Cache,
  getAudio8ModelDir,
  pruneStaleAudio8Revisions,
  readAudio8CacheInfo,
} from "./audio8Cache";
import { AUDIO8_MAX_TEXT_CHARACTERS, isAudio8VoiceId } from "./audio8Model";
import { Audio8NativeClient } from "./audio8NativeClient";
import {
  BRIDGE_PROGRESS_PREFIX,
  assertLocalModel,
  assertTrustedIpcSender,
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
const EPUB_TRANSFER_CHUNK_BYTES = 1024 * 1024;
const EPUB_TRANSFER_TTL_MS = 60_000;

interface PendingEpubTransfer {
  senderId: number;
  bytes: Uint8Array;
  expires: ReturnType<typeof setTimeout>;
}

const pendingEpubTransfers = new Map<string, PendingEpubTransfer>();
let audio8NativeClient: Audio8NativeClient | null = null;
// Clearing or pruning the Audio8 cache unlinks hundreds of megabytes, so the
// quit has to hold for it the way it holds for the workers and bridge children;
// otherwise the process exits mid-`rm` and leaves a torn directory behind.
const activeAudio8CacheTasks = new Set<Promise<unknown>>();
// A clear stops the worker and only then unlinks the tree. Synthesis requests
// that land in between would start a fresh worker downloading into the very
// directory the `rm` is about to remove, so they wait this out first.
let audio8CacheClear: Promise<void> | null = null;

function getAudio8NativeClient(): Audio8NativeClient {
  // Guarded at the spawn point rather than in each handler, the way
  // `getWebSocketBridgeWorkers` is: a request that arrives mid-quit would
  // otherwise start a thread that memory-maps ~572 MiB and races the
  // `destroy()` the shutdown barrier is already waiting on.
  if (bridgeShuttingDown) throw new Error("The local runtime is shutting down.");
  audio8NativeClient ??= new Audio8NativeClient(getAudio8ModelDir(app.getPath("userData")));
  return audio8NativeClient;
}

function trackAudio8CacheTask<T>(task: Promise<T>): Promise<T> {
  activeAudio8CacheTasks.add(task);
  void task.finally(() => activeAudio8CacheTasks.delete(task)).catch(() => undefined);
  return task;
}

function sendAudio8Progress(
  sender: Electron.WebContents,
  requestId: string,
  percent: number,
): void {
  try {
    if (!sender.isDestroyed()) sender.send("audio8:progress", { requestId, percent });
  } catch {
    // The window can be destroyed between the check and send. Progress is
    // advisory; closing a renderer must never turn it into a main-process error.
  }
}

// The inference worker keeps the ONNX graphs memory-mapped out of the revision
// directory, so it has to stop before the unlink — the same ordering
// `handleClearCache` uses for the bridge's WebSocket workers.
async function handleAudio8ClearCache(): Promise<{ path: string; cleared: boolean }> {
  const shutdown = audio8NativeClient?.destroy() ?? null;
  audio8NativeClient = null;
  await shutdown;
  return clearAudio8Cache(app.getPath("userData"));
}

function audio8RequestId(request: unknown): string {
  if (!isRecord(request) || typeof request.requestId !== "string" || !/^[a-zA-Z0-9._-]{1,128}$/.test(request.requestId)) {
    throw new TypeError("Invalid Audio8 request id.");
  }
  return request.requestId;
}

function stageEpubTransfer(senderId: number, bytes: Uint8Array): string {
  const id = randomUUID();
  const expires = setTimeout(() => pendingEpubTransfers.delete(id), EPUB_TRANSFER_TTL_MS);
  expires.unref();
  pendingEpubTransfers.set(id, { senderId, bytes, expires });
  return id;
}
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
// Renderers debounce Reader writes for up to a second, so the quit has to hold
// long enough for a flush round trip. The outer quit race
// (RUST_CANCEL_KILL_AFTER_MS + 500) still caps the total, so a renderer that
// never answers cannot stretch the shutdown past that budget.
const READER_LIBRARY_FLUSH_TIMEOUT_MS = 1_500;
const GENERATE_RATE_WINDOW_MS = 500;
// Generation reuses a resident WebSocket worker (load once, serve many). The
// worker is killed after this much idle time to release model memory; the next
// request transparently respawns it.
const RUST_BRIDGE_WORKER_IDLE_EVICT_MS = 5 * 60 * 1000;
// Qwen's MLX/Metal backend has a much larger working set than the CPU-oriented
// local runtimes. Keep its warm-start grace short so macOS can reclaim unified
// memory promptly after the user finishes a generation.
const QWEN3_BRIDGE_WORKER_IDLE_EVICT_MS = 60 * 1000;
// Local runtimes use the resident WebSocket worker for generation
// instead of the legacy stdout line-framed subprocess protocol. There is
// intentionally no stdout fallback for models in this set; generation is
// WebSocket-only, and `probe` is the only remaining one-shot subprocess action.
const WEBSOCKET_WORKER_MODELS: ReadonlySet<LocalModel> = new Set<LocalModel>(["neutts", "qwen3"]);
protocol.registerSchemesAsPrivileged([
  {
    scheme: ELECTRON_APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

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
const qwen3DownloadAbortController = new AbortController();
const activeQwenModelDownloads = new Set<Promise<unknown>>();
let readerLibraryWorker: ReaderLibraryWorkerClient | null = null;
let documentParser: DocumentParseWorkerClient | null = null;
// Tracked apart from `bridgeShuttingDown`: the quit asks every renderer to
// flush its debounced Reader writes first, so `reader-library:*` has to keep
// working after the local runtime has already been told to stop.
let readerLibraryShuttingDown = false;
const pendingReaderLibraryFlushes = new Map<string, () => void>();

function getReaderLibraryWorker(): ReaderLibraryWorkerClient {
  if (readerLibraryShuttingDown) throw new Error("Reader library is shutting down.");
  if (readerLibraryWorker) return readerLibraryWorker;
  const worker = new ReaderLibraryWorkerClient(
    path.join(__dirname, "readerLibraryWorker.js"),
    path.join(app.getPath("userData"), "reader-library.sqlite3"),
    () => {
      if (readerLibraryWorker === worker) readerLibraryWorker = null;
    },
  );
  readerLibraryWorker = worker;
  return worker;
}

function requestField(request: unknown, field: string): unknown {
  if (!isRecord(request) || !(field in request)) {
    throw new TypeError(`Reader library request is missing ${field}.`);
  }
  return request[field];
}

// Electron has already transferred the port into main by the time a stream
// handler runs, so every failure path has to answer on it and close it;
// otherwise the renderer waits out the full audio stream timeout.
function rejectStreamPort(port: MessagePortMain, message: string): void {
  port.postMessage({ type: "result", ok: false, error: message });
  port.close();
}

/**
 * Asks every open window to write out the Reader edits it is still holding
 * behind a debounce timer. `before-quit` blocks the quit, so those timers would
 * otherwise never fire and the edits would be lost without a trace.
 *
 * Resolves once every window has acknowledged or the timeout expires — a
 * renderer that is wedged or already gone must not strand the shutdown.
 */
function requestReaderLibraryFlush(): Promise<void> {
  const windows = BrowserWindow.getAllWindows();
  if (windows.length === 0) {
    // No renderer left to ask, but one that just closed may have posted its
    // `pagehide` writes already; give the IPC queue a turn before the worker
    // closes underneath them.
    return new Promise<void>((resolve) => { setImmediate(resolve); });
  }

  const acknowledgements = windows.map((window) => new Promise<void>((resolve) => {
    if (window.webContents.isDestroyed()) {
      resolve();
      return;
    }
    const token = randomUUID();
    pendingReaderLibraryFlushes.set(token, resolve);
    try {
      window.webContents.send("reader-library:flush", { token });
    } catch {
      // A window can be destroyed between the check and the send.
      pendingReaderLibraryFlushes.delete(token);
      resolve();
    }
  }));
  return Promise.race([
    Promise.all(acknowledgements).then(() => undefined),
    new Promise<void>((resolve) => { setTimeout(resolve, READER_LIBRARY_FLUSH_TIMEOUT_MS); }),
  ]).then(() => {
    pendingReaderLibraryFlushes.clear();
  });
}

// Latches the shutdown flag together with the close so no request can slip
// between the two and reach a worker that is already draining.
function closeReaderLibraryWorker(): Promise<void> {
  readerLibraryShuttingDown = true;
  const worker = readerLibraryWorker;
  readerLibraryWorker = null;
  return worker?.close() ?? Promise.resolve();
}

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

function createMainWindow() {
  const isMac = process.platform === "darwin";
  const win = new BrowserWindow({
    title: "Open TTS",
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 600,
    // Transparent on macOS so the native vibrancy material shows through and
    // the translucent UI panels read as real Liquid Glass over the desktop.
    backgroundColor: isMac ? "#00000000" : "#f5f5f7",
    ...(isMac
      ? {
          vibrancy: "under-window" as const,
          visualEffectState: "active" as const,
          titleBarStyle: "hiddenInset" as const,
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // The playback clock, chunk scheduler, end-of-stream detection and Reader
      // auto-advance all run off requestAnimationFrame. Chromium throttles rAF
      // and timers hard once the window is hidden or occluded, which is exactly
      // what a listener does with a text-to-speech reader — so opt out.
      backgroundThrottling: false,
    },
  });

  const target = isDev ? `${DEV_SERVER_URL}/desktop/studio` : getElectronAppUrl("/studio");
  // loadURL rejects on a navigation abort (e.g. the window is closed mid-load);
  // attach a handler so it is logged rather than surfacing as an unhandled
  // rejection on the main process.
  win.loadURL(target).catch((err) => {
    console.error(`Failed to load ${target}:`, err);
  });
}

function registerRendererSecurityHeaders() {
  session.defaultSession.webRequest.onHeadersReceived(
    {
      urls: [`${ELECTRON_APP_SCHEME}://*/*`, `${DEV_SERVER_URL}/*`],
    },
    (details, callback) => {
      const isHtmlDocument = details.resourceType === "mainFrame";
      const responseHeaders = {
        ...(details.responseHeaders ?? {}),
        "Cross-Origin-Opener-Policy": ["same-origin"],
        "Cross-Origin-Embedder-Policy": ["require-corp"],
        ...(isHtmlDocument
          ? { "Content-Security-Policy": [buildContentSecurityPolicy(isDev)] }
          : {}),
      };

      callback({ cancel: false, responseHeaders });
    },
  );
}

function registerProductionAppProtocol() {
  if (isDev) return;

  const distDir = path.join(__dirname, "../dist");
  protocol.handle(ELECTRON_APP_SCHEME, (request) => {
    try {
      const resolvedPath = resolveElectronAppPath(distDir, request.url);
      return net.fetch(pathToFileURL(resolvedPath).toString());
    } catch {
      return new Response("Forbidden", { status: 403 });
    }
  });
}

function registerNavigationSecurityHandlers() {
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-navigate", (event, navigationUrl) => {
      if (isAllowedAppUrl(navigationUrl, { allowDevServer: isDev })) return;

      event.preventDefault();
      if (isSafeExternalUrl(navigationUrl)) {
        void shell.openExternal(navigationUrl);
      }
    });

    contents.setWindowOpenHandler(({ url }) => {
      if (isSafeExternalUrl(url)) {
        void shell.openExternal(url);
      }

      return { action: "deny" };
    });

    // The app never uses <webview>, so block attachment outright (security
    // checklist item 12: a webview can be created by page script even when
    // the embedder itself never renders one).
    contents.on("will-attach-webview", (event) => {
      event.preventDefault();
    });
  });
}

function registerPermissionHandlers() {
  // Deny every permission across all three gates: the async request flow, the
  // synchronous check flow (navigator.permissions.query, capability checks),
  // and device selection (WebUSB/Serial/HID). The Electron security checklist
  // requires wiring all of them, not just the request handler, so synchronous
  // checks don't fall through to permissive built-in defaults.
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(shouldGrantPermission());
  });
  session.defaultSession.setPermissionCheckHandler(() => shouldGrantPermission());
  session.defaultSession.setDevicePermissionHandler(() => shouldGrantPermission());
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
  (profile, modelDir, onProgress) => downloadQwen3Model(
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
    qwen3DownloadAbortController.signal,
  ),
);

async function handleQwen3Setup(request: unknown): Promise<{
  provider: Qwen3Profile["provider"];
  profiles: Array<Qwen3Profile & { modelDir: string; readiness: "missing" | "structural" | "verified"; reason?: string }>;
  recommendedModelRepo: string;
  recommendedModelDir: string;
}> {
  const selected = getRequestedQwen3Profile(request);
  const profiles = await Promise.all(getQwen3Profiles(process.platform, process.arch).map(async (profile) => {
    const modelDir = await resolveQwen3ModelDir(profile);
    const inspection = await inspectQwen3ModelDir(modelDir, profile);
    return { ...profile, modelDir, ...inspection };
  }));
  return {
    provider: selected.provider,
    profiles,
    recommendedModelRepo: selected.repo,
    recommendedModelDir: await resolveQwen3ModelDir(selected),
  };
}

async function handleDownloadQwen3Model(
  request: unknown,
  event: IpcMainInvokeEvent,
): Promise<Qwen3ModelDownloadResult> {
  assertBridgeAcceptingRequests();
  assertTrustedIpcSender(event, { allowDevServer: isDev });
  const profile = getRequestedQwen3Profile(request);
  const modelDir = await resolveQwen3ModelDir(profile);
  const download = qwen3ModelDownloads.download(
    profile,
    modelDir,
    createSafeProgressSender(event.sender, "local-tts:qwen3-download-progress"),
  );
  activeQwenModelDownloads.add(download);
  void download.then(
    () => activeQwenModelDownloads.delete(download),
    () => activeQwenModelDownloads.delete(download),
  );
  return download;
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

// OCR and document conversion run in a one-shot worker thread. Terminating the
// worker at the deadline stops native parser CPU work as well as unblocking the
// renderer, and releasing it after each import prevents LiteParse/native state
// from becoming part of the Electron main process's permanent footprint.
const IMPORT_PARSE_TIMEOUT_MS = 5 * 60 * 1000;

function getLiteParseDocumentParser(): Promise<DocumentParser> {
  if (!documentParser) {
    documentParser = new DocumentParseWorkerClient(
      path.join(__dirname, "documentParseWorker.js"),
      IMPORT_PARSE_TIMEOUT_MS,
      MAX_IMPORT_PAGES,
    );
  }
  return Promise.resolve(documentParser);
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
  const sanitized = await sanitizeLocalBridgeRequest(action, request);
  if (cancelledBridgeRequests.has(requestedId)) throw new Error("Generation cancelled.");
  const model = sanitized.model;
  const cacheDir = getCacheDir(model);
  const bridgeBinary = getRustBridgeBinaryPath();
  const shouldRateLimit = action === "generate";
  const requestId = sanitized.requestId;
  // Generation for every local runtime runs on a resident WebSocket worker
  // (load once, serve many). Probe keeps the one-shot subprocess path below.
  const useWebSocketWorker = action === "generate" && WEBSOCKET_WORKER_MODELS.has(model);

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
    return parseBridgeEnvelopeResult(response, "generate");
  };

  // One-shot subprocess path. With generation served by the WebSocket worker
  // pool, this is only ever reached for `probe`: it runs to a single absolute
  // deadline and parses the stdout result envelope with parseBridgeResult.
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
          action,
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
      let stdoutLineBuffer = "";
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
        const text = chunk.toString("utf-8");
        stdoutParts.push(text);
        stdoutLineBuffer += text;

        const lines = stdoutLineBuffer.split(/\r?\n/);
        stdoutLineBuffer = lines.pop() ?? "";

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith(BRIDGE_PROGRESS_PREFIX) || !requestId || !event) continue;

          try {
            const progress = parseBridgeProgressResult(JSON.parse(line.slice(BRIDGE_PROGRESS_PREFIX.length)));
            event.sender.send("local-tts:progress", {
              requestId,
              model,
              ...progress,
            });
          } catch (err) {
            console.warn(
              `[local-tts:${action}] Failed parsing bridge progress: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
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
          resolve(parseBridgeResult(stdoutParts.join(""), stderr, action));
        } catch (err) {
          reject(err);
        }
      });

      const payload = sanitized.payload;
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    });
  };

  const task = useWebSocketWorker ? runWebSocketGenerate : runProbeBridge;
  return await (shouldRateLimit
    ? generateRateLimiter.run(model, task, sanitized.continuation)
    : task());
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
  await webSocketBridgeWorkers?.shutdown(model);
  await fs.rm(cachePath, { recursive: true, force: true });
  return { path: cachePath, cleared: true };
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
  const warmRequestId = `${model}-warm-${randomUUID()}`;
  let resolveWarmCompletion!: () => void;
  const warmCompletion = new Promise<void>((resolve) => {
    resolveWarmCompletion = resolve;
  });
  const reservation = { requestId: warmRequestId, targetKey, promise: warmCompletion };
  pendingWarmups.set(model, reservation);
  const owner = registerBridgeRequestOwner(warmRequestId, model, "warm", event);
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
    resolveWarmCompletion();
    if (pendingWarmups.get(model) === reservation) pendingWarmups.delete(model);
    releaseBridgeRequestOwner(warmRequestId, owner);
  }
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
  if (!isDev) {
    Menu.setApplicationMenu(null);
  }
  registerProductionAppProtocol();
  registerRendererSecurityHeaders();
  registerNavigationSecurityHandlers();
  registerPermissionHandlers();
  createMainWindow();

  ipcMain.handle("reader-library:list-documents", (event) => {
    assertTrustedIpcSender(event, { allowDevServer: isDev });
    return getReaderLibraryWorker().request("listDocuments");
  });

  ipcMain.handle("reader-library:get-document", (event, request: unknown) => {
    assertTrustedIpcSender(event, { allowDevServer: isDev });
    return getReaderLibraryWorker().request("getDocument", [requestField(request, "id")]);
  });

  ipcMain.handle("reader-library:save-document", (event, request: unknown) => {
    assertTrustedIpcSender(event, { allowDevServer: isDev });
    return getReaderLibraryWorker().request("saveDocument", [requestField(request, "document")]);
  });

  ipcMain.handle("reader-library:delete-document", (event, request: unknown) => {
    assertTrustedIpcSender(event, { allowDevServer: isDev });
    return getReaderLibraryWorker().request("deleteDocument", [requestField(request, "id")]);
  });

  ipcMain.handle("reader-library:get-active-document-id", (event) => {
    assertTrustedIpcSender(event, { allowDevServer: isDev });
    return getReaderLibraryWorker().request("getActiveDocumentId");
  });

  ipcMain.handle("reader-library:set-active-document-id", (event, request: unknown) => {
    assertTrustedIpcSender(event, { allowDevServer: isDev });
    return getReaderLibraryWorker().request("setActiveDocumentId", [requestField(request, "id")]);
  });

  ipcMain.on("reader-library:save-audio-stream", (event, request: unknown) => {
    const port = event.ports[0];
    if (!port) return;
    try {
      assertTrustedIpcSender(event, { allowDevServer: isDev });
    } catch {
      // This throws only for an untrusted sender, so close the port without
      // telling that sender anything about why it was rejected.
      port.close();
      return;
    }
    if (readerLibraryShuttingDown) {
      rejectStreamPort(port, "Reader library is shutting down.");
      return;
    }
    if (!isRecord(request)) {
      rejectStreamPort(port, "Invalid Reader audio stream request.");
      return;
    }
    try {
      getReaderLibraryWorker().saveAudio(port, request.metadata, request.chunkCount);
    } catch (err) {
      rejectStreamPort(port, err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.on("reader-library:get-audio-stream", (event, request: unknown) => {
    const port = event.ports[0];
    if (!port) return;
    try {
      assertTrustedIpcSender(event, { allowDevServer: isDev });
    } catch {
      // This throws only for an untrusted sender, so close the port without
      // telling that sender anything about why it was rejected.
      port.close();
      return;
    }
    if (readerLibraryShuttingDown) {
      rejectStreamPort(port, "Reader library is shutting down.");
      return;
    }
    if (!isRecord(request)) {
      rejectStreamPort(port, "Invalid Reader audio lookup request.");
      return;
    }
    try {
      getReaderLibraryWorker().getAudio(port, request.documentId, request.sectionId);
    } catch (err) {
      rejectStreamPort(port, err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.on("reader-library:flush-complete", (event, request: unknown) => {
    try {
      assertTrustedIpcSender(event, { allowDevServer: isDev });
    } catch {
      return;
    }
    if (!isRecord(request) || typeof request.token !== "string") return;
    const acknowledge = pendingReaderLibraryFlushes.get(request.token);
    if (!acknowledge) return;
    pendingReaderLibraryFlushes.delete(request.token);
    acknowledge();
  });

  ipcMain.handle("reader-library:delete-audio", (event, request: unknown) => {
    assertTrustedIpcSender(event, { allowDevServer: isDev });
    if (!isRecord(request)) throw new TypeError("Invalid Reader library audio deletion request.");
    return getReaderLibraryWorker().request("deleteAudio", [request.documentId, request.sectionId]);
  });

  ipcMain.handle("local-tts:probe", async (event, request: unknown) => {
    assertTrustedIpcSender(event, { allowDevServer: isDev });
    const probe = await runRustBridge("probe", request, event);
    return probe;
  });

  ipcMain.handle("local-tts:generate", (event, request: unknown) => {
    assertTrustedIpcSender(event, { allowDevServer: isDev });
    return runRustBridge("generate", request, event);
  });

  ipcMain.handle("local-tts:warm", (event, request: unknown) => {
    assertTrustedIpcSender(event, { allowDevServer: isDev });
    return handleWarm(request, event);
  });

  ipcMain.handle("local-tts:cancel", (event, request: unknown) => {
    assertTrustedIpcSender(event, { allowDevServer: isDev });
    return handleCancel(request, event);
  });

  ipcMain.handle("local-tts:cache-info", (event, request: unknown) => {
    assertTrustedIpcSender(event, { allowDevServer: isDev });
    return handleCacheInfo(request);
  });

  ipcMain.handle("local-tts:clear-cache", (event, request: unknown) => {
    assertTrustedIpcSender(event, { allowDevServer: isDev });
    return handleClearCache(request);
  });

  ipcMain.handle("local-tts:qwen3-setup", (event, request: unknown) => {
    assertTrustedIpcSender(event, { allowDevServer: isDev });
    return handleQwen3Setup(request);
  });

  ipcMain.handle("local-tts:download-qwen3-model", (event, request: unknown) => {
    assertTrustedIpcSender(event, { allowDevServer: isDev });
    return handleDownloadQwen3Model(request, event);
  });

  ipcMain.handle("local-tts:choose-qwen3-model-dir", (event, request: unknown) => {
    assertTrustedIpcSender(event, { allowDevServer: isDev });
    return handleChooseQwen3ModelDir(request);
  });

  ipcMain.handle("audio8:load", async (event, request: unknown) => {
    assertTrustedIpcSender(event, { allowDevServer: isDev });
    const requestId = audio8RequestId(request);
    await audio8CacheClear;
    const result = await getAudio8NativeClient().load(requestId, (percent) => {
      sendAudio8Progress(event.sender, requestId, percent);
    });
    // A completed load is the only point where the current revision is known to
    // be fully downloaded and open, so pruning here can never be what leaves the
    // user without a usable model, and it provably touches nothing the worker
    // has mapped. Not awaited: reclaiming disk must not delay first synthesis.
    if (!bridgeShuttingDown) {
      void trackAudio8CacheTask(pruneStaleAudio8Revisions(app.getPath("userData")));
    }
    return result;
  });

  ipcMain.handle("audio8:generate", async (event, request: unknown) => {
    assertTrustedIpcSender(event, { allowDevServer: isDev });
    const requestId = audio8RequestId(request);
    if (!isRecord(request) || typeof request.text !== "string" || request.text.trim().length === 0 || [...request.text].length > AUDIO8_MAX_TEXT_CHARACTERS) {
      throw new TypeError("Invalid Audio8 synthesis text.");
    }
    // Rejected rather than substituted with the default voice: every other enum
    // on this boundary throws, and quietly rendering the whole request in a
    // voice the caller did not ask for is a wrong answer with nothing to show it.
    if (!isAudio8VoiceId(request.voice)) throw new TypeError("Unsupported Audio8 voice.");
    // Generation lazily fetches the voice profile into the model directory, so
    // it writes there too and has to clear the same gate as a load.
    await audio8CacheClear;
    return getAudio8NativeClient().generate(requestId, request.text, request.voice, (percent) => {
      sendAudio8Progress(event.sender, requestId, percent);
    });
  });

  ipcMain.handle("audio8:cancel", (event, request: unknown) => {
    assertTrustedIpcSender(event, { allowDevServer: isDev });
    const requestId = audio8RequestId(request);
    // Forwarded rather than assumed: `false` covers every way there is nothing
    // to stop — no worker built yet, the request already settled, or it was
    // never issued. Reporting `true` regardless told the renderer it had
    // stopped work that did not exist.
    return { cancelled: audio8NativeClient?.cancel(requestId) ?? false };
  });

  // Audio8 is not a `LocalModel`, so `local-tts:cache-info`/`clear-cache` cannot
  // address it; these report and reclaim the whole `audio8` namespace — every
  // revision, not just the current one — in the same shape.
  ipcMain.handle("audio8:cache-info", (event) => {
    assertTrustedIpcSender(event, { allowDevServer: isDev });
    return readAudio8CacheInfo(app.getPath("userData"));
  });

  ipcMain.handle("audio8:clear-cache", (event) => {
    assertTrustedIpcSender(event, { allowDevServer: isDev });
    // Join the existing gate before starting another teardown. Two windows can
    // press Clear independently; running both `rm`s at once can reopen the gate
    // while the first clear still owns the old worker.
    const previous = audio8CacheClear;
    const clear = trackAudio8CacheTask((async () => {
      // Do not yield when this is the first clear: it must claim and retire the
      // resident worker before a same-turn quit can race in and take it over.
      if (previous) await previous;
      return handleAudio8ClearCache();
    })());
    // The gate only carries timing — a failed clear still has to stop leaving
    // synthesis blocked — so it settles either way. The renderer learns the
    // outcome from `clear` itself.
    const gate = clear.then(() => undefined, () => undefined);
    audio8CacheClear = gate;
    void gate.then(() => {
      if (audio8CacheClear === gate) audio8CacheClear = null;
    });
    return clear;
  });

  ipcMain.handle("document:import", async (event) => {
    assertTrustedIpcSender(event, { allowDevServer: isDev });
    // Attach the dialog to the requesting window (macOS modal sheet), which
    // also blocks mid-import text edits behind the dialog.
    const owner = BrowserWindow.fromWebContents(event.sender);
    const ownedDialog = {
      showOpenDialog: (options: Parameters<typeof dialog.showOpenDialog>[0]) => (
        owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options)
      ),
    };
    const result = await importDocumentFromDialog(ownedDialog, getLiteParseDocumentParser);
    if (result.canceled || !result.epubBytes) return result;
    const { epubBytes, ...metadata } = result;
    return {
      ...metadata,
      epubTransferId: stageEpubTransfer(event.sender.id, epubBytes),
      epubByteLength: epubBytes.byteLength,
    };
  });

  ipcMain.on("document:read-epub", (event, request: unknown) => {
    assertTrustedIpcSender(event, { allowDevServer: isDev });
    const port = event.ports[0];
    if (!port || !isRecord(request) || typeof request.transferId !== "string") return;
    const transfer = pendingEpubTransfers.get(request.transferId);
    if (!transfer || transfer.senderId !== event.sender.id) {
      port.postMessage({ error: "The EPUB transfer expired. Import the file again." });
      port.close();
      return;
    }
    pendingEpubTransfers.delete(request.transferId);
    clearTimeout(transfer.expires);

    let offset = 0;
    const sendNextChunk = () => {
      if (offset >= transfer.bytes.byteLength) {
        port.postMessage({ done: true });
        port.close();
        return;
      }
      const end = Math.min(transfer.bytes.byteLength, offset + EPUB_TRANSFER_CHUNK_BYTES);
      // `slice` (not `subarray`) is deliberate: structured clone of a typed
      // array serialises its whole backing ArrayBuffer, so a view would copy the
      // entire EPUB on every chunk. MessagePortMain only accepts MessagePortMain
      // in its transfer list, so the clone copy itself cannot be avoided.
      port.postMessage({ offset, chunk: transfer.bytes.slice(offset, end) });
      offset = end;
      setImmediate(sendNextChunk);
    };
    sendNextChunk();
  });

  ipcMain.handle("document:import-url", (event, request: unknown) => {
    assertTrustedIpcSender(event, { allowDevServer: isDev });
    if (!isRecord(request) || typeof request.url !== "string" || request.url.length > 2048) {
      throw new Error("Invalid document URL.");
    }
    return importRemoteDocument(request.url);
  });
});

app.on("before-quit", (event) => {
  if (bridgeShuttingDown) return;
  bridgeShuttingDown = true;
  // The renderers are still alive here and the quit below holds them open, so
  // collect their debounced Reader edits before the worker stops accepting
  // work; closing it first is what silently dropped the last edit.
  let readerLibraryShutdown: Promise<void> | null = null;
  if (readerLibraryWorker || BrowserWindow.getAllWindows().length > 0) {
    readerLibraryShutdown = requestReaderLibraryFlush()
      .then(closeReaderLibraryWorker, closeReaderLibraryWorker);
  } else {
    readerLibraryShuttingDown = true;
  }
  documentParser?.close();
  documentParser = null;
  qwen3DownloadAbortController.abort();
  for (const requestId of activeBridgeRequestOwners.keys()) {
    cancelledBridgeRequests.add(requestId);
  }
  const probeChildren = [...activeBridgeProcesses.values()];
  const modelDownloads = [...activeQwenModelDownloads];
  const audio8Shutdown = audio8NativeClient?.destroy() ?? null;
  audio8NativeClient = null;
  // Snapshot rather than drain: `bridgeShuttingDown` above already stops new
  // prunes being scheduled, and a clear-cache invoked from a renderer that is
  // about to close still has to finish its `rm`.
  const audio8CacheTasks = [...activeAudio8CacheTasks];
  for (const child of probeChildren) {
    terminateBridgeChild(child);
  }
  activeBridgeProcesses.clear();

  // Hold the quit until the worker pool shutdown and any one-shot probe
  // children (SIGTERM + SIGKILL escalation) have a bounded window to run;
  // otherwise the unref'd kill timers die with the process and a
  // SIGTERM-ignoring child survives.
  if (
    !webSocketBridgeWorkers
    && probeChildren.length === 0
    && modelDownloads.length === 0
    && !readerLibraryShutdown
    && !audio8Shutdown
    && audio8CacheTasks.length === 0
  ) return;
  event.preventDefault();
  const probeExits = probeChildren.map((child) =>
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => child.once("exit", () => resolve())),
  );
  const timeout = new Promise<void>((resolve) => {
    setTimeout(resolve, RUST_CANCEL_KILL_AFTER_MS + 500);
  });
  void Promise.race([
    Promise.all([
      webSocketBridgeWorkers?.shutdownAll() ?? Promise.resolve(),
      readerLibraryShutdown ?? Promise.resolve(),
      ...probeExits,
      Promise.allSettled(modelDownloads).then(() => undefined),
      audio8Shutdown ?? Promise.resolve(),
      Promise.allSettled(audio8CacheTasks).then(() => undefined),
    ]),
    timeout,
  ]).then(() => app.quit(), () => app.quit());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    // Re-create window on macOS dock click
    createMainWindow();
  }
});
