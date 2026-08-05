const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");

const MAX_ASAR_BYTES = 2 * 1024 * 1024 * 1024;
const ALLOWED_TOP_LEVEL = new Set(["dist", "dist-electron", "node_modules", "package.json"]);
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
    const top = entry.replace(/^\//, "").split("/", 1)[0];
    return top && !ALLOWED_TOP_LEVEL.has(top);
  });
  if (unexpected.length > 0) {
    throw new Error(`Packaged app.asar contains workspace files: ${unexpected.slice(0, 10).join(", ")}`);
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

module.exports = async function verifyElectronPackage(context) {
  const resourcesPath = resourcesDirectory(context);
  verifyArchive(path.join(resourcesPath, "app.asar"));
  verifyNativeRuntime(resourcesPath, context.electronPlatformName);
};

module.exports.MAX_ASAR_BYTES = MAX_ASAR_BYTES;
module.exports.ALLOWED_TOP_LEVEL = ALLOWED_TOP_LEVEL;
