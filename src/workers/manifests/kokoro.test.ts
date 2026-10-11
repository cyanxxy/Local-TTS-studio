import { describe, expect, it } from "vitest";
import { KOKORO_MODEL_ID, KOKORO_MODEL_REVISION } from "../../constants";
import { KOKORO_LOAD_ASSETS } from "./kokoro";

describe("Kokoro asset manifest", () => {
  it("pins the repository and revision the worker downloads", () => {
    // A revision bump must regenerate the manifest with scripts/pin-hf-assets.mjs.
    expect(KOKORO_LOAD_ASSETS.repo).toBe(KOKORO_MODEL_ID);
    expect(KOKORO_LOAD_ASSETS.revision).toBe(KOKORO_MODEL_REVISION);
  });

  it("covers every file a WebGPU or WASM load downloads", () => {
    expect(Object.keys(KOKORO_LOAD_ASSETS.files).sort()).toEqual([
      "config.json",
      "onnx/model.onnx",
      "onnx/model_quantized.onnx",
      "tokenizer.json",
      "tokenizer_config.json",
    ]);
  });
});
