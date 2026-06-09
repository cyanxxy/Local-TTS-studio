import { describe, expect, it } from "vitest";
import {
  configureKokoroOnnxRuntime,
  configureTransformersOnnxRuntime,
  getSafeWasmThreadCount,
  type KokoroOnnxWasmAssets,
  type TransformersOnnxWasmAssets,
} from "./onnxRuntime";

const transformersAssets: TransformersOnnxWasmAssets = {
  asyncify: {
    mjs: "/assets/ort-wasm-simd-threaded.asyncify.mjs",
    wasm: "/assets/ort-wasm-simd-threaded.asyncify.wasm",
  },
};

const kokoroAssets: KokoroOnnxWasmAssets = {
  jsep: {
    mjs: "/assets/ort-wasm-simd-threaded.jsep.mjs",
    wasm: "/assets/ort-wasm-simd-threaded.jsep.wasm",
  },
};

describe("onnxRuntime", () => {
  it("forces single-threaded wasm outside an isolated shared-memory context", () => {
    expect(getSafeWasmThreadCount(4, { crossOriginIsolated: false, hasSharedArrayBuffer: true })).toBe(1);
    expect(getSafeWasmThreadCount(4, { crossOriginIsolated: true, hasSharedArrayBuffer: false })).toBe(1);
  });

  it("preserves the configured wasm thread count when isolation is available", () => {
    expect(getSafeWasmThreadCount(4, { crossOriginIsolated: true, hasSharedArrayBuffer: true })).toBe(4);
  });

  it("configures transformers.js to use local asyncify wasm assets", () => {
    const runtimeEnv = {
      backends: {
        onnx: {
          wasm: {},
        },
      },
    };

    configureTransformersOnnxRuntime(runtimeEnv, transformersAssets, {
      backend: "wasm",
      maxWasmThreads: 4,
      crossOriginIsolated: true,
      hasSharedArrayBuffer: true,
    });

    expect(runtimeEnv.backends.onnx.wasm).toMatchObject({
      numThreads: 4,
      wasmPaths: transformersAssets.asyncify,
    });
  });

  it("configures kokoro-js to use local jsep wasm assets", () => {
    const runtimeEnv = {
      wasmPaths: "",
      numThreads: 1,
    };

    configureKokoroOnnxRuntime(runtimeEnv, kokoroAssets);

    expect(runtimeEnv.wasmPaths).toEqual(kokoroAssets.jsep);
  });

  it("configures kokoro-js wasm threads when its env exposes the setting", () => {
    const runtimeEnv = {
      wasmPaths: "",
      numThreads: 1,
    };

    configureKokoroOnnxRuntime(runtimeEnv, kokoroAssets, {
      backend: "wasm",
      maxWasmThreads: 4,
      crossOriginIsolated: true,
      hasSharedArrayBuffer: true,
    });

    expect(runtimeEnv).toMatchObject({
      wasmPaths: kokoroAssets.jsep,
      numThreads: 4,
    });
  });
});
