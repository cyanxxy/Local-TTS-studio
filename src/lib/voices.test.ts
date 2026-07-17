import { describe, expect, it } from "vitest";
import { KOKORO_FALLBACK_VOICES, MODELS } from "../constants";
import { getKokoroFallbackVoices, resolveKokoroVoice } from "./voices";

describe("voices", () => {
  it("resolves requested, default, first, and missing Kokoro voices", () => {
    expect(resolveKokoroVoice("af_bella", ["af_bella", MODELS.kokoro.defaultVoice])).toBe("af_bella");
    expect(resolveKokoroVoice("missing", [MODELS.kokoro.defaultVoice, "af_bella"])).toBe(MODELS.kokoro.defaultVoice);
    expect(resolveKokoroVoice("missing", ["af_bella"])).toBe("af_bella");
    expect(resolveKokoroVoice("missing", [])).toBeNull();
  });

  it("returns a copy of fallback voices", () => {
    const voices = getKokoroFallbackVoices();
    voices.push("mutated");

    expect(voices).toContain("mutated");
    expect(KOKORO_FALLBACK_VOICES).not.toContain("mutated");
    expect(KOKORO_FALLBACK_VOICES).toHaveLength(28);
    expect(KOKORO_FALLBACK_VOICES).toEqual(expect.arrayContaining([
      "am_puck", "am_santa", "bf_alice", "bf_lily",
    ]));
  });
});
