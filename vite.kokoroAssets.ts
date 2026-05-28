import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizePath, type Plugin } from "vite";

const VIRTUAL_MODULE_ID = "virtual:kokoro-onnx-wasm-assets";
const RESOLVED_VIRTUAL_MODULE_ID = `\0${VIRTUAL_MODULE_ID}`;
const KOKORO_ONNX_RUNTIME_DIST_CANDIDATES = [
  "node_modules/kokoro-js/node_modules/onnxruntime-web/dist",
  "node_modules/onnxruntime-web/dist",
];
const KOKORO_BROWSER_BUILD_SUFFIX = "/node_modules/kokoro-js/dist/kokoro.web.js";
const KOKORO_BUNDLED_JSEP_WASM_URL_RE =
  /new URL\(\s*(["'])ort-wasm-simd-threaded\.jsep\.wasm\1\s*,\s*import\.meta\.url\s*\)/g;

function isKokoroBrowserBuild(id: string): boolean {
  return normalizePath(id).split("?")[0].endsWith(KOKORO_BROWSER_BUILD_SUFFIX);
}

function suppressKokoroBundledJsepWasmWarning(code: string): string {
  return code.replace(
    KOKORO_BUNDLED_JSEP_WASM_URL_RE,
    (_, quote: string) =>
      `new URL(/* @vite-ignore */ ${quote}ort-wasm-simd-threaded.jsep.wasm${quote}, import.meta.url)`,
  );
}

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
  let isBuild = false;

  return {
    name: "open-tts:kokoro-onnx-wasm-assets",
    enforce: "pre",
    configResolved(config) {
      isBuild = config.command === "build";
    },
    resolveId(id) {
      return id === VIRTUAL_MODULE_ID ? RESOLVED_VIRTUAL_MODULE_ID : null;
    },
    transform(code, id) {
      if (!isKokoroBrowserBuild(id)) return null;

      const transformed = suppressKokoroBundledJsepWasmWarning(code);
      return transformed === code ? null : { code: transformed, map: null };
    },
    load(id) {
      if (id !== RESOLVED_VIRTUAL_MODULE_ID) return null;

      const mjsPath = resolveKokoroOnnxRuntimeAsset(rootDir, "ort-wasm-simd-threaded.jsep.mjs");
      const wasmPath = resolveKokoroOnnxRuntimeAsset(rootDir, "ort-wasm-simd-threaded.jsep.wasm");

      if (isBuild) {
        const mjsReferenceId = this.emitFile({
          type: "asset",
          name: "ort-wasm-simd-threaded.jsep.mjs",
          source: readFileSync(mjsPath),
        });

        return [
          `import wasmUrl from ${JSON.stringify(`${wasmPath}?url`)};`,
          `const mjsUrl = import.meta.ROLLUP_FILE_URL_${mjsReferenceId};`,
          "export const KOKORO_ONNX_JSEP_ASSETS = { mjs: mjsUrl, wasm: wasmUrl };",
        ].join("\n");
      }

      return [
        `import mjsUrl from ${JSON.stringify(`${mjsPath}?url`)};`,
        `import wasmUrl from ${JSON.stringify(`${wasmPath}?url`)};`,
        "export const KOKORO_ONNX_JSEP_ASSETS = { mjs: mjsUrl, wasm: wasmUrl };",
      ].join("\n");
    },
  };
}
