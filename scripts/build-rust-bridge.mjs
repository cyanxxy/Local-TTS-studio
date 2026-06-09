import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const crateDir = path.join(rootDir, "rust", "local-tts-bridge");
const manifestPath = path.join(crateDir, "Cargo.toml");
const outDir = path.join(rootDir, "dist-rust");
const binaryName = process.platform === "win32"
  ? "open-tts-local-bridge.exe"
  : "open-tts-local-bridge";
const releaseTargetDir = path.join(crateDir, "target", "release");
const builtBinaryPath = path.join(releaseTargetDir, binaryName);
const copiedBinaryPath = path.join(outDir, binaryName);
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const qwen3MlxToolBaseNames = [
  "pibot-tts-worker",
  "tts",
  "voice_clone",
  "api_server",
  "qwen3-tts",
  "trace_vocoder",
  "trace_rust",
];
const qwen3MlxWorkerName = executableName("pibot-tts-worker");
const qwen3MlxTtsName = executableName("tts");
const nativeLibraryPattern = process.platform === "win32"
  ? /^(ggml|llama|mtmd).*\.dll$/i
  : process.platform === "darwin"
    ? /^lib(ggml|llama|mtmd).*\.dylib$/i
    : /^lib(ggml|llama|mtmd).*\.so(?:\.\d+)*$/i;

if (!fs.existsSync(manifestPath)) {
  throw new Error(`Rust bridge manifest not found at ${manifestPath}`);
}

execFileSync("cargo", ["build", "--release", "--manifest-path", manifestPath], {
  cwd: rootDir,
  stdio: "inherit",
});

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(builtBinaryPath, copiedBinaryPath);
const copiedExecutablePaths = [copiedBinaryPath];

function collectNativeLibraries(dir) {
  if (!fs.existsSync(dir)) return [];
  const found = [];
  const visit = (currentDir) => {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if ((entry.isFile() || entry.isSymbolicLink()) && nativeLibraryPattern.test(entry.name)) {
        found.push(fullPath);
      }
    }
  };
  visit(dir);
  // Final link outputs live at the release root; deeper hits (deps/, build/*/out)
  // can be stale intermediates. Sort shallowest-first (then lexicographically for
  // determinism) so the first file kept per basename is the release-root one.
  return found.sort((a, b) => {
    const depthDelta = a.split(path.sep).length - b.split(path.sep).length;
    return depthDelta !== 0 ? depthDelta : a.localeCompare(b);
  });
}

const copiedNativeLibraries = new Set();
for (const libraryPath of collectNativeLibraries(releaseTargetDir)) {
  const fileName = path.basename(libraryPath);
  if (copiedNativeLibraries.has(fileName)) continue;
  fs.copyFileSync(libraryPath, path.join(outDir, fileName));
  copiedNativeLibraries.add(fileName);
}

if (process.platform !== "win32") {
  fs.chmodSync(copiedBinaryPath, 0o755);
}

const copiedQwen3MlxTools = copyQwen3MlxTools();

if (process.platform === "darwin") {
  for (const executablePath of copiedExecutablePaths) {
    makeSelfContainedDarwin(outDir, executablePath);
  }
}

function executableName(baseName) {
  return `${baseName}${executableSuffix}`;
}

function copyQwen3MlxTools() {
  const sources = resolveQwen3MlxToolSources();
  const copied = [];
  for (const [toolName, sourcePath] of sources) {
    const copiedPath = path.join(outDir, toolName);
    fs.copyFileSync(sourcePath, copiedPath);
    if (process.platform !== "win32") {
      fs.chmodSync(copiedPath, 0o755);
    }
    copiedExecutablePaths.push(copiedPath);
    copied.push(toolName);
    const kind = toolName === qwen3MlxWorkerName ? "worker" : "tool";
    console.log(`Copied Qwen3 MLX ${kind} to ${copiedPath}`);
  }
  return copied;
}

function resolveQwen3MlxToolSources() {
  const sources = new Map();
  const explicitWorker = process.env.OPEN_TTS_QWEN3_MLX_WORKER;
  if (explicitWorker && fs.existsSync(explicitWorker)) {
    sources.set(qwen3MlxWorkerName, explicitWorker);
  }
  const explicitTts = process.env.OPEN_TTS_QWEN3_MLX_TTS;
  if (explicitTts && fs.existsSync(explicitTts)) {
    sources.set(qwen3MlxTtsName, explicitTts);
  }

  for (const releaseDir of qwen3MlxReleaseDirs()) {
    for (const baseName of qwen3MlxToolBaseNames) {
      const toolName = executableName(baseName);
      if (sources.has(toolName)) continue;
      const candidate = path.join(releaseDir, toolName);
      if (fs.existsSync(candidate)) {
        sources.set(toolName, candidate);
      }
    }
  }
  return sources;
}

function qwen3MlxReleaseDirs() {
  const dirs = [];
  const explicitWorker = process.env.OPEN_TTS_QWEN3_MLX_WORKER;
  if (explicitWorker) {
    dirs.push(path.dirname(explicitWorker));
  }
  const explicitTts = process.env.OPEN_TTS_QWEN3_MLX_TTS;
  if (explicitTts) {
    dirs.push(path.dirname(explicitTts));
  }
  const explicitSourceDir = process.env.OPEN_TTS_QWEN3_TTS_RS_DIR;
  if (explicitSourceDir) {
    dirs.push(path.join(explicitSourceDir, "target", "release"));
  }
  dirs.push(
    path.join(os.tmpdir(), "open-tts-qwen3-mlx-target", "release"),
    path.join(rootDir, "rust", "qwen3_tts_rs", "target", "release"),
    path.join(rootDir, "rust", "qwen3-tts-rs", "target", "release"),
    path.join(rootDir, "vendor", "qwen3_tts_rs", "target", "release"),
  );
  return [...new Set(dirs.map((dir) => path.resolve(dir)))];
}

// On macOS the freshly built binary and the copied ggml/llama/mtmd dylibs still
// link against absolute Homebrew paths (e.g. /opt/homebrew/opt/libomp/lib/libomp.dylib,
// openssl@3) that do not exist on end-user machines, so a packaged build would fail
// to launch. Bundle every external dependency next to the binary, rewrite all
// absolute install names to @rpath, add the rpath that resolves @rpath to the
// bundle directory, and re-sign ad-hoc so Gatekeeper/arm64 still loads them.
function makeSelfContainedDarwin(bundleDir, binaryPath) {
  const isExternal = (loadPath) => loadPath.startsWith("/opt/homebrew") || loadPath.startsWith("/usr/local");

  const machoDeps = (file) => {
    const out = execFileSync("otool", ["-L", file], { encoding: "utf8" });
    return out
      .split("\n")
      .slice(1) // first line is the file name
      .map((line) => line.trim().replace(/\s+\(compatibility version.*$/, ""))
      .filter(Boolean);
  };

  const machoId = (file) => {
    const out = execFileSync("otool", ["-D", file], { encoding: "utf8" });
    const lines = out.split("\n").map((line) => line.trim()).filter(Boolean);
    return lines.length > 1 ? lines[1] : null;
  };

  const adhocSign = (file) => {
    try {
      execFileSync("codesign", ["--force", "--sign", "-", file], { stdio: "ignore" });
    } catch {
      // Re-signing is best-effort; install_name_tool already re-signs ad-hoc on
      // recent toolchains. A real Developer ID signature is applied later by
      // electron-builder when configured.
    }
  };

  // 1) Transitively copy every external (Homebrew) dependency into the bundle.
  const dylibsInBundle = () => fs
    .readdirSync(bundleDir)
    .filter((name) => name.endsWith(".dylib"))
    .map((name) => path.join(bundleDir, name));

  const queue = [binaryPath, ...dylibsInBundle()];
  const visited = new Set();
  const copiedExternals = new Set();
  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    for (const dep of machoDeps(file)) {
      if (!isExternal(dep)) continue;
      const base = path.basename(dep);
      const dest = path.join(bundleDir, base);
      if (copiedExternals.has(base) || fs.existsSync(dest)) continue;
      if (!fs.existsSync(dep)) {
        console.warn(`Warning: external dependency not found, cannot bundle: ${dep}`);
        continue;
      }
      fs.copyFileSync(dep, dest); // follows symlinks into the Cellar
      fs.chmodSync(dest, 0o755);
      copiedExternals.add(base);
      queue.push(dest); // the copied library may pull in further externals
    }
  }

  // 2) Rewrite install names on the binary and every bundled dylib to @rpath,
  //    add the resolving rpath, and re-sign.
  for (const file of [binaryPath, ...dylibsInBundle()]) {
    const isDylib = file.endsWith(".dylib");
    const ownId = isDylib ? machoId(file) : null;
    if (isDylib) {
      try {
        execFileSync("install_name_tool", ["-id", `@rpath/${path.basename(file)}`, file], { stdio: "ignore" });
      } catch {
        // ignore — id may already be @rpath on a rebuild
      }
    }
    for (const dep of machoDeps(file)) {
      if (!isExternal(dep) || dep === ownId) continue;
      try {
        execFileSync("install_name_tool", ["-change", dep, `@rpath/${path.basename(dep)}`, file], { stdio: "ignore" });
      } catch {
        // ignore — reference may already be rewritten on a rebuild
      }
    }
    try {
      execFileSync("install_name_tool", ["-add_rpath", isDylib ? "@loader_path" : "@executable_path", file], {
        stdio: "ignore",
      });
    } catch {
      // The rpath may already be present when rebuilding the same artifact.
    }
    adhocSign(file);
  }

  if (copiedExternals.size > 0) {
    console.log(`Bundled ${copiedExternals.size} external macOS dependencies: ${[...copiedExternals].join(", ")}`);
  }
}

console.log(`Copied Rust bridge to ${copiedBinaryPath}`);
if (copiedQwen3MlxTools.length > 0) {
  console.log(`Copied ${copiedQwen3MlxTools.length} Qwen3 MLX binaries to ${outDir}`);
}
if (copiedNativeLibraries.size > 0) {
  console.log(`Copied ${copiedNativeLibraries.size} native bridge libraries to ${outDir}`);
}
