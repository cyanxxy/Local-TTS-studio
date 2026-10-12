import { describe, expect, it } from "vitest";
import { CHATTERBOX_TURBO_ASSETS } from "../workers/manifests/chatterbox";
import { CHATTERBOX_DTYPE } from "./chatterboxRuntime";
import {
  CHATTERBOX_DEFAULT_VOICE,
  CHATTERBOX_MODEL_ID,
  CHATTERBOX_MODEL_REVISION,
  getChatterboxAssetManifest,
} from "./chatterboxModel";

describe("Chatterbox Turbo pins", () => {
  it("pins the official ONNX export and the default voice to full commit hashes", () => {
    expect(CHATTERBOX_MODEL_ID).toBe("ResembleAI/chatterbox-turbo-ONNX");
    expect(CHATTERBOX_MODEL_REVISION).toMatch(/^[0-9a-f]{40}$/);
    expect(CHATTERBOX_DEFAULT_VOICE.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(CHATTERBOX_DEFAULT_VOICE.integrity.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("pins every large file by SHA-256", () => {
    for (const [file, entry] of Object.entries(CHATTERBOX_TURBO_ASSETS.files)) {
      if (file.endsWith(".onnx_data")) expect(entry).toHaveProperty("sha256");
    }
  });
});

describe("getChatterboxAssetManifest", () => {
  it("lists the tokenizer, configs and the four graphs of the dtype plan", () => {
    expect(Object.keys(getChatterboxAssetManifest(CHATTERBOX_DTYPE)).sort()).toEqual([
      "config.json",
      "generation_config.json",
      "onnx/conditional_decoder_q4.onnx",
      "onnx/conditional_decoder_q4.onnx_data",
      "onnx/embed_tokens.onnx",
      "onnx/embed_tokens.onnx_data",
      "onnx/language_model_q4.onnx",
      "onnx/language_model_q4.onnx_data",
      "onnx/speech_encoder_q4.onnx",
      "onnx/speech_encoder_q4.onnx_data",
      "tokenizer.json",
      "tokenizer_config.json",
    ]);
  });

  it("fails up front for a graph the manifest does not pin", () => {
    expect(() => getChatterboxAssetManifest({ ...CHATTERBOX_DTYPE, language_model: "fp16" }))
      .toThrow(/language_model_fp16\.onnx is not part of the pinned manifest/);
  });
});
