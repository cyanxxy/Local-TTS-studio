import { app, BrowserWindow, ipcMain, Menu, net, protocol, session, shell, type IpcMainInvokeEvent } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { ELECTRON_APP_SCHEME, getElectronAppUrl, resolveElectronAppPath } from "./appProtocol";
import { createGenerateRateLimiter } from "./generateRateLimiter";
import {
  createPersistentBridgeWorkerPool,
  type PersistentBridgeWorkerPool,
} from "./persistentBridgeWorker";
import {
  getBootstrapPythonCommandCandidates,
  getDefaultPythonRuntimeSetup,
  getManagedPythonVersionCheckSnippet,
  getPythonBridgePathEntries,
  getPythonDependencyCheckSnippet,
  getUvExecutableCandidates,
  getVirtualEnvPythonCandidates,
  getVirtualEnvPythonPath,
  type PythonCommandCandidate,
  type PythonSearchContext,
  type RuntimeSetupProfile,
} from "./pythonRuntime";
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
// Generation (model download + inference) can legitimately run for many minutes,
// so it uses an inactivity watchdog instead of an absolute deadline: the bridge
// emits a heartbeat while it works, and any output re-arms this timer. It only
// fires when the process goes fully silent (i.e. is genuinely stuck).
const PYTHON_BRIDGE_GENERATE_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const PYTHON_BOOTSTRAP_TIMEOUT_MS = 20 * 60 * 1000;
const PYTHON_EXECUTABLE_TIMEOUT_MS = 20_000;
const PYTHON_BRIDGE_MAX_STDOUT_BYTES = 125_000_000;
const PYTHON_BRIDGE_MAX_STDERR_BYTES = 1_000_000;
const PYTHON_BOOTSTRAP_MAX_OUTPUT_BYTES = 4_000_000;
const PYTHON_CANCEL_KILL_AFTER_MS = 2_000;
const GENERATE_RATE_WINDOW_MS = 500;
// Qwen3 generation reuses a resident worker (load once, serve many) so repeat
// generations skip the per-call Python/torch import, model load, and first-
// inference warmup. The worker is killed after this much idle time to release
// the model's memory; the next request transparently respawns it.
const PYTHON_BRIDGE_WORKER_IDLE_EVICT_MS = 5 * 60 * 1000;
// Local models served by a persistent worker instead of a one-shot subprocess.
// Scoped to Qwen3, whose load + warmup dominate its wall time; NeuTTS and Kani
// keep the one-shot path.
const PERSISTENT_WORKER_MODELS: ReadonlySet<LocalModel> = new Set<LocalModel>(["qwen3"]);
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

interface SystemDependencySetup {
  label: string;
  commands: string[];
  macHomebrewPackage?: string;
}

const activeBridgeProcesses = new Map<string, ChildProcessWithoutNullStreams>();
const cancelledBridgeRequests = new Set<string>();
const generateRateLimiter = createGenerateRateLimiter<LocalModel>({
  rateWindowMs: GENERATE_RATE_WINDOW_MS,
});
let persistentBridgeWorkers: PersistentBridgeWorkerPool<LocalModel> | null = null;

function getPersistentBridgeWorkers(): PersistentBridgeWorkerPool<LocalModel> {
  if (!persistentBridgeWorkers) {
    persistentBridgeWorkers = createPersistentBridgeWorkerPool<LocalModel>({
      idleEvictMs: PYTHON_BRIDGE_WORKER_IDLE_EVICT_MS,
      killGraceMs: PYTHON_CANCEL_KILL_AFTER_MS,
      spawn: (model, { pythonBinary, scriptPath, cacheDir, env }) =>
        spawn(
          pythonBinary,
          [scriptPath, "--action", "serve", "--model", model, "--cache-dir", cacheDir],
          { stdio: ["pipe", "pipe", "pipe"], env, cwd: cacheDir },
        ),
    });
  }
  return persistentBridgeWorkers;
}
const autoPythonBinaryCache = new Map<LocalModel, PythonResolution>();
const defaultPythonRuntimeSetupPromises = new Map<LocalModel, Promise<PythonResolution>>();
const dynamicPythonBridgePathEntries = new Set<string>();
let nvidiaGpuProbePromise: Promise<boolean> | null = null;

type RuntimeSetupProgress = (phase: string, message: string, startedAt?: number) => void;

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

function getSafePythonWorkingDirectory(): string {
  try {
    if (app.isReady()) {
      return app.getPath("userData");
    }
  } catch {
    // Fall back below if Electron paths are not available yet.
  }

  return path.dirname(process.execPath);
}

async function assertPythonExecutable(binary: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: buildPythonBridgeEnv(),
      cwd: getSafePythonWorkingDirectory(),
    });

    let output = "";
    const timeoutHandle = setTimeout(() => {
      child.kill();
      reject(new Error("Timed out while validating Python executable."));
    }, PYTHON_EXECUTABLE_TIMEOUT_MS);

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

async function getRuntimeSetupProfile(model: LocalModel): Promise<RuntimeSetupProfile> {
  return {
    platform: process.platform,
    arch: process.arch,
    hasNvidiaGpu: model === "qwen3" ? await hasNvidiaGpu() : false,
  };
}

async function assertPythonModelDependency(binary: string, model: LocalModel): Promise<void> {
  const profile = await getRuntimeSetupProfile(model);
  const snippet = getPythonDependencyCheckSnippet(model, profile);
  const timeoutMs = model === "qwen3" ? 90_000 : 12_000;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, ["-c", snippet], {
      stdio: ["ignore", "pipe", "pipe"],
      env: buildPythonBridgeEnv(),
      cwd: getSafePythonWorkingDirectory(),
    });

    let stderr = "";
    const timeoutHandle = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out while validating ${model} Python packages after ${timeoutMs / 1000}s.`));
    }, timeoutMs);

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

async function assertBootstrapPythonVersion(binary: string, pythonVersion: string): Promise<void> {
  await assertBootstrapPythonCommandVersion({ executable: binary, args: [], resolvedFrom: binary }, pythonVersion);
}

async function assertBootstrapPythonCommandVersion(
  command: PythonCommandCandidate,
  pythonVersion: string,
): Promise<void> {
  const snippet = getManagedPythonVersionCheckSnippet(pythonVersion);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.executable, [...command.args, "-c", snippet], {
      stdio: ["ignore", "pipe", "pipe"],
      env: buildPythonBridgeEnv(),
      cwd: getSafePythonWorkingDirectory(),
    });

    const timeoutHandle = setTimeout(() => {
      child.kill();
      reject(new Error("Timed out while checking Python version for runtime setup."));
    }, PYTHON_EXECUTABLE_TIMEOUT_MS);

    const cleanup = () => clearTimeout(timeoutHandle);
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
      reject(new Error(`Python ${pythonVersion} is required for managed runtime setup.`));
    });
  });
}

async function runPythonSetupCommand(binary: string, args: string[], description: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: buildPythonBridgeEnv(),
      cwd: getSafePythonWorkingDirectory(),
    });

    let output = "";
    let outputBytes = 0;
    let settled = false;
    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`${description} timed out after ${PYTHON_BOOTSTRAP_TIMEOUT_MS / 1000}s.`));
    }, PYTHON_BOOTSTRAP_TIMEOUT_MS);

    const cleanup = () => clearTimeout(timeoutHandle);
    const appendOutput = (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes <= PYTHON_BOOTSTRAP_MAX_OUTPUT_BYTES) {
        output += chunk.toString("utf-8");
      }
    };

    child.stdout.on("data", appendOutput);
    child.stderr.on("data", appendOutput);
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`${description} failed to start: ${err.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code === 0) {
        resolve(output);
        return;
      }

      const details = output.trim();
      reject(new Error(
        `${description} failed with exit code ${code}.${details ? `\n${details}` : ""}`,
      ));
    });
  });
}

function getDefaultRuntimeRoot(): string {
  return isDev
    ? process.cwd()
    : path.join(app.getPath("userData"), "python-runtimes");
}

async function findBootstrapPython(model: LocalModel, pythonVersion: string): Promise<PythonCommandCandidate> {
  for (const candidate of getBootstrapPythonCommandCandidates(model, pythonVersion, process.platform)) {
    try {
      const validated = await validatePythonBinary(candidate.executable, "pythonBinary");
      const command = { ...candidate, executable: validated };
      await assertBootstrapPythonCommandVersion(command, pythonVersion);
      return command;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error(`No Python ${pythonVersion} interpreter was found for first-run runtime setup.`);
}

async function assertUvExecutable(binary: string): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: buildPythonBridgeEnv(),
      cwd: getSafePythonWorkingDirectory(),
    });

    let output = "";
    const timeoutHandle = setTimeout(() => {
      child.kill();
      reject(new Error("Timed out while validating uv executable."));
    }, PYTHON_EXECUTABLE_TIMEOUT_MS);

    const cleanup = () => clearTimeout(timeoutHandle);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
    });
    child.on("error", (err) => {
      cleanup();
      reject(new Error(`Failed to execute uv: ${err.message}`));
    });
    child.on("close", (code) => {
      cleanup();
      if (code === 0 && /\buv\b/i.test(output)) {
        resolve();
        return;
      }
      reject(new Error("Configured uv executable is not valid."));
    });
  });

  return binary;
}

async function findUvExecutable(): Promise<string | null> {
  for (const candidate of getUvExecutableCandidates(process.platform)) {
    try {
      return await assertUvExecutable(candidate);
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function getSystemDependenciesForModel(model: LocalModel): SystemDependencySetup[] {
  void model;
  // NeuTTS wheels bundle eSpeak; the Python bridge validates bundled and
  // system fallback backends after the selected interpreter is resolved.
  return [];
}

async function hasNvidiaGpu(): Promise<boolean> {
  if (process.platform === "darwin") return false;
  if (nvidiaGpuProbePromise) return nvidiaGpuProbePromise;

  nvidiaGpuProbePromise = new Promise<boolean>((resolve) => {
    const child = spawn("nvidia-smi", ["-L"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: buildPythonBridgeEnv(),
      cwd: getSafePythonWorkingDirectory(),
    });

    let output = "";
    const timeoutHandle = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 5_000);
    const finish = (value: boolean) => {
      clearTimeout(timeoutHandle);
      resolve(value);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
    });
    child.on("error", () => finish(false));
    child.on("close", (code) => {
      finish(code === 0 && /gpu/i.test(output));
    });
  });

  return nvidiaGpuProbePromise;
}

function getPipInstallProgressLabel(packages: string[]): string {
  const packageSet = new Set(packages);
  if (packages[0] === "torch" && packageSet.has("https://download.pytorch.org/whl/cu128")) {
    return "Installing CUDA-enabled PyTorch…";
  }
  if (packages[0] === "torch" && packageSet.has("https://download.pytorch.org/whl/cpu")) {
    return "Installing CPU PyTorch…";
  }
  if (packages[0] === "torch") {
    return process.platform === "darwin"
      ? "Installing PyTorch with Apple MPS support…"
      : "Installing PyTorch…";
  }
  return `Installing ${packages.join(" and ")}…`;
}

function getHomebrewExecutableCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  if (process.platform !== "darwin") return [];

  const candidates: string[] = [];
  const append = (value: string | undefined) => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };

  append(env.TTS_BREW_BIN);
  append(env.BREW_BIN);
  append("/opt/homebrew/bin/brew");
  append("/usr/local/bin/brew");
  append("/opt/local/bin/brew");
  append("brew");

  return candidates;
}

function homebrewListVersionsIncludesPackage(output: string, packageName: string): boolean {
  return output
    .split(/\r?\n/)
    .some((line) => line.trim().split(/\s+/)[0] === packageName);
}

function getSystemDependencyInstallHint(dependency: SystemDependencySetup): string {
  if (process.platform === "darwin") {
    const brewCommand = dependency.macHomebrewPackage
      ? `brew install ${dependency.macHomebrewPackage}`
      : `install ${dependency.label} with Homebrew`;
    return `${dependency.label} is required. Install it with \`${brewCommand}\`, or install it another way and make the command available on PATH.`;
  }

  if (process.platform === "win32") {
    return `${dependency.label} is required. Install eSpeak NG for Windows, add its install folder to PATH, then retry.`;
  }

  if (process.platform === "linux") {
    return `${dependency.label} is required. Install espeak-ng with your distribution package manager, for example \`sudo apt install espeak-ng\`, \`sudo dnf install espeak-ng\`, or \`sudo pacman -S espeak-ng\`, then retry.`;
  }

  return `${dependency.label} is required. Install it with your system package manager and make the command available on PATH.`;
}

async function findHomebrewExecutable(): Promise<string | null> {
  for (const candidate of getHomebrewExecutableCandidates()) {
    try {
      await runPythonSetupCommand(candidate, ["--version"], "Validate Homebrew");
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function addDynamicPythonBridgePathEntry(entry: string | undefined): void {
  if (entry) {
    dynamicPythonBridgePathEntries.add(entry);
  }
}

async function addHomebrewPackagePath(brewBinary: string, packageName: string): Promise<void> {
  try {
    const output = await runPythonSetupCommand(
      brewBinary,
      ["--prefix", packageName],
      `Resolve ${packageName} Homebrew prefix`,
    );
    const prefix = output.trim().split(/\r?\n/)[0];
    if (prefix) {
      addDynamicPythonBridgePathEntry(path.join(prefix, "bin"));
      addDynamicPythonBridgePathEntry(path.join(prefix, "sbin"));
    }
  } catch {
    // Static PATH fallbacks cover standard Homebrew layouts.
  }
}

async function findSystemDependencyCommand(dependency: SystemDependencySetup): Promise<string | null> {
  for (const command of dependency.commands) {
    try {
      await runPythonSetupCommand(command, ["--version"], `Validate ${dependency.label}`);
      return command;
    } catch {
      // Try the next supported command name.
    }
  }

  return null;
}

async function installHomebrewSystemDependency(
  dependency: SystemDependencySetup,
  onProgress: RuntimeSetupProgress | undefined,
  startedAt: number,
): Promise<void> {
  if (!dependency.macHomebrewPackage) {
    throw new Error(getSystemDependencyInstallHint(dependency));
  }

  const brewBinary = await findHomebrewExecutable();
  if (!brewBinary) {
    throw new Error(
      `${getSystemDependencyInstallHint(dependency)} Automatic install was not possible because Homebrew was not found.`,
    );
  }

  const listOutput = await runPythonSetupCommand(
    brewBinary,
    ["list", "--versions", dependency.macHomebrewPackage],
    `Check ${dependency.macHomebrewPackage}`,
  ).catch(() => "");
  const isInstalled = homebrewListVersionsIncludesPackage(listOutput, dependency.macHomebrewPackage);

  if (isInstalled) {
    await addHomebrewPackagePath(brewBinary, dependency.macHomebrewPackage);
    if (await findSystemDependencyCommand(dependency)) return;
    throw new Error(
      `${dependency.label} is installed with Homebrew but its command was not found from the app. Restart the app and verify \`${dependency.commands[0]}\` is available on PATH.`,
    );
  }

  onProgress?.("runtime_setup", `Installing ${dependency.macHomebrewPackage} with Homebrew...`, startedAt);
  await runPythonSetupCommand(
    brewBinary,
    ["install", dependency.macHomebrewPackage],
    `Install ${dependency.macHomebrewPackage}`,
  );
  await addHomebrewPackagePath(brewBinary, dependency.macHomebrewPackage);
}

async function ensureSystemDependencies(
  dependencies: SystemDependencySetup[],
  onProgress: RuntimeSetupProgress | undefined,
  startedAt: number,
): Promise<void> {
  for (const dependency of dependencies) {
    if (await findSystemDependencyCommand(dependency)) continue;

    if (process.platform === "darwin") {
      await installHomebrewSystemDependency(dependency, onProgress, startedAt);
      if (await findSystemDependencyCommand(dependency)) continue;
    }

    throw new Error(getSystemDependencyInstallHint(dependency));
  }
}

async function createManagedPythonVirtualEnv(
  model: LocalModel,
  envDir: string,
  pythonVersion: string,
  onProgress: RuntimeSetupProgress | undefined,
  startedAt: number,
): Promise<void> {
  try {
    const bootstrapPython = await findBootstrapPython(model, pythonVersion);
    onProgress?.("runtime_setup", `Creating Python ${pythonVersion} environment...`, startedAt);
    await runPythonSetupCommand(
      bootstrapPython.executable,
      [...bootstrapPython.args, "-m", "venv", envDir],
      `Create ${path.basename(envDir)}`,
    );
    return;
  } catch {
    // Fall back to uv below; uv can download managed Python when the requested
    // interpreter is not already present on the system.
  }

  const uvBinary = await findUvExecutable();
  if (!uvBinary) {
    throw new Error(
      `No Python ${pythonVersion} interpreter or uv executable was found for first-run runtime setup. Install Python ${pythonVersion} or uv, then retry.`,
    );
  }

  onProgress?.("runtime_setup", `Creating Python ${pythonVersion} environment with uv...`, startedAt);
  await runPythonSetupCommand(
    uvBinary,
    ["venv", "--python", pythonVersion, envDir],
    `Create ${path.basename(envDir)} with uv`,
  );
}

async function ensureDefaultPythonRuntime(
  model: LocalModel,
  onProgress?: RuntimeSetupProgress,
): Promise<PythonResolution> {
  const existing = defaultPythonRuntimeSetupPromises.get(model);
  if (existing) return existing;

  const setupPromise = (async () => {
    const setupProfile = await getRuntimeSetupProfile(model);
    const setup = getDefaultPythonRuntimeSetup(model, setupProfile);
    const rootDir = getDefaultRuntimeRoot();
    const envDir = path.join(rootDir, setup.envName);
    const pythonBinary = getVirtualEnvPythonPath(rootDir, setup.envName, process.platform);
    const resolvedFrom = isDev ? `cwd:${setup.envName}` : `userData:${setup.envName}`;
    const startedAt = Date.now();
    const systemDependencies = getSystemDependenciesForModel(model);

    try {
      await validatePythonBinary(pythonBinary, "pythonBinary");
      await assertBootstrapPythonVersion(pythonBinary, setup.pythonVersion);
      await assertPythonModelDependency(pythonBinary, model);
      await ensureSystemDependencies(systemDependencies, onProgress, startedAt);
      return { pythonBinary, resolvedFrom };
    } catch {
      // Create or repair the managed runtime below.
    }

    onProgress?.("runtime_setup", `Preparing ${setup.dependencyLabel} runtime in ${setup.envName}…`, startedAt);
    await fs.mkdir(rootDir, { recursive: true });

    let shouldCreateEnv = false;
    try {
      await validatePythonBinary(pythonBinary, "pythonBinary");
      await assertBootstrapPythonVersion(pythonBinary, setup.pythonVersion);
    } catch {
      shouldCreateEnv = true;
    }

    if (shouldCreateEnv) {
      await fs.rm(envDir, { recursive: true, force: true });
      await createManagedPythonVirtualEnv(model, envDir, setup.pythonVersion, onProgress, startedAt);
    }

    await validatePythonBinary(pythonBinary, "pythonBinary");
    await assertBootstrapPythonVersion(pythonBinary, setup.pythonVersion);

    try {
      onProgress?.("runtime_setup", `Ensuring pip is available in ${setup.envName}...`, startedAt);
      await runPythonSetupCommand(pythonBinary, ["-m", "ensurepip", "--upgrade"], `Bootstrap pip in ${setup.envName}`);
    } catch {
      // Some Python distributions omit ensurepip but still provide pip in venvs.
    }

    onProgress?.("runtime_setup", `Upgrading pip in ${setup.envName}...`, startedAt);
    await runPythonSetupCommand(
      pythonBinary,
      ["-m", "pip", "install", "--upgrade", "pip"],
      `Upgrade pip in ${setup.envName}`,
    );

    for (const packages of setup.installSteps) {
      onProgress?.("runtime_setup", getPipInstallProgressLabel(packages), startedAt);
      await runPythonSetupCommand(
        pythonBinary,
        ["-m", "pip", "install", ...packages],
        `Install ${packages.join(" ")}`,
      );
    }

    await assertPythonModelDependency(pythonBinary, model);
    await ensureSystemDependencies(systemDependencies, onProgress, startedAt);
    onProgress?.("runtime_setup", `${setup.dependencyLabel} runtime is installed.`, startedAt);

    return { pythonBinary, resolvedFrom };
  })();

  defaultPythonRuntimeSetupPromises.set(model, setupPromise);
  try {
    const resolution = await setupPromise;
    autoPythonBinaryCache.set(model, resolution);
    return resolution;
  } catch (err) {
    defaultPythonRuntimeSetupPromises.delete(model);
    throw err;
  }
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
  {
    onProgress,
    requireModelDependency,
  }: { onProgress?: RuntimeSetupProgress; requireModelDependency: boolean },
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
      await ensureSystemDependencies(getSystemDependenciesForModel(model), onProgress, Date.now());
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
      await ensureSystemDependencies(getSystemDependenciesForModel(model), onProgress, Date.now());
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

  if (process.env.OPEN_TTS_DISABLE_AUTO_PYTHON_SETUP !== "1") {
    return await ensureDefaultPythonRuntime(model, onProgress);
  }

  const recommendedEnv = model === "neutts"
    ? ".venv-neutts"
    : model === "qwen3"
      ? ".venv-qwen3"
      : ".venv-kani";
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

async function sanitizeLocalBridgeRequest(
  action: BridgeAction,
  request: unknown,
  onProgress?: RuntimeSetupProgress,
): Promise<ValidatedLocalBridgeRequest> {
  if (!isRecord(request)) throw new Error("Invalid IPC request payload.");
  const model = assertLocalModel(String(request.model));
  const requestId = action === "generate"
    ? parseRequestId(request.requestId, { required: true })
    : parseRequestId(request.requestId);
  const pythonResolution = await sanitizePythonBinary(request.pythonBinary, model, {
    onProgress,
    requireModelDependency: request.pythonBinary == null,
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

function shouldForwardPythonEnv(key: string): boolean {
  return [
    "CUDA_",
    "HF_",
    "HUGGINGFACE_",
    "OPEN_TTS_",
    "PHONEMIZER_",
    "PYTORCH_",
    "TORCH_",
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
      "TRANSFORMERS_CACHE",
      "USER",
      "USERPROFILE",
      "WINDIR",
    ].includes(key);
}

function buildPythonBridgeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PYTHONIOENCODING: "utf-8",
    PATH: getPythonBridgePathEntries(process.platform).join(path.delimiter),
  };

  for (const [key, value] of Object.entries(process.env)) {
    if (key !== "PATH" && value !== undefined && shouldForwardPythonEnv(key)) {
      env[key] = value;
    }
  }

  return env;
}

function getLocalBridgeProgressTarget(
  action: BridgeAction,
  request: unknown,
): { model: LocalModel; requestId: string } | null {
  if (!isRecord(request)) return null;

  try {
    const model = assertLocalModel(String(request.model));
    const requestId = parseRequestId(request.requestId, { required: action === "generate" });
    return requestId ? { model, requestId } : null;
  } catch {
    return null;
  }
}

async function runPythonBridge(
  action: BridgeAction,
  request: unknown,
  event?: IpcMainInvokeEvent,
): Promise<unknown> {
  const progressTarget = getLocalBridgeProgressTarget(action, request);
  const sendProgress: RuntimeSetupProgress | undefined = event && progressTarget
    ? (phase, message, startedAt) => {
      event.sender.send("local-tts:progress", {
        requestId: progressTarget.requestId,
        model: progressTarget.model,
        phase,
        message,
        ...(startedAt == null ? {} : { elapsedSec: Number(((Date.now() - startedAt) / 1000).toFixed(3)) }),
      });
    }
    : undefined;
  const sanitized = await sanitizeLocalBridgeRequest(action, request, sendProgress);
  const model = sanitized.model;
  const cacheDir = getCacheDir(model);
  const pythonBinary = sanitized.pythonResolution.pythonBinary;
  const scriptPath = getBridgeScriptPath();
  const shouldRateLimit = action === "generate";
  const requestId = sanitized.requestId;
  // Qwen3 generation runs on a resident worker (load once, serve many). Probe
  // and the other models keep the one-shot subprocess path below.
  const usePersistentWorker = action === "generate" && PERSISTENT_WORKER_MODELS.has(model);

  const runPersistentGenerate = async (): Promise<unknown> => {
    await fs.access(scriptPath);
    await fs.mkdir(cacheDir, { recursive: true });
    const generateRequestId = requestId!; // generate always carries a requestId.

    const onProgressLine = (line: string) => {
      if (!event) return;
      try {
        const progress = parseBridgeProgressResult(
          JSON.parse(line.slice(BRIDGE_PROGRESS_PREFIX.length)),
        );
        event.sender.send("local-tts:progress", { requestId: generateRequestId, model, ...progress });
      } catch (err) {
        console.warn(
          `[local-tts:generate] Failed parsing bridge progress: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };

    const { stdout, stderr } = await getPersistentBridgeWorkers().run(model, {
      requestId: generateRequestId,
      payload: sanitized.payload,
      spawnConfig: { pythonBinary, scriptPath, cacheDir, env: buildPythonBridgeEnv() },
      idleTimeoutMs: PYTHON_BRIDGE_GENERATE_IDLE_TIMEOUT_MS,
      maxStdoutBytes: PYTHON_BRIDGE_MAX_STDOUT_BYTES,
      maxStderrBytes: PYTHON_BRIDGE_MAX_STDERR_BYTES,
      onProgressLine,
    });
    return parseBridgeResult(stdout, stderr, "generate", sanitized.pythonResolution);
  };

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
          env: buildPythonBridgeEnv(),
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

      const isGenerate = action === "generate";
      const timeoutMs = isGenerate
        ? PYTHON_BRIDGE_GENERATE_IDLE_TIMEOUT_MS
        : PYTHON_BRIDGE_TIMEOUT_MS;
      const onTimeout = () => {
        if (settled) return;
        settled = true;
        child.kill();
        if (requestId) {
          activeBridgeProcesses.delete(requestId);
          cancelledBridgeRequests.delete(requestId);
        }
        reject(new Error(isGenerate
          ? `Python bridge produced no output for ${timeoutMs / 1000}s and was stopped (the process may be stuck).`
          : `Python bridge timed out after ${timeoutMs / 1000}s.`));
      };
      let timeoutHandle = setTimeout(onTimeout, timeoutMs);

      // For generation, re-arm the watchdog on any output so long-but-progressing
      // downloads/inference (which heartbeat steadily) are never killed mid-run.
      const bumpTimeout = isGenerate
        ? () => {
          if (settled) return;
          clearTimeout(timeoutHandle);
          timeoutHandle = setTimeout(onTimeout, timeoutMs);
        }
        : () => {};

      const cleanup = () => {
        clearTimeout(timeoutHandle);
        if (requestId) {
          activeBridgeProcesses.delete(requestId);
        }
      };

      const rejectForOutputLimit = (streamName: "stdout" | "stderr", limitBytes: number) => {
        if (settled) return true;
        settled = true;
        child.kill();
        cleanup();
        if (requestId) {
          cancelledBridgeRequests.delete(requestId);
        }
        reject(new Error(`Python bridge ${streamName} exceeded ${limitBytes} bytes.`));
        return true;
      };

      child.stdout.on("data", (chunk: Buffer) => {
        bumpTimeout();
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > PYTHON_BRIDGE_MAX_STDOUT_BYTES) {
          rejectForOutputLimit("stdout", PYTHON_BRIDGE_MAX_STDOUT_BYTES);
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
        bumpTimeout();
        stderrBytes += chunk.byteLength;
        if (stderrBytes > PYTHON_BRIDGE_MAX_STDERR_BYTES) {
          rejectForOutputLimit("stderr", PYTHON_BRIDGE_MAX_STDERR_BYTES);
          return;
        }
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

  const task = usePersistentWorker ? runPersistentGenerate : runBridge;
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
  await fs.rm(cachePath, { recursive: true, force: true });
  return { path: cachePath, cleared: true };
}

async function handleCancel(request: unknown): Promise<{ cancelled: boolean }> {
  const { requestId } = sanitizeCancelRequest(request);

  // Persistent-worker generations (Qwen3) are cancelled by killing their worker;
  // its exit rejects the in-flight request as cancelled and the next request respawns.
  if (persistentBridgeWorkers?.cancel(requestId)) {
    return { cancelled: true };
  }

  const child = activeBridgeProcesses.get(requestId);
  if (!child) {
    cancelledBridgeRequests.delete(requestId);
    return { cancelled: false };
  }

  cancelledBridgeRequests.add(requestId);

  try {
    child.kill();
    setTimeout(() => {
      if (activeBridgeProcesses.get(requestId) !== child) return;
      try {
        child.kill("SIGKILL");
      } catch {
        // Process has already exited.
      }
    }, PYTHON_CANCEL_KILL_AFTER_MS).unref();
  } catch {
    cancelledBridgeRequests.delete(requestId);
    throw new Error("Failed to cancel Python generation.");
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
    return runPythonBridge("probe", request, event);
  });

  ipcMain.handle("local-tts:generate", (event, request: unknown) => {
    assertTrustedIpcSender(event, { allowDevServer: isDev });
    return runPythonBridge("generate", request, event);
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
    try {
      child.kill();
    } catch {
      // Ignore if the process already exited.
    }
  }
  activeBridgeProcesses.clear();
  cancelledBridgeRequests.clear();
  persistentBridgeWorkers?.shutdownAll();
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
