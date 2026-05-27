// @vitest-environment node

import path from "path";
import { describe, expect, it } from "vitest";
import {
  getPythonDependencyCheckSnippet,
  getPythonSearchRoots,
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
  });
});
