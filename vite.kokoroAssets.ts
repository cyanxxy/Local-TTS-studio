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
const KOKORO_ENV_WASM_PATHS_ONLY_RE =
  /const\s+(\w+)=\{set wasmPaths\((\w+)\)\{(\w+)\.backends\.onnx\.wasm\.wasmPaths=\2\},get wasmPaths\(\)\{return \3\.backends\.onnx\.wasm\.wasmPaths\}\};/;

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

function exposeKokoroWasmThreadConfig(code: string): string {
  return code.replace(
    KOKORO_ENV_WASM_PATHS_ONLY_RE,
    (
      match: string,
      envName: string,
      valueName: string,
      runtimeEnvName: string,
    ) => {
      if (!match.includes("numThreads")) {
        return `const ${envName}={set wasmPaths(${valueName}){${runtimeEnvName}.backends.onnx.wasm.wasmPaths=${valueName}},get wasmPaths(){return ${runtimeEnvName}.backends.onnx.wasm.wasmPaths},set numThreads(${valueName}){${runtimeEnvName}.backends.onnx.wasm.numThreads=${valueName}},get numThreads(){return ${runtimeEnvName}.backends.onnx.wasm.numThreads}};`;
      }
      return match;
    },
  );
}

function transformKokoroBrowserBuild(code: string): string {
  return exposeKokoroWasmThreadConfig(suppressKokoroBundledJsepWasmWarning(code));
}

function resolveKokoroBrowserBuild(rootDir: string): string {
  return resolve(rootDir, `.${KOKORO_BROWSER_BUILD_SUFFIX}`);
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

      const transformed = transformKokoroBrowserBuild(code);
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

        // Shipped byte-for-byte (after the two source fixes above) instead of
        // being bundled: Rolldown's rewrite of the embedded espeak-ng runtime
        // leaves it with an empty voice list, so every phonemization fails
        // with `Invalid language identifier: "en-us"`.
        const kokoroReferenceId = this.emitFile({
          type: "asset",
          name: "kokoro.web.js",
          source: transformKokoroBrowserBuild(readFileSync(resolveKokoroBrowserBuild(rootDir), "utf8")),
        });

        return [
          `import wasmUrl from ${JSON.stringify(`${wasmPath}?url`)};`,
          `const mjsUrl = import.meta.ROLLUP_FILE_URL_${mjsReferenceId};`,
          "export const KOKORO_ONNX_JSEP_ASSETS = { mjs: mjsUrl, wasm: wasmUrl };",
          `export const KOKORO_WEB_MODULE_URL = import.meta.ROLLUP_FILE_URL_${kokoroReferenceId};`,
        ].join("\n");
      }

      // Dev serves the file as its own module through `transform` above, which
      // keeps it out of dependency pre-bundling for the same reason.
      return [
        `import mjsUrl from ${JSON.stringify(`${mjsPath}?url`)};`,
        `import wasmUrl from ${JSON.stringify(`${wasmPath}?url`)};`,
        `import kokoroUrl from ${JSON.stringify(`${resolveKokoroBrowserBuild(rootDir)}?url`)};`,
        "export const KOKORO_ONNX_JSEP_ASSETS = { mjs: mjsUrl, wasm: wasmUrl };",
        "export const KOKORO_WEB_MODULE_URL = kokoroUrl;",
      ].join("\n");
    },
  };
}
