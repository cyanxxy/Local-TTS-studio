import { createHash } from "node:crypto";
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
