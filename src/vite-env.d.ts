/// <reference types="vite/client" />

declare module "virtual:kokoro-onnx-wasm-assets" {
  export const KOKORO_ONNX_JSEP_ASSETS: {
    mjs: string;
    wasm: string;
  };
  /** kokoro.web.js, served unbundled so its espeak-ng runtime stays intact. */
  export const KOKORO_WEB_MODULE_URL: string;
}
