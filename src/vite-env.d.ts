/// <reference types="vite/client" />

declare module "virtual:kokoro-onnx-wasm-assets" {
  export const KOKORO_ONNX_JSEP_ASSETS: {
    mjs: string;
    wasm: string;
  };
}
