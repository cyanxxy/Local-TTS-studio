// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const buildScript = fs.readFileSync(path.join(root, "scripts/build-rust-bridge.mjs"), "utf-8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")) as {
  scripts: Record<string, string>;
};

describe("single Rust bridge packaging", () => {
  it("builds only the bridge and rejects unexpected executable artifacts", () => {
    expect(buildScript).toContain('const binaryName = process.platform === "win32"');
    expect(buildScript).toContain("Rust package must contain exactly one executable");
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
