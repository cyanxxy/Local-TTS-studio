import path from "path";

export type LocalModelId = "neutts" | "kani" | "qwen3";

export interface DefaultPythonRuntimeSetup {
  envName: string;
  pythonVersion: string;
  installSteps: string[][];
  dependencyLabel: string;
}

export interface PythonCommandCandidate {
  executable: string;
  args: string[];
  resolvedFrom: string;
}

const DEFAULT_PYTHON_RUNTIME_SETUPS: Record<LocalModelId, DefaultPythonRuntimeSetup> = {
  neutts: {
    envName: ".venv-neutts",
    pythonVersion: "3.12",
    installSteps: [["neutts"]],
    dependencyLabel: "neutts",
  },
  kani: {
    envName: ".venv-kani",
    pythonVersion: "3.12",
    installSteps: [["kani-tts-2"], ["transformers==4.56.0"]],
    dependencyLabel: "kani-tts-2",
  },
  qwen3: {
    envName: ".venv-qwen3",
    pythonVersion: "3.12",
    installSteps: [["qwen-tts", "torch"]],
    dependencyLabel: "qwen-tts",
  },
};

export interface PythonSearchContext {
  appPath: string;
  cwd: string;
  execPath: string;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  resourcesPath?: string;
}

function appendUnique(target: string[], value: string | undefined): void {
  if (!value) return;

  const normalized = path.resolve(value);
  if (!target.includes(normalized)) {
    target.push(normalized);
  }
}

function shouldIncludeContainingDirectory(appPath: string): boolean {
  const baseName = path.basename(appPath);
  return baseName === "dist-electron" || baseName.endsWith(".asar");
}

export function getPythonSearchRoots(context: PythonSearchContext): string[] {
  const roots: string[] = [];

  appendUnique(roots, context.appPath);

  if (shouldIncludeContainingDirectory(context.appPath)) {
    appendUnique(roots, path.dirname(context.appPath));
  }

  appendUnique(roots, context.resourcesPath);

  if (!context.isPackaged) {
    appendUnique(roots, context.cwd);
  }

  return roots;
}

export function getVirtualEnvPythonPath(rootDir: string, envName: string, platform: NodeJS.Platform): string {
  const executable = platform === "win32" ? "python.exe" : "python";
  const binDir = platform === "win32" ? "Scripts" : "bin";
  return path.join(rootDir, envName, binDir, executable);
}

export function getVirtualEnvPythonCandidates(envName: string, context: PythonSearchContext): string[] {
  return getPythonSearchRoots(context).map((rootDir) => getVirtualEnvPythonPath(rootDir, envName, context.platform));
}

export function getDefaultPythonRuntimeSetup(model: LocalModelId): DefaultPythonRuntimeSetup {
  const setup = DEFAULT_PYTHON_RUNTIME_SETUPS[model];
  return {
    envName: setup.envName,
    pythonVersion: setup.pythonVersion,
    installSteps: setup.installSteps.map((step) => [...step]),
    dependencyLabel: setup.dependencyLabel,
  };
}

export function getBootstrapPythonCommandCandidates(
  model: LocalModelId,
  pythonVersion: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): PythonCommandCandidate[] {
  const candidates: PythonCommandCandidate[] = [];
  const append = (executable: string | undefined, resolvedFrom: string, args: string[] = []) => {
    if (!executable) return;
    if (candidates.some((candidate) => (
      candidate.executable === executable && candidate.args.join("\0") === args.join("\0")
    ))) {
      return;
    }
    candidates.push({ executable, args: [...args], resolvedFrom });
  };

  const modelSpecificEnv = model === "neutts"
    ? env.TTS_NEUTTS_PYTHON_BIN
    : model === "qwen3"
      ? env.TTS_QWEN3_PYTHON_BIN
      : env.TTS_KANI_PYTHON_BIN;
  const modelSpecificEnvName = model === "neutts"
    ? "TTS_NEUTTS_PYTHON_BIN"
    : model === "qwen3"
      ? "TTS_QWEN3_PYTHON_BIN"
      : "TTS_KANI_PYTHON_BIN";

  append(modelSpecificEnv, modelSpecificEnvName);
  append(env.TTS_PYTHON_BIN, "TTS_PYTHON_BIN");

  if (platform === "win32") {
    append("py", `system:py -${pythonVersion}`, [`-${pythonVersion}`]);
    append(`python${pythonVersion}`, `system:python${pythonVersion}`);
    append("python", "system:python");
    append("py", "system:py");
    return candidates;
  }

  append(`python${pythonVersion}`, `system:python${pythonVersion}`);
  append("python3", "system:python3");
  append("python", "system:python");
  return candidates;
}

export function getManagedPythonVersionCheckSnippet(pythonVersion: string): string {
  const [major, minor] = pythonVersion.split(".").map((part) => Number.parseInt(part, 10));
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) {
    throw new Error(`Unsupported managed Python version: ${pythonVersion}`);
  }

  return `import sys; assert (${major}, ${minor}) <= sys.version_info < (${major}, ${minor + 1})`;
}

export function getUvExecutableCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const candidates: string[] = [];
  const append = (value: string | undefined) => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };

  append(env.TTS_UV_BIN);
  append(env.UV_BIN);

  if (platform === "win32") {
    append(env.USERPROFILE ? joinWindowsPath(env.USERPROFILE, ".local\\bin\\uv.exe") : undefined);
    append("uv.exe");
    append("uv");
    return candidates;
  }

  append(env.HOME ? path.join(env.HOME, ".local", "bin", "uv") : undefined);
  append(env.HOME ? path.join(env.HOME, ".cargo", "bin", "uv") : undefined);
  append("uv");
  if (platform === "darwin") {
    append("/opt/homebrew/bin/uv");
    append("/usr/local/bin/uv");
  } else if (platform === "linux") {
    append("/usr/local/bin/uv");
    append("/usr/bin/uv");
  }
  return candidates;
}

export function getPythonBridgePathEntries(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const entries: string[] = [];
  const append = (value: string | undefined) => {
    if (value && !entries.includes(value)) entries.push(value);
  };

  append(env.PATH);

  if (platform === "darwin") {
    append("/opt/homebrew/bin");
    append("/usr/local/bin");
    append("/opt/homebrew/sbin");
    append("/usr/local/sbin");
    append("/opt/homebrew/opt/espeak-ng/bin");
    append("/usr/local/opt/espeak-ng/bin");
    append("/opt/local/bin");
    append("/opt/local/sbin");
  } else if (platform === "linux") {
    append("/usr/local/bin");
    append("/usr/bin");
    append("/bin");
    append("/snap/bin");
    append("/usr/local/sbin");
    append("/usr/sbin");
    append("/sbin");
  } else if (platform === "win32") {
    append(env.ProgramFiles ? joinWindowsPath(env.ProgramFiles, "eSpeak NG") : undefined);
    append(env["ProgramFiles(x86)"] ? joinWindowsPath(env["ProgramFiles(x86)"], "eSpeak NG") : undefined);
    append(env.LOCALAPPDATA ? joinWindowsPath(env.LOCALAPPDATA, "Programs\\eSpeak NG") : undefined);
  }

  return entries;
}

function joinWindowsPath(base: string, suffix: string): string {
  return `${base.replace(/[\\/]+$/, "")}\\${suffix}`;
}

export function getPythonDependencyCheckSnippet(model: LocalModelId): string {
  if (model === "neutts") {
    return [
      "import importlib.util, sys",
      "assert (3, 10) <= sys.version_info < (3, 14)",
      "assert importlib.util.find_spec('neutts') is not None",
    ].join("; ");
  }

  if (model === "qwen3") {
    return [
      "import importlib.util",
      "assert importlib.util.find_spec('qwen_tts') is not None",
      "assert importlib.util.find_spec('torch') is not None",
    ].join("; ");
  }

  return [
    "import importlib.metadata, importlib.util",
    "assert importlib.util.find_spec('kani_tts') is not None",
    "importlib.metadata.version('kani-tts-2')",
    "version = tuple(int(part) for part in importlib.metadata.version('transformers').split('+', 1)[0].split('.')[:3])",
    "assert (4, 56, 0) <= version < (5, 0, 0)",
  ].join("; ");
}
