// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { msvcRedistVersionIsCurrent } from "./scripts/msvc-runtime.mjs";

const root = process.cwd();
const buildScript = fs.readFileSync(path.join(root, "scripts/build-rust-bridge.mjs"), "utf-8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")) as {
  scripts: Record<string, string>;
};

describe("Rust runtime packaging", () => {
  it("builds the bridge plus the scoped Xet downloader and rejects other executables", () => {
    expect(buildScript).toContain('const binaryName = process.platform === "win32"');
    expect(buildScript).toContain('const xetDownloaderBinaryName = process.platform === "win32"');
    expect(buildScript).toContain("Rust package must contain the bridge and Xet downloader executables");
    expect(buildScript).not.toMatch(/pibot-tts-worker|api_server|voice_clone|OPEN_TTS_QWEN3_MLX/);
  });

  it("packages the platform provider closure", () => {
    expect(buildScript).toContain("copyMlxMetallib");
    expect(buildScript).toContain("mlx.metallib");
    expect(buildScript).toContain("LIBTORCH");
    expect(buildScript).toContain('/\\.dll$/i');
    expect(buildScript).toContain("makeSelfContainedDarwin");
  });

  it("exposes no upstream Qwen tool or profiling scripts", () => {
    expect(packageJson.scripts["build:qwen3-mlx-worker"]).toBeUndefined();
    expect(packageJson.scripts["build:qwen3-mlx-tools"]).toBeUndefined();
    expect(packageJson.scripts["build:rust:all"]).toBeUndefined();
    expect(packageJson.scripts["profile:qwen3"]).toBeUndefined();
  });
});

describe("bundled Visual C++ runtime", () => {
  it.each([
    "C:\\BuildTools\\VC\\Redist\\MSVC\\14.40.33807",
    "C:\\BuildTools\\VC\\Redist\\MSVC\\14.44.35112\\",
    "C:\\BuildTools\\VC\\Redist\\MSVC\\14.50.35717",
  ])("accepts %s, new enough for every shipped module", (root) => {
    expect(msvcRedistVersionIsCurrent(root)).toBe(true);
  });

  it.each([
    "C:\\BuildTools\\VC\\Redist\\MSVC\\14.38.33135",
    "C:\\BuildTools\\VC\\Redist\\MSVC\\v143",
  ])("refuses %s, which modules built with MSVC 14.40+ crash on", (root) => {
    expect(msvcRedistVersionIsCurrent(root)).toBe(false);
  });

  it("checks the redist version before bundling it", () => {
    expect(buildScript).toContain("msvcRedistVersionIsCurrent(candidate)");
  });
});
