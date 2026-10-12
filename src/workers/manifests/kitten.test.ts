import { describe, expect, it } from "vitest";
import { KITTEN_ASSETS } from "./kitten";

describe("Kitten TTS asset manifest", () => {
  it("pins a full commit of the fp32 repository under a permissive license", () => {
    expect(KITTEN_ASSETS.repo).toBe("KittenML/kitten-tts-nano-0.8-fp32");
    expect(KITTEN_ASSETS.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(KITTEN_ASSETS.license).toBe("apache-2.0");
  });

  it("covers the graph, the voices and the config, and leaves the int8 graph out", () => {
    expect(Object.keys(KITTEN_ASSETS.files).sort()).toEqual(["config.json", "kitten_tts_nano_v0_8.onnx", "voices.npz"]);
  });
});
