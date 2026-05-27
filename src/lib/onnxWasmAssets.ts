import ortAsyncifyMjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import ortAsyncifyWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import { KOKORO_ONNX_JSEP_ASSETS } from "virtual:kokoro-onnx-wasm-assets";
import type { KokoroOnnxWasmAssets, TransformersOnnxWasmAssets } from "./onnxRuntime";

export const TRANSFORMERS_ONNX_WASM_ASSETS: TransformersOnnxWasmAssets = {
  asyncify: {
    mjs: ortAsyncifyMjsUrl,
    wasm: ortAsyncifyWasmUrl,
  },
};

export const KOKORO_ONNX_WASM_ASSETS: KokoroOnnxWasmAssets = {
  jsep: KOKORO_ONNX_JSEP_ASSETS,
};

export const ONNX_WASM_ASSETS = TRANSFORMERS_ONNX_WASM_ASSETS;
