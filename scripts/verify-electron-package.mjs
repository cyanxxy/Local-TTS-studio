import fs from "node:fs";
import path from "node:path";
import * as asar from "@electron/asar";

export const MAX_ASAR_BYTES = 2 * 1024 * 1024 * 1024;
export const ALLOWED_TOP_LEVEL = new Set(["dist", "dist-electron", "node_modules", "package.json"]);
const TARGET_ORT_DIRECTORY = {
  darwin: "darwin",
  win32: "win32",
};

function resourcesDirectory(context) {
  if (context.electronPlatformName === "darwin") {
    return path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources");
  }
  return path.join(context.appOutDir, "resources");
}

function verifyArchive(archivePath) {
  const size = fs.statSync(archivePath).size;
  if (size > MAX_ASAR_BYTES) {
    throw new Error(`Packaged app.asar is unexpectedly large (${size} bytes).`);
  }
  const entries = asar.listPackage(archivePath);
  const unexpected = entries.filter((entry) => {
    // asar builds entries with path.join, so a Windows host reports "\dist\index.html".
    const top = entry.split(/[\\/]/).filter(Boolean)[0];
    return top && !ALLOWED_TOP_LEVEL.has(top);
  });
  if (unexpected.length > 0) {
    throw new Error(`Packaged app.asar contains workspace files: ${unexpected.slice(0, 10).join(", ")}`);
  }
}

// electron-builder's Arch enum, as afterPack reports it.
const ARCH_NAMES = ["ia32", "x64", "armv7l", "arm64", "universal"];

// What a Windows package cannot start the bridge or load onnxruntime without:
// the bridge itself and the Visual C++ runtime, both beside the bridge and
// beside the app executable (see copyMsvcRuntime in build-rust-bridge.mjs).
const WINDOWS_RUNTIME_FILES = ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll"];

export function missingWindowsRuntimeFiles(appOutDir, resourcesPath, exists = fs.existsSync) {
  const bridgeDir = path.join(resourcesPath, "dist-rust");
  return [
    path.join(bridgeDir, "open-tts-local-bridge.exe"),
    path.join(bridgeDir, "open-tts-hf-xet-downloader.exe"),
    ...WINDOWS_RUNTIME_FILES.flatMap((name) => [path.join(bridgeDir, name), path.join(appOutDir, name)]),
  ].filter((file) => !exists(file));
}

function verifyWindowsRuntime(context, resourcesPath) {
  const missing = missingWindowsRuntimeFiles(context.appOutDir, resourcesPath);
  if (missing.length > 0) {
    throw new Error(`Packaged Windows app is missing runtime files: ${missing.join(", ")}`);
  }
  // The onnxruntime-node pruning keeps one Windows architecture through an
  // extglob; a glob that silently stopped matching would ship all of them.
  const ortWin32 = path.join(resourcesPath, "app.asar.unpacked", "node_modules", "onnxruntime-node", "bin", "napi-v6", "win32");
  const arches = fs.readdirSync(ortWin32, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const expected = ARCH_NAMES[context.arch];
  if (arches.length !== 1 || arches[0] !== expected) {
    throw new Error(`Packaged ONNX Runtime Windows architectures are ${arches.join(", ") || "none"}; expected ${expected}.`);
  }
}

function verifyNativeRuntime(resourcesPath, platform) {
  const nativeRoot = path.join(
    resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    "onnxruntime-node",
    "bin",
    "napi-v6",
  );
  const platforms = fs.readdirSync(nativeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const expected = TARGET_ORT_DIRECTORY[platform];
  if (!expected || platforms.length !== 1 || platforms[0] !== expected) {
    throw new Error(`Packaged ONNX Runtime platforms are ${platforms.join(", ") || "none"}; expected ${expected}.`);
  }
}

export default async function verifyElectronPackage(context) {
  const resourcesPath = resourcesDirectory(context);
  verifyArchive(path.join(resourcesPath, "app.asar"));
  verifyNativeRuntime(resourcesPath, context.electronPlatformName);
  if (context.electronPlatformName === "win32") verifyWindowsRuntime(context, resourcesPath);
}
