import type { Env } from "onnxruntime-common";
import type { InferenceBackend } from "../types";

type OnnxWasmPrefixOrFilePaths = Env.WasmPrefixOrFilePaths;
type OnnxWasmMaybeFilePaths = Exclude<OnnxWasmPrefixOrFilePaths, string>;

export type OnnxWasmFilePaths = OnnxWasmMaybeFilePaths & {
  mjs: NonNullable<OnnxWasmMaybeFilePaths["mjs"]>;
  wasm: NonNullable<OnnxWasmMaybeFilePaths["wasm"]>;
};

export interface TransformersOnnxWasmAssets {
  asyncify: OnnxWasmFilePaths;
}

export interface KokoroOnnxWasmAssets {
  jsep: OnnxWasmFilePaths;
}

interface TransformersOnnxEnv {
  backends: {
    onnx: {
      wasm?: {
        numThreads?: number;
        wasmPaths?: OnnxWasmPrefixOrFilePaths;
      };
    };
  };
}

interface KokoroOnnxEnv {
  wasmPaths: OnnxWasmPrefixOrFilePaths;
}

interface WasmThreadCapabilities {
  crossOriginIsolated?: boolean;
  hasSharedArrayBuffer?: boolean;
}

interface ConfigureTransformersOnnxRuntimeOptions extends WasmThreadCapabilities {
  backend: InferenceBackend;
  maxWasmThreads: number;
}

function supportsMultiThreadedWasm({
  crossOriginIsolated = globalThis.crossOriginIsolated === true,
  hasSharedArrayBuffer = typeof SharedArrayBuffer !== "undefined",
}: WasmThreadCapabilities = {}): boolean {
  return crossOriginIsolated && hasSharedArrayBuffer;
}

export function getSafeWasmThreadCount(
  maxWasmThreads: number,
  capabilities?: WasmThreadCapabilities,
): number {
  if (!Number.isFinite(maxWasmThreads) || maxWasmThreads < 1) {
    return 1;
  }

  return supportsMultiThreadedWasm(capabilities)
    ? Math.max(1, Math.floor(maxWasmThreads))
    : 1;
}

export function configureTransformersOnnxRuntime(
  runtimeEnv: TransformersOnnxEnv,
  assets: TransformersOnnxWasmAssets,
  { backend, maxWasmThreads, ...capabilities }: ConfigureTransformersOnnxRuntimeOptions,
): void {
  const wasmEnv = runtimeEnv.backends.onnx.wasm;
  if (!wasmEnv) return;

  // Transformers.js currently expects the asyncify variant for explicit wasmPaths.
  wasmEnv.wasmPaths = assets.asyncify;

  if (backend === "wasm") {
    wasmEnv.numThreads = getSafeWasmThreadCount(maxWasmThreads, capabilities);
  }
}

export function configureKokoroOnnxRuntime(
  runtimeEnv: KokoroOnnxEnv,
  assets: KokoroOnnxWasmAssets,
): void {
  // kokoro-js bundles its own ORT runtime, so these assets must come from its
  // nested onnxruntime-web version rather than the app-level Transformers.js one.
  runtimeEnv.wasmPaths = assets.jsep;
}
