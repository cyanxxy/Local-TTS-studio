import { describe, expect, it } from "vitest";
import {
  KOKORO_ONNX_WASM_ASSETS,
  ONNX_WASM_ASSETS,
  TRANSFORMERS_ONNX_WASM_ASSETS,
} from "./onnxWasmAssets";

describe("onnxWasmAssets", () => {
  it("exports resolvable local ONNX runtime asset URLs", () => {
    expect(ONNX_WASM_ASSETS.asyncify.mjs).toContain("ort-wasm-simd-threaded.asyncify");
    expect(ONNX_WASM_ASSETS.asyncify.wasm).toContain("ort-wasm-simd-threaded.asyncify");
  });

  it("exports only the WASM variants each runtime actually uses", () => {
    expect(Object.keys(TRANSFORMERS_ONNX_WASM_ASSETS)).toEqual(["asyncify"]);
    expect(Object.keys(KOKORO_ONNX_WASM_ASSETS)).toEqual(["jsep"]);
  });

  it("keeps Kokoro on the kokoro-js ONNX runtime asset version", () => {
    expect(ONNX_WASM_ASSETS).toBe(TRANSFORMERS_ONNX_WASM_ASSETS);
    expect(KOKORO_ONNX_WASM_ASSETS.jsep.mjs).toContain("kokoro-js");
    expect(KOKORO_ONNX_WASM_ASSETS.jsep.wasm).toContain("kokoro-js");
    expect(KOKORO_ONNX_WASM_ASSETS.jsep.wasm).not.toBe(TRANSFORMERS_ONNX_WASM_ASSETS.asyncify.wasm);
  });
});
