import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function resolveRustTargetDir(rootDir) {
  if (process.env.CARGO_TARGET_DIR) {
    return path.resolve(process.env.CARGO_TARGET_DIR);
  }

  const workspaceKey = createHash("sha256")
    .update(path.resolve(rootDir))
    .digest("hex")
    .slice(0, 12);
  return path.join(os.tmpdir(), "open-tts-rust-target", workspaceKey);
}

/**
 * Environment for cargo commands. On macOS it defaults the deployment target to
 * the app's `minimumSystemVersion`, as CI does: without it, a build on a newer
 * macOS targets that release, so the bridge would not run on the oldest
 * supported one, and the Metal compiler defaults to a newer language version
 * (macOS 27: Metal 4.1) whose address-space rules the pinned MLX kernels
 * predate.
 */
export function rustBuildEnv(rootDir) {
  const env = { ...process.env, CARGO_TARGET_DIR: resolveRustTargetDir(rootDir) };
  if (process.platform === "darwin" && !env.MACOSX_DEPLOYMENT_TARGET) {
    const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
    env.MACOSX_DEPLOYMENT_TARGET = packageJson.build.mac.minimumSystemVersion;
  }
  return env;
}
