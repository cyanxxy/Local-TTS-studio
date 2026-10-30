import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MSVC_RUNTIME_MIN_VERSION, msvcRedistVersionIsCurrent } from "./msvc-runtime.mjs";
import { resolveRustTargetDir, rustBuildEnv } from "./rust-target-dir.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const crateDir = path.join(rootDir, "rust", "local-tts-bridge");
const manifestPath = path.join(crateDir, "Cargo.toml");
const outDir = path.join(rootDir, "dist-rust");
const binaryName = process.platform === "win32"
  ? "open-tts-local-bridge.exe"
  : "open-tts-local-bridge";
const xetDownloaderBinaryName = process.platform === "win32"
  ? "open-tts-hf-xet-downloader.exe"
  : "open-tts-hf-xet-downloader";
const targetDir = resolveRustTargetDir(rootDir);
const releaseTargetDir = path.join(targetDir, "release");
const builtBinaryPath = path.join(releaseTargetDir, binaryName);
const copiedBinaryPath = path.join(outDir, binaryName);
const builtXetDownloaderPath = path.join(releaseTargetDir, xetDownloaderBinaryName);
const copiedXetDownloaderPath = path.join(outDir, xetDownloaderBinaryName);
const nativeLibraryPattern = process.platform === "win32"
  ? /^(?:ggml|llama|mtmd|torch|c10|asmjit|fbgemm|uv|libiomp|cudart|cublas|cufft|curand|cusparse|nvrtc|nvToolsExt|zlib|shm|kineto|omp).*\.dll$/i
  : process.platform === "darwin"
    ? /^lib(ggml|llama|mtmd).*\.dylib$/i
    : /^lib(ggml|llama|mtmd).*\.so(?:\.\d+)*$/i;

// The Visual C++ runtime's redistributable DLLs; see copyMsvcRuntime.
const MSVC_RUNTIME_DLL = /^(?:vcruntime140(?:_\d+)?|msvcp140(?:_[a-z0-9_]+)?|concrt140|vccorlib140|vcomp140)\.dll$/i;

if (!fs.existsSync(manifestPath)) {
  throw new Error(`Rust bridge manifest not found at ${manifestPath}`);
}
if (process.platform === "win32" && process.arch !== "x64") {
  throw new Error(`Windows desktop packaging supports x64 only (received ${process.arch}).`);
}

execFileSync("cargo", ["build", "--locked", "--release", "--manifest-path", manifestPath], {
  cwd: rootDir,
  env: rustBuildEnv(rootDir),
  stdio: "inherit",
});

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(builtBinaryPath, copiedBinaryPath);
fs.copyFileSync(builtXetDownloaderPath, copiedXetDownloaderPath);

function collectNativeLibraries(dir, pattern = nativeLibraryPattern) {
  if (!fs.existsSync(dir)) return [];
  const found = [];
  const visit = (currentDir) => {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if ((entry.isFile() || entry.isSymbolicLink()) && pattern.test(entry.name)) {
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

const directlyLinkedDarwinLibraries = process.platform === "darwin"
  ? new Set([builtBinaryPath, builtXetDownloaderPath].flatMap((executablePath) => execFileSync("otool", ["-L", executablePath], { encoding: "utf8" })
    .split("\n")
    .slice(1)
    .map((line) => line.trim().replace(/\s+\(compatibility version.*$/, ""))
    .map((loadPath) => path.basename(loadPath))
    .filter((name) => nativeLibraryPattern.test(name))))
  : new Set();

const copiedNativeLibraries = new Set();
for (const libraryPath of collectNativeLibraries(releaseTargetDir)) {
  const fileName = path.basename(libraryPath);
  if (process.platform === "darwin" && !directlyLinkedDarwinLibraries.has(fileName)) continue;
  if (process.platform !== "darwin" && process.platform !== "win32" && !/\.so\.0$/i.test(fileName)) continue;
  if (copiedNativeLibraries.has(fileName)) continue;
  fs.copyFileSync(libraryPath, path.join(outDir, fileName));
  copiedNativeLibraries.add(fileName);
}

if (process.platform === "win32") {
  const libtorchDir = process.env.LIBTORCH;
  if (!libtorchDir) {
    throw new Error("Windows release packaging requires LIBTORCH to point to the pinned LibTorch distribution.");
  }
  for (const libraryPath of collectNativeLibraries(path.join(libtorchDir, "lib"), /\.dll$/i)) {
    const fileName = path.basename(libraryPath);
    if (copiedNativeLibraries.has(fileName)) continue;
    fs.copyFileSync(libraryPath, path.join(outDir, fileName));
    copiedNativeLibraries.add(fileName);
  }
}

if (process.platform === "win32") {
  copyMsvcRuntime();
}

if (process.platform !== "win32") {
  fs.chmodSync(copiedBinaryPath, 0o755);
  fs.chmodSync(copiedXetDownloaderPath, 0o755);
}

if (process.platform === "darwin") {
  if (process.arch === "arm64") copyMlxMetallib();
  makeSelfContainedDarwin(outDir, copiedBinaryPath);
  makeSelfContainedDarwin(outDir, copiedXetDownloaderPath);
}

// The bridge, LibTorch, llama.cpp's OpenMP build and onnxruntime-node all link
// the Visual C++ runtime dynamically, and a clean Windows install does not have
// it. Ship the redistributable DLLs app-locally (Microsoft's supported
// alternative to running vc_redist): next to the bridge here, and next to the
// app executable through `win.extraFiles`, for the native modules Electron loads.
// MSVC_RUNTIME_DLL (top of file) names the files.
//
// An app-local runtime is loaded ahead of the one in System32, so it must be at
// least as new as the toolset any shipped binary was built with: a module
// compiled with MSVC 14.40 (VS 2022 17.10) or later crashes in std::mutex on an
// older msvcp140.dll, and the prebuilt onnxruntime-node and sharp addons are
// built with current toolsets. msvcRedistVersionIsCurrent refuses older redists.
function msvcRedistRoots() {
  const roots = [];
  if (process.env.VCToolsRedistDir) roots.push(process.env.VCToolsRedistDir);
  const vswhere = path.join(
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  if (fs.existsSync(vswhere)) {
    const installations = execFileSync(vswhere, [
      "-latest",
      "-products",
      "*",
      "-requires",
      "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "-property",
      "installationPath",
    ], { encoding: "utf8" }).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const installation of installations) {
      const msvcDir = path.join(installation, "VC", "Redist", "MSVC");
      if (!fs.existsSync(msvcDir)) continue;
      const versions = fs.readdirSync(msvcDir)
        .filter((name) => /^\d+(?:\.\d+)+$/.test(name))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      roots.push(...versions.map((version) => path.join(msvcDir, version)));
    }
  }
  return roots;
}

function copyMsvcRuntime() {
  const roots = msvcRedistRoots();
  const outdated = roots.filter((root) => !msvcRedistVersionIsCurrent(root));
  for (const root of roots.filter((candidate) => msvcRedistVersionIsCurrent(candidate))) {
    const archDir = path.join(root, "x64");
    if (!fs.existsSync(archDir)) continue;
    const runtimeDirs = fs.readdirSync(archDir)
      .filter((name) => /^Microsoft\.VC\d+\.(?:CRT|OpenMP)$/i.test(name))
      .map((name) => path.join(archDir, name));
    if (!runtimeDirs.some((dir) => /\.CRT$/i.test(dir))) continue;
    const copied = [];
    for (const dir of runtimeDirs) {
      for (const name of fs.readdirSync(dir)) {
        if (!MSVC_RUNTIME_DLL.test(name) || copiedNativeLibraries.has(name)) continue;
        fs.copyFileSync(path.join(dir, name), path.join(outDir, name));
        copiedNativeLibraries.add(name);
        copied.push(name);
      }
    }
    console.log(`Bundled the Visual C++ runtime from ${archDir}: ${copied.join(", ")}`);
    return;
  }
  if (outdated.length > 0) {
    throw new Error(
      `Windows packaging bundles the Visual C++ runtime, but the newest redistributable found (${outdated[0]}) `
      + `is older than ${MSVC_RUNTIME_MIN_VERSION.join(".")}, which the shipped native modules need. Update the `
      + "Visual Studio C++ build tools (Visual Studio Installer > Update).",
    );
  }
  throw new Error(
    "Windows packaging bundles the Visual C++ runtime, but no x64 redistributable was found. "
    + "Install the Visual Studio C++ build tools, or run from a Developer prompt so VCToolsRedistDir is set.",
  );
}

// MLX first looks next to the running executable for its compiled Metal kernels.
// Package that one resource beside the bridge rather than shipping upstream tools.
function copyMlxMetallib() {
  const metallibName = "mlx.metallib";
  const buildDir = path.join(releaseTargetDir, "build");
  if (fs.existsSync(buildDir)) {
    for (const entry of fs.readdirSync(buildDir).sort()) {
      const candidate = path.join(buildDir, entry, "out", "lib", metallibName);
      if (!fs.existsSync(candidate)) continue;
      const copiedPath = path.join(outDir, metallibName);
      fs.copyFileSync(candidate, copiedPath);
      console.log(`Copied MLX Metal kernels to ${copiedPath}`);
      return;
    }
  }
  throw new Error(
    `The Qwen3 bridge was built without a discoverable ${metallibName}; the packaged MLX runtime would fail.`,
  );
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

const allowedArtifact = (name) => name === binaryName
  || name === xetDownloaderBinaryName
  || (process.platform === "darwin" && process.arch === "arm64" && name === "mlx.metallib")
  || /\.(?:dylib|dll)$/i.test(name)
  || /\.so(?:\.\d+)*$/i.test(name);
const unexpectedArtifacts = fs.readdirSync(outDir).filter((name) => !allowedArtifact(name));
if (unexpectedArtifacts.length > 0) {
  throw new Error(`Unexpected Rust package artifacts: ${unexpectedArtifacts.join(", ")}`);
}
const executableArtifacts = fs.readdirSync(outDir).filter((name) => (
  name === binaryName || name === xetDownloaderBinaryName || /\.exe$/i.test(name)
));
if (
  executableArtifacts.length !== 2
  || !executableArtifacts.includes(binaryName)
  || !executableArtifacts.includes(xetDownloaderBinaryName)
) {
  throw new Error(`Rust package must contain the bridge and Xet downloader executables.`);
}

console.log(`Copied Rust bridge to ${copiedBinaryPath}`);
console.log(`Copied Hugging Face Xet downloader to ${copiedXetDownloaderPath}`);
if (copiedNativeLibraries.size > 0) {
  console.log(`Copied ${copiedNativeLibraries.size} native bridge libraries to ${outDir}`);
}
