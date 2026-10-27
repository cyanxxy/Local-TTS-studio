import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rustBuildEnv } from "./rust-target-dir.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(rootDir, "rust", "Cargo.toml");

execFileSync(
  "cargo",
  // --release matches build:rust and test:rust so clippy reuses their artifacts
  // instead of compiling the whole native dependency graph a second time.
  ["clippy", "--locked", "--release", "--manifest-path", manifestPath, "--workspace", "--all-targets", "--", "-D", "warnings"],
  {
    cwd: rootDir,
    env: rustBuildEnv(rootDir),
    stdio: "inherit",
  },
);
