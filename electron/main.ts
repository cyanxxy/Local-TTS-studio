import { app, BrowserWindow, ipcMain, Menu, net, protocol, session, shell, type IpcMainInvokeEvent } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { ELECTRON_APP_SCHEME, getElectronAppUrl, resolveElectronAppPath } from "./appProtocol";
import { createGenerateRateLimiter } from "./generateRateLimiter";
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
import {
  BRIDGE_PROGRESS_PREFIX,
  assertLocalModel,
  assertTrustedIpcSender,
  isRecord,
  parseBridgeEnvelopeResult,
  parseBridgeProgressResult,
  parseBridgeResult,
  parseRequestId,
  sanitizeCacheRequest,
  sanitizeCancelRequest,
  sanitizeGeneratePayload,
  type BridgeAction,
  type LocalCacheInfo,
  type LocalModel,
  type ValidatedLocalBridgeRequest,
} from "./localTtsIpc";

const isDev = !app.isPackaged;
const RUST_BRIDGE_TIMEOUT_MS = 5 * 60 * 1000;
// Generation (model download + inference) can legitimately run for many minutes,
// so the WebSocket worker request uses an inactivity watchdog instead of an
// absolute deadline. The Rust bridge emits a periodic stderr heartbeat for the
// duration of each request, and any child output (stdout/stderr) or socket frame
// re-arms this timer, so it only fires when the worker goes fully silent (i.e. is
// genuinely stuck) rather than during a slow first-run download or CPU inference.
const RUST_BRIDGE_GENERATE_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const RUST_BRIDGE_MAX_STDOUT_BYTES = 125_000_000;
const RUST_BRIDGE_MAX_STDERR_BYTES = 1_000_000;
const RUST_CANCEL_KILL_AFTER_MS = 2_000;
const GENERATE_RATE_WINDOW_MS = 500;
// Generation reuses a resident WebSocket worker (load once, serve many). The
// worker is killed after this much idle time to release model memory; the next
// request transparently respawns it.
const RUST_BRIDGE_WORKER_IDLE_EVICT_MS = 5 * 60 * 1000;
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
const generateRateLimiter = createGenerateRateLimiter<LocalModel>({
  rateWindowMs: GENERATE_RATE_WINDOW_MS,
});
let webSocketBridgeWorkers: WebSocketBridgeWorkerPool<LocalModel> | null = null;

function getWebSocketBridgeWorkers(): WebSocketBridgeWorkerPool<LocalModel> {
  if (!webSocketBridgeWorkers) {
    webSocketBridgeWorkers = createWebSocketBridgeWorkerPool<LocalModel>({
      idleEvictMs: RUST_BRIDGE_WORKER_IDLE_EVICT_MS,
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
            "--auth-token",
            authToken,
          ],
          { stdio: ["pipe", "pipe", "pipe"], env, cwd: cacheDir },
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
    },
  });

  if (isDev) {
    win.loadURL(`${DEV_SERVER_URL}/desktop/studio`);
  } else {
    win.loadURL(getElectronAppUrl("/studio"));
  }
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
  });
}

function registerPermissionHandlers() {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(shouldGrantPermission());
  });
}

async function sanitizeLocalBridgeRequest(
  action: BridgeAction,
  request: unknown,
): Promise<ValidatedLocalBridgeRequest> {
  if (!isRecord(request)) throw new Error("Invalid IPC request payload.");
  const model = assertLocalModel(String(request.model));
  const requestId = action === "generate"
    ? parseRequestId(request.requestId, { required: true })
    : parseRequestId(request.requestId);
  const payload = action === "generate"
    ? sanitizeGeneratePayload(model, request.payload)
    : {};

  return { model, requestId, payload };
}

function getCacheDir(model: LocalModel): string {
  return path.join(app.getPath("userData"), "local-model-cache", model);
}

function getRustBridgeBinaryName(): string {
  return process.platform === "win32" ? "open-tts-local-bridge.exe" : "open-tts-local-bridge";
}

function getRustBridgeBinaryPath(): string {
  const binaryName = getRustBridgeBinaryName();
  if (isDev) {
    return path.join(app.getAppPath(), "dist-rust", binaryName);
  }
  return path.join(process.resourcesPath, "dist-rust", binaryName);
}

function shouldForwardRustBridgeEnv(key: string): boolean {
  return [
    "CUDA_",
    "HF_",
    "HUGGINGFACE_",
    "OPEN_TTS_",
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
  const sanitized = await sanitizeLocalBridgeRequest(action, request);
  const model = sanitized.model;
  const cacheDir = getCacheDir(model);
  const bridgeBinary = getRustBridgeBinaryPath();
  const shouldRateLimit = action === "generate";
  const requestId = sanitized.requestId;
  // Generation for every local runtime runs on a resident WebSocket worker
  // (load once, serve many). Probe keeps the one-shot subprocess path below.
  const useWebSocketWorker = action === "generate" && WEBSOCKET_WORKER_MODELS.has(model);

  const runWebSocketGenerate = async (): Promise<unknown> => {
    await fs.access(bridgeBinary);
    await fs.mkdir(cacheDir, { recursive: true });
    const generateRequestId = requestId!; // generate always carries a requestId.

    const onProgress = (payload: unknown) => {
      if (!event) return;
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
      audio: ArrayBuffer;
    }) => {
      if (!event) return;
      event.sender.send("local-tts:audio-chunk", { model, ...payload });
    };

    const { response } = await getWebSocketBridgeWorkers().run(model, {
      requestId: generateRequestId,
      payload: sanitized.payload,
      spawnConfig: { bridgeBinary, cacheDir, env: buildRustBridgeEnv(cacheDir) },
      idleTimeoutMs: RUST_BRIDGE_GENERATE_IDLE_TIMEOUT_MS,
      maxStdoutBytes: RUST_BRIDGE_MAX_STDOUT_BYTES,
      maxStderrBytes: RUST_BRIDGE_MAX_STDERR_BYTES,
      onProgress,
      onAudioChunk,
    });
    return parseBridgeEnvelopeResult(response, "generate");
  };

  // One-shot subprocess path. With generation served by the WebSocket worker
  // pool, this is only ever reached for `probe`: it runs to a single absolute
  // deadline and parses the stdout result envelope with parseBridgeResult.
  const runProbeBridge = async () => {
    await fs.access(bridgeBinary);
    await fs.mkdir(cacheDir, { recursive: true });

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

      let stdout = "";
      let stdoutLineBuffer = "";
      let stderr = "";
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
        if (stdoutBytes > RUST_BRIDGE_MAX_STDOUT_BYTES) {
          rejectForOutputLimit("stdout", RUST_BRIDGE_MAX_STDOUT_BYTES);
          return;
        }
        const text = chunk.toString("utf-8");
        stdout += text;
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
        if (stderrBytes > RUST_BRIDGE_MAX_STDERR_BYTES) {
          rejectForOutputLimit("stderr", RUST_BRIDGE_MAX_STDERR_BYTES);
          return;
        }
        stderr += chunk.toString("utf-8");
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

        if (code !== 0) {
          if (stderr.trim()) {
            console.error(`[local-tts:${action}] Rust local bridge stderr\n${stderr}`);
          }
          reject(new Error(stderr.trim() || `Rust local bridge exited with code ${code ?? "unknown"}.`));
          return;
        }

        try {
          resolve(parseBridgeResult(stdout, stderr, action));
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
  return shouldRateLimit
    ? generateRateLimiter.run(model, task)
    : task();
}

async function getDirectorySizeBytes(dirPath: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += await getDirectorySizeBytes(fullPath);
    } else if (entry.isFile()) {
      const stats = await fs.stat(fullPath);
      total += stats.size;
    }
  }));

  return total;
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

async function handleCancel(request: unknown): Promise<{ cancelled: boolean }> {
  const { requestId } = sanitizeCancelRequest(request);

  // Generation always runs on the WebSocket worker pool, so killing the worker
  // is the only generation cancel path: its exit rejects the in-flight request
  // as cancelled and the next request respawns. The activeBridgeProcesses
  // fallback only ever matches an in-flight probe subprocess.
  if (webSocketBridgeWorkers?.cancel(requestId)) {
    return { cancelled: true };
  }

  const child = activeBridgeProcesses.get(requestId);
  if (!child) {
    return { cancelled: false };
  }

  try {
    terminateBridgeChild(child);
  } catch {
    throw new Error("Failed to cancel local generation.");
  }

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

  ipcMain.handle("local-tts:probe", (event, request: unknown) => {
    assertTrustedIpcSender(event, { allowDevServer: isDev });
    return runRustBridge("probe", request, event);
  });

  ipcMain.handle("local-tts:generate", (event, request: unknown) => {
    assertTrustedIpcSender(event, { allowDevServer: isDev });
    return runRustBridge("generate", request, event);
  });

  ipcMain.handle("local-tts:cancel", (event, request: unknown) => {
    assertTrustedIpcSender(event, { allowDevServer: isDev });
    return handleCancel(request);
  });

  ipcMain.handle("local-tts:cache-info", (event, request: unknown) => {
    assertTrustedIpcSender(event, { allowDevServer: isDev });
    return handleCacheInfo(request);
  });

  ipcMain.handle("local-tts:clear-cache", (event, request: unknown) => {
    assertTrustedIpcSender(event, { allowDevServer: isDev });
    return handleClearCache(request);
  });
});

app.on("before-quit", () => {
  for (const child of activeBridgeProcesses.values()) {
    terminateBridgeChild(child);
  }
  activeBridgeProcesses.clear();
  void webSocketBridgeWorkers?.shutdownAll();
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
