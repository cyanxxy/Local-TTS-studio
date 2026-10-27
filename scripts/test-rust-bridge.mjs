import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rustBuildEnv } from "./rust-target-dir.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(rootDir, "rust", "Cargo.toml");

execFileSync(
  "cargo",
  ["test", "--locked", "--manifest-path", manifestPath, ...process.argv.slice(2)],
  {
    cwd: rootDir,
    env: rustBuildEnv(rootDir),
    stdio: "inherit",
  },
);
