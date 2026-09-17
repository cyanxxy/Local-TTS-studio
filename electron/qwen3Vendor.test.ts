// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR_DIR = path.join(ROOT_DIR, "rust", "vendor", "qwen3-tts-rs");
const PATCH_PATH = path.join(VENDOR_DIR, "OPEN_TTS.patch");
const EXPECTED_VENDOR_DIGEST = "fbcbe834ed5cc7f3b107fc518344f0c740615ed16d4a634bac93ff70480d5cd3";
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

/** The vendor-relative paths the patch rewrites, in the order it lists them. */
function patchedPaths(patchSource: string): string[] {
  return [...patchSource.matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map((match) => match[1]);
}

describe("qwen3-tts-rs vendor snapshot", () => {
  it("keeps the pinned source tree and Open TTS patch explicit", () => {
    const notes = fs.readFileSync(path.join(VENDOR_DIR, "OPEN_TTS_VENDOR.md"), "utf8");
    const patchSource = fs.readFileSync(PATCH_PATH, "utf8");
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

  // The digest above excludes OPEN_TTS.patch, so nothing else in the repo
  // notices when the patch stops applying. Re-vendoring only discovers that at
  // step 4 of the checklist, long after the bad patch has been committed.
  it("re-applies OPEN_TTS.patch onto the pristine upstream sources", () => {
    const patchSource = fs.readFileSync(PATCH_PATH, "utf8");
    const targets = patchedPaths(patchSource);
    expect(targets.length).toBeGreaterThan(0);

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "open-tts-vendor-patch-"));
    try {
      fs.copyFileSync(PATCH_PATH, path.join(workDir, "OPEN_TTS.patch"));
      for (const relativePath of targets) {
        const destination = path.join(workDir, relativePath);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(VENDOR_DIR, relativePath), destination);
      }

      // Reverse back to upstream, then forward with exactly the commands the
      // re-vendor checklist runs. Plain `git apply` rejects zero-context hunks
      // and drifted line numbers, which is the failure this guards against.
      const gitApply = (...args: string[]) => {
        try {
          execFileSync("git", ["apply", ...args, "OPEN_TTS.patch"], { cwd: workDir, stdio: "pipe" });
        } catch (error) {
          const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
          throw new Error(`git apply ${args.join(" ")} OPEN_TTS.patch failed: ${stderr || error}`);
        }
      };
      gitApply("-R", "--check");
      gitApply("-R");
      gitApply("--check");
      gitApply();

      for (const relativePath of targets) {
        expect(fs.readFileSync(path.join(workDir, relativePath))).toEqual(
          fs.readFileSync(path.join(VENDOR_DIR, relativePath)),
        );
      }
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});
