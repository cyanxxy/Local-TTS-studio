import { describe, expect, it } from "vitest";
import { SUPERTONIC3_MODEL_ID, SUPERTONIC3_MODEL_REVISION, SUPERTONIC3_VOICES } from "../../constants";
import { SUPERTONIC3_ASSETS } from "./supertonic3";

describe("Supertonic 3 asset manifest", () => {
  it("pins the repository and revision the worker downloads", () => {
    // A revision bump must regenerate the manifest with scripts/pin-hf-assets.mjs.
    expect(SUPERTONIC3_ASSETS.repo).toBe(SUPERTONIC3_MODEL_ID);
    expect(SUPERTONIC3_ASSETS.revision).toBe(SUPERTONIC3_MODEL_REVISION);
  });

  it("covers every model file and voice style the worker can load", () => {
    expect(Object.keys(SUPERTONIC3_ASSETS.files)).toEqual(expect.arrayContaining([
      "onnx/tts.json",
      "onnx/unicode_indexer.json",
      "onnx/duration_predictor.onnx",
      "onnx/text_encoder.onnx",
      "onnx/vector_estimator.onnx",
      "onnx/vocoder.onnx",
      ...SUPERTONIC3_VOICES.map((voice) => `voice_styles/${voice}.json`),
    ]));
  });
});
