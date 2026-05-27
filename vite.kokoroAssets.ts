import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { normalizePath, type Plugin } from "vite";

const VIRTUAL_MODULE_ID = "virtual:kokoro-onnx-wasm-assets";
const RESOLVED_VIRTUAL_MODULE_ID = `\0${VIRTUAL_MODULE_ID}`;
const KOKORO_ONNX_RUNTIME_DIST_CANDIDATES = [
  "node_modules/kokoro-js/node_modules/onnxruntime-web/dist",
  "node_modules/onnxruntime-web/dist",
];

function resolveKokoroOnnxRuntimeAsset(rootDir: string, filename: string): string {
  for (const runtimeDist of KOKORO_ONNX_RUNTIME_DIST_CANDIDATES) {
    const assetPath = resolve(rootDir, runtimeDist, filename);
    if (existsSync(assetPath)) {
      return normalizePath(assetPath);
    }
  }

  throw new Error(
    `Missing Kokoro ONNX Runtime asset: ${filename}. Check kokoro-js dependency layout before building.`,
  );
}

export function kokoroOnnxWasmAssetPlugin(rootDir: string = process.cwd()): Plugin {
  return {
    name: "open-tts:kokoro-onnx-wasm-assets",
    enforce: "pre",
    resolveId(id) {
      return id === VIRTUAL_MODULE_ID ? RESOLVED_VIRTUAL_MODULE_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_VIRTUAL_MODULE_ID) return null;

      const mjsPath = resolveKokoroOnnxRuntimeAsset(rootDir, "ort-wasm-simd-threaded.jsep.mjs");
      const wasmPath = resolveKokoroOnnxRuntimeAsset(rootDir, "ort-wasm-simd-threaded.jsep.wasm");

      return [
        `import mjsUrl from ${JSON.stringify(`${mjsPath}?url`)};`,
        `import wasmUrl from ${JSON.stringify(`${wasmPath}?url`)};`,
        "export const KOKORO_ONNX_JSEP_ASSETS = { mjs: mjsUrl, wasm: wasmUrl };",
      ].join("\n");
    },
  };
}
