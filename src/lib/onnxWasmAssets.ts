import ortAsyncifyMjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import ortAsyncifyWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import ortJsepMjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url";
import ortJsepWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url";
import { KOKORO_ONNX_JSEP_ASSETS } from "virtual:kokoro-onnx-wasm-assets";
import type { OnnxWasmAssetSet } from "./onnxRuntime";

export const TRANSFORMERS_ONNX_WASM_ASSETS: OnnxWasmAssetSet = {
  asyncify: {
    mjs: ortAsyncifyMjsUrl,
    wasm: ortAsyncifyWasmUrl,
  },
  jsep: {
    mjs: ortJsepMjsUrl,
    wasm: ortJsepWasmUrl,
  },
};

export const KOKORO_ONNX_WASM_ASSETS: OnnxWasmAssetSet = {
  asyncify: TRANSFORMERS_ONNX_WASM_ASSETS.asyncify,
  jsep: KOKORO_ONNX_JSEP_ASSETS,
};

export const ONNX_WASM_ASSETS = TRANSFORMERS_ONNX_WASM_ASSETS;
