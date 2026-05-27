import { app, BrowserWindow, ipcMain, net, protocol, session, shell, type IpcMainInvokeEvent } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { ELECTRON_APP_SCHEME, getElectronAppUrl, resolveElectronAppPath } from "./appProtocol";
import { createGenerateRateLimiter } from "./generateRateLimiter";
import {
  getPythonDependencyCheckSnippet,
  getVirtualEnvPythonCandidates,
  type PythonSearchContext,
} from "./pythonRuntime";
import { buildContentSecurityPolicy, DEV_SERVER_URL, isAllowedAppUrl, isSafeExternalUrl } from "./security";
import {
  BRIDGE_PROGRESS_PREFIX,
  assertLocalModel,
  assertTrustedIpcSender,
  extractUserFacingPythonProcessError,
  isRecord,
  parseBridgeProgressResult,
  parseBridgeResult,
  parseOptionalString,
  parseRequestId,
  sanitizeCacheRequest,
  sanitizeCancelRequest,
  sanitizeGeneratePayload,
  type BridgeAction,
  type LocalCacheInfo,
  type LocalModel,
  type PythonResolution,
  type ValidatedLocalBridgeRequest,
} from "./localTtsIpc";

const isDev = !app.isPackaged;
const PYTHON_BINARY_NAME_RE = /^(?:python(?:\d+(?:\.\d+)*)?|py)(?:\.exe)?$/i;
const PYTHON_BRIDGE_TIMEOUT_MS = 5 * 60 * 1000;
const GENERATE_RATE_WINDOW_MS = 500;
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

interface AutoPythonCandidate {
  binary: string;
  resolvedFrom: string;
}

const activeBridgeProcesses = new Map<string, ChildProcessWithoutNullStreams>();
const cancelledBridgeRequests = new Set<string>();
const generateRateLimiter = createGenerateRateLimiter<LocalModel>({
  rateWindowMs: GENERATE_RATE_WINDOW_MS,
});
const autoPythonBinaryCache = new Map<LocalModel, PythonResolution>();

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    win.loadURL(`${DEV_SERVER_URL}/studio`);
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
    const resolvedPath = resolveElectronAppPath(distDir, request.url);
    return net.fetch(pathToFileURL(resolvedPath).toString());
  });
}

function registerNavigationSecurityHandlers() {
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-navigate", (event, navigationUrl) => {
      if (isAllowedAppUrl(navigationUrl)) return;

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

function getPythonSearchContext(): PythonSearchContext {
  return {
    appPath: app.getAppPath(),
    cwd: process.cwd(),
    execPath: process.execPath,
    isPackaged: app.isPackaged,
    platform: process.platform,
    resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
  };
}

function getSearchRootLabel(root: string, searchContext: PythonSearchContext): string {
  const normalizedRoot = path.resolve(root);
  const normalizedAppPath = path.resolve(searchContext.appPath);
  const normalizedCwd = path.resolve(searchContext.cwd);
  const normalizedResourcesPath = searchContext.resourcesPath ? path.resolve(searchContext.resourcesPath) : undefined;
  const appParent = path.dirname(normalizedAppPath);
  const execDir = path.resolve(path.dirname(searchContext.execPath));

  if (normalizedRoot === normalizedAppPath) return "appPath";
  if (normalizedRoot === appParent) return "appParent";
  if (normalizedResourcesPath && normalizedRoot === normalizedResourcesPath) return "resourcesPath";
  if (normalizedRoot === normalizedCwd) return "cwd";
  if (searchContext.isPackaged && execDir.startsWith(normalizedRoot)) return "bundleAncestor";
  return normalizedRoot;
}

function getAutoPythonCandidates(model: LocalModel): AutoPythonCandidate[] {
  const candidates: AutoPythonCandidate[] = [];
  const searchContext = getPythonSearchContext();
  const append = (value: string | undefined, resolvedFrom: string) => {
    if (!value || candidates.some((candidate) => candidate.binary === value)) return;
    candidates.push({ binary: value, resolvedFrom });
  };

  const modelSpecificEnv = model === "neutts"
    ? process.env.TTS_NEUTTS_PYTHON_BIN
    : model === "qwen3"
      ? process.env.TTS_QWEN3_PYTHON_BIN
      : process.env.TTS_KANI_PYTHON_BIN;
  const modelSpecificEnvName = model === "neutts"
    ? "TTS_NEUTTS_PYTHON_BIN"
    : model === "qwen3"
      ? "TTS_QWEN3_PYTHON_BIN"
      : "TTS_KANI_PYTHON_BIN";

  append(modelSpecificEnv, modelSpecificEnvName);
  append(process.env.TTS_PYTHON_BIN, "TTS_PYTHON_BIN");

  const appendVenvCandidates = (envName: string) => {
    const roots = getVirtualEnvPythonCandidates(envName, searchContext);
    for (const candidate of roots) {
      const rootDir = path.dirname(path.dirname(path.dirname(candidate)));
      append(candidate, `${getSearchRootLabel(rootDir, searchContext)}:${envName}`);
    }
  };

  if (model === "neutts") {
    appendVenvCandidates(".venv-neutts");
    appendVenvCandidates(".venv313");
  } else if (model === "qwen3") {
    appendVenvCandidates(".venv-qwen3");
    appendVenvCandidates(".venv-qwen");
    appendVenvCandidates(".venv312");
  } else {
    appendVenvCandidates(".venv-kani");
    appendVenvCandidates(".venv313");
  }
  appendVenvCandidates(".venv");

  if (process.platform === "win32") {
    append("py", "system:py");
    append("python", "system:python");
  } else {
    append("python3.13", "system:python3.13");
    append("python3.12", "system:python3.12");
    append("python3.11", "system:python3.11");
    append("python3.10", "system:python3.10");
    append("python3", "system:python3");
    append("python", "system:python");
  }

  return candidates;
}

async function assertPythonExecutable(binary: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
      },
    });

    let output = "";
    const timeoutHandle = setTimeout(() => {
      child.kill();
      reject(new Error("Timed out while validating Python executable."));
    }, 8_000);

    const cleanup = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
    });
    child.on("error", (err) => {
      cleanup();
      reject(new Error(`Failed to execute Python binary: ${err.message}`));
    });
    child.on("close", (code) => {
      cleanup();
      if (code !== 0 || !/python/i.test(output)) {
        reject(new Error("Configured executable is not a valid Python interpreter."));
        return;
      }
      resolve();
    });
  });
}

async function assertPythonModelDependency(binary: string, model: LocalModel): Promise<void> {
  const snippet = getPythonDependencyCheckSnippet(model);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, ["-c", snippet], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
      },
    });

    let stderr = "";
    const timeoutHandle = setTimeout(() => {
      child.kill();
      reject(new Error("Timed out while validating Python packages."));
    }, 12_000);

    const cleanup = () => clearTimeout(timeoutHandle);

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", (err) => {
      cleanup();
      reject(new Error(`Failed to inspect Python runtime: ${err.message}`));
    });

    child.on("close", (code) => {
      cleanup();
      if (code === 0) {
        resolve();
        return;
      }
      const missing = model === "neutts"
        ? "neutts (Python 3.10-3.13)"
        : model === "qwen3"
          ? "qwen-tts"
          : "kani-tts-2";
      reject(new Error(`Interpreter is missing required package support for ${missing}. ${stderr.trim()}`.trim()));
    });
  });
}

async function validatePythonBinary(raw: string, fieldName: string): Promise<string> {
  if (raw.includes("\u0000")) throw new Error(`\`${fieldName}\` contains invalid characters.`);

  const hasPathSeparator = raw.includes("/") || raw.includes("\\");
  if (hasPathSeparator) {
    if (!path.isAbsolute(raw)) {
      throw new Error(`\`${fieldName}\` path must be absolute.`);
    }
    const executableName = path.basename(raw);
    if (!PYTHON_BINARY_NAME_RE.test(executableName)) {
      throw new Error(`Only Python executables are allowed for \`${fieldName}\`.`);
    }
    const stats = await fs.stat(raw);
    if (!stats.isFile()) throw new Error(`\`${fieldName}\` must point to a file.`);
  } else if (!PYTHON_BINARY_NAME_RE.test(raw)) {
    throw new Error(`\`${fieldName}\` must be python/python3/python3.x or py (Windows launcher).`);
  }

  await assertPythonExecutable(raw);
  return raw;
}

async function sanitizePythonBinary(
  input: unknown,
  model: LocalModel,
  { requireModelDependency }: { requireModelDependency: boolean },
): Promise<PythonResolution> {
  const explicit = parseOptionalString(input, "pythonBinary", { maxLength: 1024 });
  if (explicit) {
    return {
      pythonBinary: await validatePythonBinary(explicit, "pythonBinary"),
      resolvedFrom: "request",
    };
  }

  const cached = autoPythonBinaryCache.get(model);
  if (cached) {
    try {
      const validated = await validatePythonBinary(cached.pythonBinary, "pythonBinary");
      if (requireModelDependency) {
        await assertPythonModelDependency(validated, model);
      }
      return cached;
    } catch {
      autoPythonBinaryCache.delete(model);
    }
  }

  const candidates = getAutoPythonCandidates(model);
  for (const candidate of candidates) {
    try {
      const validated = await validatePythonBinary(candidate.binary, "pythonBinary");
      if (requireModelDependency) {
        await assertPythonModelDependency(validated, model);
      }
      const resolvedCandidate = {
        pythonBinary: validated,
        resolvedFrom: candidate.resolvedFrom,
      };
      autoPythonBinaryCache.set(model, resolvedCandidate);
      return resolvedCandidate;
    } catch {
      // Try next candidate.
    }
  }

  const recommendedEnv = model === "neutts"
    ? ".venv-neutts"
    : model === "qwen3"
      ? ".venv-qwen3"
      : ".venv313";
  const installHint = model === "neutts"
    ? "neutts"
    : model === "qwen3"
      ? "qwen-tts"
      : "kani-tts-2";
  const envHint = model === "neutts"
    ? "TTS_NEUTTS_PYTHON_BIN"
    : model === "qwen3"
      ? "TTS_QWEN3_PYTHON_BIN"
      : "TTS_KANI_PYTHON_BIN";
  throw new Error(
    `No usable Python runtime found for ${model}. Install ${installHint} in ${recommendedEnv}, set the Python executable in the app, or use ${envHint}.`,
  );
}

async function sanitizeLocalBridgeRequest(action: BridgeAction, request: unknown): Promise<ValidatedLocalBridgeRequest> {
  if (!isRecord(request)) throw new Error("Invalid IPC request payload.");
  const model = assertLocalModel(String(request.model));
  const requestId = action === "generate"
    ? parseRequestId(request.requestId, { required: true })
    : parseRequestId(request.requestId);
  const pythonResolution = await sanitizePythonBinary(request.pythonBinary, model, {
    requireModelDependency: action === "generate" && request.pythonBinary == null,
  });

  const payload = action === "generate"
    ? sanitizeGeneratePayload(model, request.payload)
    : {};

  return { model, requestId, pythonResolution, payload };
}

function getCacheDir(model: LocalModel): string {
  return path.join(app.getPath("userData"), "local-model-cache", model);
}

function getBridgeScriptPath(): string {
  if (isDev) {
    return path.join(app.getAppPath(), "python", "local_tts_bridge.py");
  }
  return path.join(process.resourcesPath, "python", "local_tts_bridge.py");
}

async function runPythonBridge(
  action: BridgeAction,
  request: unknown,
  event?: IpcMainInvokeEvent,
): Promise<unknown> {
  const sanitized = await sanitizeLocalBridgeRequest(action, request);
  const model = sanitized.model;
  const cacheDir = getCacheDir(model);
  const pythonBinary = sanitized.pythonResolution.pythonBinary;
  const scriptPath = getBridgeScriptPath();
  const shouldRateLimit = action === "generate";
  const requestId = sanitized.requestId;
  const runBridge = async () => {
    await fs.access(scriptPath);
    await fs.mkdir(cacheDir, { recursive: true });

    if (requestId && activeBridgeProcesses.has(requestId)) {
      throw new Error(`A request with id ${requestId} is already running.`);
    }

    return await new Promise((resolve, reject) => {
      const child = spawn(
        pythonBinary,
        [
          scriptPath,
          "--action",
          action,
          "--model",
          model,
          "--cache-dir",
          cacheDir,
        ],
        {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            PYTHONIOENCODING: "utf-8",
          },
        },
      );

      if (requestId) {
        activeBridgeProcesses.set(requestId, child);
      }

      let stdout = "";
      let stdoutLineBuffer = "";
      let stderr = "";
      let settled = false;

      const timeoutHandle = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        if (requestId) {
          activeBridgeProcesses.delete(requestId);
          cancelledBridgeRequests.delete(requestId);
        }
        reject(new Error(`Python bridge timed out after ${PYTHON_BRIDGE_TIMEOUT_MS / 1000}s.`));
      }, PYTHON_BRIDGE_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timeoutHandle);
        if (requestId) {
          activeBridgeProcesses.delete(requestId);
        }
      };

      child.stdout.on("data", (chunk: Buffer) => {
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
        stderr += chunk.toString("utf-8");
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`Failed to run Python: ${err.message}`));
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        const wasCancelled = requestId ? cancelledBridgeRequests.has(requestId) : false;
        cleanup();
        if (requestId) {
          cancelledBridgeRequests.delete(requestId);
        }

        if (wasCancelled) {
          reject(new Error("Generation cancelled."));
          return;
        }

        if (code !== 0) {
          if (stderr.trim()) {
            console.error(`[local-tts:${action}] Python stderr\n${stderr}`);
          }
          reject(new Error(extractUserFacingPythonProcessError(stderr, code)));
          return;
        }

        try {
          resolve(parseBridgeResult(stdout, stderr, action, sanitized.pythonResolution));
        } catch (err) {
          reject(err);
        }
      });

      const payload = sanitized.payload;
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    });
  };

  return shouldRateLimit
    ? generateRateLimiter.run(model, runBridge)
    : runBridge();
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
  await fs.rm(cachePath, { recursive: true, force: true });
  return { path: cachePath, cleared: true };
}

async function handleCancel(request: unknown): Promise<{ cancelled: boolean }> {
  const { requestId } = sanitizeCancelRequest(request);
  const child = activeBridgeProcesses.get(requestId);
  if (!child) {
    cancelledBridgeRequests.delete(requestId);
    return { cancelled: false };
  }

  cancelledBridgeRequests.add(requestId);
  activeBridgeProcesses.delete(requestId);

  try {
    child.kill();
  } catch {
    cancelledBridgeRequests.delete(requestId);
    throw new Error("Failed to cancel Python generation.");
  }

  return { cancelled: true };
}

// Enable WebGPU in Electron — it is off by default
app.commandLine.appendSwitch("enable-unsafe-webgpu");

app.whenReady().then(() => {
  registerProductionAppProtocol();
  registerRendererSecurityHeaders();
  registerNavigationSecurityHandlers();
  createMainWindow();

  ipcMain.handle("local-tts:probe", (event, request: unknown) => {
    assertTrustedIpcSender(event);
    return runPythonBridge("probe", request, event);
  });

  ipcMain.handle("local-tts:generate", (event, request: unknown) => {
    assertTrustedIpcSender(event);
    return runPythonBridge("generate", request, event);
  });

  ipcMain.handle("local-tts:cancel", (event, request: unknown) => {
    assertTrustedIpcSender(event);
    return handleCancel(request);
  });

  ipcMain.handle("local-tts:cache-info", (event, request: unknown) => {
    assertTrustedIpcSender(event);
    return handleCacheInfo(request);
  });

  ipcMain.handle("local-tts:clear-cache", (event, request: unknown) => {
    assertTrustedIpcSender(event);
    return handleClearCache(request);
  });
});

app.on("before-quit", () => {
  for (const child of activeBridgeProcesses.values()) {
    try {
      child.kill();
    } catch {
      // Ignore if the process already exited.
    }
  }
  activeBridgeProcesses.clear();
  cancelledBridgeRequests.clear();
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
