// @vitest-environment node

import path from "path";
import { describe, expect, it } from "vitest";
import {
  getBootstrapPythonCommandCandidates,
  getDefaultPythonRuntimeSetup,
  getManagedPythonVersionCheckSnippet,
  getPythonBridgePathEntries,
  getPythonDependencyCheckSnippet,
  getPythonSearchRoots,
  getUvExecutableCandidates,
  getVirtualEnvPythonCandidates,
  getVirtualEnvPythonPath,
} from "./pythonRuntime";

describe("pythonRuntime", () => {
  it("resolves repo virtualenv paths when development appPath points at dist-electron", () => {
    const repoRoot = path.join("/tmp", "Open TTS");
    const context = {
      appPath: path.join(repoRoot, "dist-electron"),
      cwd: repoRoot,
      execPath: path.join(repoRoot, "node_modules", "electron", "dist", "Electron"),
      isPackaged: false,
      platform: process.platform,
      resourcesPath: undefined,
    } as const;

    expect(getPythonSearchRoots(context)).toEqual([
      path.join(repoRoot, "dist-electron"),
      repoRoot,
    ]);
    expect(getVirtualEnvPythonCandidates(".venv-neutts", context)).toContain(
      path.join(repoRoot, ".venv-neutts", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python"),
    );
  });

  it("keeps packaged Python search roots scoped to the app bundle", () => {
    const repoRoot = path.join("/tmp", "Open TTS");
    const contentsDir = path.join(repoRoot, "release", "mac-arm64", "Open TTS.app", "Contents");
    const resourcesDir = path.join(contentsDir, "Resources");
    const context = {
      appPath: path.join(resourcesDir, "app.asar"),
      cwd: "/",
      execPath: path.join(contentsDir, "MacOS", "Open TTS"),
      isPackaged: true,
      platform: "darwin" as NodeJS.Platform,
      resourcesPath: resourcesDir,
    };

    expect(getPythonSearchRoots(context)).toEqual([
      path.join(resourcesDir, "app.asar"),
      resourcesDir,
    ]);
    expect(getVirtualEnvPythonCandidates(".venv-neutts", context)).not.toContain(
      path.join(repoRoot, ".venv-neutts", "bin", "python"),
    );
  });

  it("uses the platform-specific virtualenv executable layout", () => {
    expect(getVirtualEnvPythonPath(path.join("C:", "Open TTS"), ".venv-neutts", "win32")).toBe(
      path.join("C:", "Open TTS", ".venv-neutts", "Scripts", "python.exe"),
    );
  });

  it("uses lightweight dependency checks for auto-detect", () => {
    expect(getPythonDependencyCheckSnippet("kani")).toContain("find_spec('kani_tts')");
    expect(getPythonDependencyCheckSnippet("kani")).toContain("version('kani-tts-2')");
    expect(getPythonDependencyCheckSnippet("kani")).toContain("(4, 56, 0) <= version < (5, 0, 0)");
    expect(getPythonDependencyCheckSnippet("kani")).not.toContain("import kani_tts");
    expect(getPythonDependencyCheckSnippet("neutts")).toContain("find_spec('neutts')");
    expect(getPythonDependencyCheckSnippet("neutts")).toContain("sys.version_info");
    expect(getPythonDependencyCheckSnippet("qwen3")).toContain("find_spec('qwen_tts')");
    expect(getPythonDependencyCheckSnippet("qwen3")).toContain("find_spec('torch')");
    expect(getPythonDependencyCheckSnippet("qwen3")).toContain("(3, 9) <= sys.version_info < (3, 14)");
    expect(getPythonDependencyCheckSnippet("qwen3")).not.toContain("import qwen_tts");
    expect(getPythonDependencyCheckSnippet("qwen3", {
      platform: "linux",
      arch: "x64",
      hasNvidiaGpu: true,
    })).toContain("torch.cuda.is_available()");
  });

  it("describes default first-run runtime setup for Electron local models", () => {
    expect(getDefaultPythonRuntimeSetup("qwen3", {
      platform: "darwin",
      arch: "arm64",
    })).toEqual({
      envName: ".venv-qwen3",
      pythonVersion: "3.12",
      installSteps: [["torch"], ["qwen-tts"]],
      dependencyLabel: "qwen-tts",
    });
    expect(getDefaultPythonRuntimeSetup("qwen3", {
      platform: "linux",
      arch: "x64",
      hasNvidiaGpu: true,
    }).installSteps).toEqual([
      ["torch", "--index-url", "https://download.pytorch.org/whl/cu128"],
      ["qwen-tts"],
    ]);
    expect(getDefaultPythonRuntimeSetup("qwen3", {
      platform: "win32",
      arch: "x64",
      hasNvidiaGpu: false,
    }).installSteps).toEqual([
      ["torch", "--index-url", "https://download.pytorch.org/whl/cpu"],
      ["qwen-tts"],
    ]);
    expect(getDefaultPythonRuntimeSetup("kani")).toEqual({
      envName: ".venv-kani",
      pythonVersion: "3.12",
      installSteps: [["kani-tts-2"], ["transformers==4.56.0"]],
      dependencyLabel: "kani-tts-2",
    });
    expect(getDefaultPythonRuntimeSetup("neutts")).toEqual({
      envName: ".venv-neutts",
      pythonVersion: "3.12",
      installSteps: [["neutts"]],
      dependencyLabel: "neutts",
    });
  });

  it("targets Python 3.12 for managed runtime setup", () => {
    expect(getManagedPythonVersionCheckSnippet("3.12")).toContain("(3, 12) <= sys.version_info < (3, 13)");
  });

  it("uses py launcher version arguments when bootstrapping managed Python on Windows", () => {
    expect(getBootstrapPythonCommandCandidates("kani", "3.12", "win32", {
      TTS_KANI_PYTHON_BIN: "C:\\Python312\\python.exe",
      TTS_PYTHON_BIN: "C:\\Fallback\\python.exe",
    })).toEqual([
      { executable: "C:\\Python312\\python.exe", args: [], resolvedFrom: "TTS_KANI_PYTHON_BIN" },
      { executable: "C:\\Fallback\\python.exe", args: [], resolvedFrom: "TTS_PYTHON_BIN" },
      { executable: "py", args: ["-3.12"], resolvedFrom: "system:py -3.12" },
      { executable: "python3.12", args: [], resolvedFrom: "system:python3.12" },
      { executable: "python", args: [], resolvedFrom: "system:python" },
      { executable: "py", args: [], resolvedFrom: "system:py" },
    ]);
  });

  it("includes uv executable fallbacks for managed Python downloads", () => {
    expect(getUvExecutableCandidates("darwin", {
      TTS_UV_BIN: "/custom/uv",
      UV_BIN: "/other/uv",
      HOME: "/Users/tester",
    })).toEqual([
      "/custom/uv",
      "/other/uv",
      "/Users/tester/.local/bin/uv",
      "/Users/tester/.cargo/bin/uv",
      "uv",
      "/opt/homebrew/bin/uv",
      "/usr/local/bin/uv",
    ]);
    expect(getUvExecutableCandidates("linux", { HOME: "/home/tester" })).toEqual([
      "/home/tester/.local/bin/uv",
      "/home/tester/.cargo/bin/uv",
      "uv",
      "/usr/local/bin/uv",
      "/usr/bin/uv",
    ]);
    expect(getUvExecutableCandidates("win32", {
      USERPROFILE: "C:\\Users\\Tester",
    })).toEqual(["C:\\Users\\Tester\\.local\\bin\\uv.exe", "uv.exe", "uv"]);
  });

  it("adds desktop-launch-safe system paths to the Python bridge PATH", () => {
    expect(getPythonBridgePathEntries("darwin", {
      PATH: "/usr/bin:/bin",
    })).toEqual([
      "/usr/bin:/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/opt/homebrew/sbin",
      "/usr/local/sbin",
      "/opt/homebrew/opt/espeak-ng/bin",
      "/usr/local/opt/espeak-ng/bin",
      "/opt/local/bin",
      "/opt/local/sbin",
    ]);
    expect(getPythonBridgePathEntries("linux", {
      PATH: "/usr/bin:/bin",
    })).toEqual([
      "/usr/bin:/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/snap/bin",
      "/usr/local/sbin",
      "/usr/sbin",
      "/sbin",
    ]);
    expect(getPythonBridgePathEntries("win32", {
      PATH: "C:\\Windows\\System32",
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LOCALAPPDATA: "C:\\Users\\Tester\\AppData\\Local",
    })).toEqual([
      "C:\\Windows\\System32",
      "C:\\Program Files\\eSpeak NG",
      "C:\\Program Files (x86)\\eSpeak NG",
      "C:\\Users\\Tester\\AppData\\Local\\Programs\\eSpeak NG",
    ]);
  });

});
