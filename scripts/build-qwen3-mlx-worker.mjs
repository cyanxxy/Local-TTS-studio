import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultSourceDir = path.join(rootDir, "rust", "qwen3_tts_rs");
const defaultRepoUrl = "https://github.com/badlogic/qwen3_tts_rs.git";
const defaultPatchDir = path.join(rootDir, "patches", "qwen3_tts_rs");
const upstreamPatches = [path.join(defaultPatchDir, "mlx-api-current-thread.patch")];
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const knownMlxBinBaseNames = [
  "tts",
  "voice_clone",
  "api_server",
  "pibot-tts-worker",
  "qwen3-tts",
  "trace_vocoder",
  "trace_rust",
];
const workerBaseName = "pibot-tts-worker";
const customVoiceTtsBaseName = "tts";

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printUsage();
  process.exit(0);
}

if (process.platform !== "darwin") {
  const message = "Qwen3 MLX worker builds are supported only on macOS Apple Silicon.";
  if (!options.dryRun) throw new Error(message);
  console.warn(`Warning: ${message}`);
}
if (process.platform === "darwin" && process.arch !== "arm64") {
  console.warn("Warning: Qwen3 MLX worker is optimized for Apple Silicon; this machine is not arm64.");
}

const sourceDir = path.resolve(options.sourceDir ?? process.env.OPEN_TTS_QWEN3_TTS_RS_DIR ?? defaultSourceDir);
const repoUrl = options.repoUrl ?? process.env.OPEN_TTS_QWEN3_TTS_RS_REPO ?? defaultRepoUrl;
const manifestPath = path.join(sourceDir, "Cargo.toml");

if (!fs.existsSync(sourceDir)) {
  if (options.skipClone || options.noNetwork) {
    throw new Error(`Qwen3 worker source directory does not exist: ${sourceDir}`);
  }
  run("git", ["clone", repoUrl, sourceDir], { cwd: rootDir });
}

const mlxCmake = path.join(sourceDir, "mlx-c", "CMakeLists.txt");
if (!fs.existsSync(mlxCmake)) {
  if (options.noNetwork) {
    throw new Error(`mlx-c submodule is missing under ${sourceDir} and --no-network was set.`);
  }
  run("git", ["submodule", "update", "--init", "--recursive"], { cwd: sourceDir });
}

if (!options.skipPatches) {
  for (const patchPath of upstreamPatches) {
    applyPatchIfNeeded(sourceDir, patchPath);
  }
}

const buildBinBaseNames = options.allBins
  ? readCargoBinNames(manifestPath) ?? knownMlxBinBaseNames
  : [workerBaseName, customVoiceTtsBaseName, "api_server"];
const cargoTargetDir = resolveCargoTargetDir(sourceDir);
const releaseDir = path.join(cargoTargetDir, "release");

const cargoArgs = [
  "build",
  "--release",
  "--no-default-features",
  "--features",
  "mlx",
];
if (!options.allBins) {
  for (const binName of buildBinBaseNames) {
    cargoArgs.push("--bin", binName);
  }
}

run("cargo", cargoArgs, {
  cwd: sourceDir,
  env: { ...process.env, CARGO_TARGET_DIR: cargoTargetDir },
});

const builtPaths = buildBinBaseNames.map((name) => path.join(releaseDir, executableName(name)));
if (!options.dryRun) {
  const missingPaths = builtPaths.filter((builtPath) => !fs.existsSync(builtPath));
  if (missingPaths.length > 0) {
    throw new Error(`Expected Qwen3 MLX binaries were not built:\n${missingPaths.join("\n")}`);
  }
}

for (const builtPath of builtPaths) {
  console.log(`Qwen3 MLX binary: ${builtPath}`);
}
const workerPath = path.join(releaseDir, executableName(workerBaseName));
const ttsPath = path.join(releaseDir, executableName(customVoiceTtsBaseName));
const apiServerPath = path.join(releaseDir, executableName("api_server"));
console.log(`Set OPEN_TTS_QWEN3_MLX_WORKER=${workerPath}`);
console.log(`Set OPEN_TTS_QWEN3_MLX_TTS=${ttsPath}`);
console.log(`Set OPEN_TTS_QWEN3_MLX_API_SERVER=${apiServerPath}`);

function executableName(baseName) {
  return `${baseName}${executableSuffix}`;
}

function readCargoBinNames(cargoTomlPath) {
  if (!fs.existsSync(cargoTomlPath)) return null;
  const cargoToml = fs.readFileSync(cargoTomlPath, "utf8");
  const names = new Set();
  const explicitPaths = new Set();
  for (const sectionMatch of cargoToml.matchAll(/\[\[bin\]\]([\s\S]*?)(?=\n\[|$)/g)) {
    const section = sectionMatch[1];
    const name = section.match(/name\s*=\s*"([^"]+)"/)?.[1];
    const explicitPath = section.match(/path\s*=\s*"([^"]+)"/)?.[1];
    if (name) names.add(name);
    if (explicitPath) explicitPaths.add(path.normalize(explicitPath));
  }
  const srcBinDir = path.join(path.dirname(cargoTomlPath), "src", "bin");
  if (fs.existsSync(srcBinDir)) {
    for (const entry of fs.readdirSync(srcBinDir, { withFileTypes: true })) {
      const relativePath = path.normalize(path.join("src", "bin", entry.name));
      if (entry.isFile() && entry.name.endsWith(".rs") && !explicitPaths.has(relativePath)) {
        names.add(path.basename(entry.name, ".rs"));
      }
    }
  }
  return names.size > 0 ? [...names] : null;
}

function run(command, args, { cwd, env = process.env }) {
  const line = [command, ...args].join(" ");
  if (options.dryRun) {
    console.log(`[dry-run] (${cwd}) ${line}`);
    return;
  }
  execFileSync(command, args, { cwd, env, stdio: "inherit" });
}

function applyPatchIfNeeded(sourceDir, patchPath) {
  if (!fs.existsSync(patchPath)) return;

  if (options.dryRun) {
    console.log(`[dry-run] (${sourceDir}) git apply --check ${patchPath}`);
    console.log(`[dry-run] (${sourceDir}) git apply ${patchPath}`);
    return;
  }

  if (canRun("git", ["apply", "--check", patchPath], sourceDir)) {
    run("git", ["apply", patchPath], { cwd: sourceDir });
    return;
  }

  if (canRun("git", ["apply", "--reverse", "--check", patchPath], sourceDir)) {
    console.log(`Qwen3 MLX patch already applied: ${patchPath}`);
    return;
  }

  throw new Error(
    `Could not apply Qwen3 MLX patch ${patchPath}. The upstream checkout may have changed; inspect ${sourceDir}.`,
  );
}

function canRun(command, args, cwd) {
  try {
    execFileSync(command, args, { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function resolveCargoTargetDir(sourceDir) {
  if (process.env.OPEN_TTS_QWEN3_MLX_TARGET_DIR) {
    return path.resolve(process.env.OPEN_TTS_QWEN3_MLX_TARGET_DIR);
  }
  // libtool/autotools break when the checkout path contains whitespace.
  if (/\s/.test(sourceDir)) {
    return path.join(os.tmpdir(), "open-tts-qwen3-mlx-target");
  }
  if (process.env.CARGO_TARGET_DIR) {
    return path.resolve(process.env.CARGO_TARGET_DIR);
  }
  return path.join(sourceDir, "target");
}

function parseArgs(args) {
  const parsed = {
    dryRun: false,
    allBins: false,
    help: false,
    noNetwork: false,
    repoUrl: undefined,
    skipPatches: false,
    skipClone: false,
    sourceDir: undefined,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--all-bins":
      case "--all-tools":
        parsed.allBins = true;
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--no-network":
        parsed.noNetwork = true;
        break;
      case "--repo-url":
        parsed.repoUrl = requireValue(args, ++index, arg);
        break;
      case "--skip-patches":
        parsed.skipPatches = true;
        break;
      case "--skip-clone":
        parsed.skipClone = true;
        break;
      case "--source-dir":
        parsed.sourceDir = requireValue(args, ++index, arg);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function printUsage() {
  console.log(`Build the upstream Qwen3 MLX CustomVoice tool, clone worker, and optional tools.

Usage:
  node scripts/build-qwen3-mlx-worker.mjs [options]

Options:
  --all-bins          Build every upstream MLX binary instead of only tts + pibot-tts-worker
  --source-dir <path>  Source checkout directory (default: rust/qwen3_tts_rs)
  --repo-url <url>     Git repository URL (default: ${defaultRepoUrl})
  --skip-clone         Require --source-dir to already exist
  --skip-patches       Do not apply bundled compatibility patches
  --no-network         Do not clone or update submodules
  --dry-run            Print commands without running them
  --help               Show this help
`);
}
