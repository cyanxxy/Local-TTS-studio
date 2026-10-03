import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRustTargetDir } from "./rust-target-dir.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(rootDir, "rust", "bridge-policy-tests", "Cargo.toml");

execFileSync(
  "cargo",
  ["test", "--locked", "--manifest-path", manifestPath, ...process.argv.slice(2)],
  {
    cwd: rootDir,
    env: { ...process.env, CARGO_TARGET_DIR: resolveRustTargetDir(rootDir) },
    stdio: "inherit",
  },
);
