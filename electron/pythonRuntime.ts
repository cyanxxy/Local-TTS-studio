import path from "path";

export type LocalModelId = "neutts" | "kani" | "qwen3";

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
