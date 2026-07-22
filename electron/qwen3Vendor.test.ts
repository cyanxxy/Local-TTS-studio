// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR_DIR = path.join(ROOT_DIR, "rust", "vendor", "qwen3-tts-rs");
const EXPECTED_VENDOR_DIGEST = "d439acf134c35e1fffc3cef82ab89d6ea520915227b00c5d7d102cdd8032600d";
const DIGEST_EXCLUSIONS = new Set([
  "OPEN_TTS.patch",
  "OPEN_TTS_VENDOR.md",
  "mlx-c/.cargo-ok",
]);

function vendorSourceDigest(): string {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile()) {
        const relativePath = path.relative(VENDOR_DIR, fullPath).split(path.sep).join("/");
        if (!DIGEST_EXCLUSIONS.has(relativePath)) files.push(relativePath);
      }
    }
  };
  visit(VENDOR_DIR);

  const digest = createHash("sha256");
  for (const relativePath of files.sort()) {
    digest.update(relativePath);
    digest.update("\0");
    digest.update(fs.readFileSync(path.join(VENDOR_DIR, relativePath)));
    digest.update("\0");
  }
  return digest.digest("hex");
}

describe("qwen3-tts-rs vendor snapshot", () => {
  it("keeps the pinned source tree and Open TTS patch explicit", () => {
    const notes = fs.readFileSync(path.join(VENDOR_DIR, "OPEN_TTS_VENDOR.md"), "utf8");
    const patchSource = fs.readFileSync(path.join(VENDOR_DIR, "OPEN_TTS.patch"), "utf8");
    const bridgeManifest = fs.readFileSync(
      path.join(ROOT_DIR, "rust", "local-tts-bridge", "Cargo.toml"),
      "utf8",
    );

    expect(notes).toContain("288a716ce38a91c826dd67968c75d1dd4b0f07bc");
    expect(notes).toContain("22a304206cbc77a5f74d0e0eb7363f2a6998d74f");
    expect(patchSource).toContain("build_voice_design_input_embeddings");
    expect(patchSource).toContain("Bundled mlx-c sources are missing");
    expect(bridgeManifest).toMatch(/qwen3-tts-rs\s*=\s*\{\s*path\s*=\s*"\.\.\/vendor\/qwen3-tts-rs"/);
    expect(fs.existsSync(path.join(VENDOR_DIR, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(VENDOR_DIR, "mlx-c", ".git"))).toBe(false);
    expect(fs.existsSync(path.join(VENDOR_DIR, "mlx-c", "CMakeLists.txt"))).toBe(true);
    expect(vendorSourceDigest()).toBe(EXPECTED_VENDOR_DIGEST);
  });
});
