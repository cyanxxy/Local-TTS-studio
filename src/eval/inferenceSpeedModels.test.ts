import { describe, expect, it } from "vitest";
import {
  MODELS,
  SUPERTONIC3_LANGUAGES,
  SUPERTONIC3_MODEL_ID,
  SUPERTONIC3_MODEL_REVISION,
  SUPERTONIC3_VOICES,
} from "../constants";
import { BENCHMARK_MODEL_INFO, resolveBenchmarkVoice } from "./inferenceSpeedModels";
import { BENCHMARK_MODELS } from "./inferenceSpeedOptions";

describe("BENCHMARK_MODEL_INFO", () => {
  it("describes every benchmark runtime with a pinned revision", () => {
    expect(Object.keys(BENCHMARK_MODEL_INFO).sort()).toEqual([...BENCHMARK_MODELS].sort());
    for (const model of BENCHMARK_MODELS) {
      expect(BENCHMARK_MODEL_INFO[model].modelRevision).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("uses the app's model identifiers and default voices", () => {
    expect(BENCHMARK_MODEL_INFO.kokoro).toEqual({
      modelId: MODELS.kokoro.id,
      modelRevision: MODELS.kokoro.revision,
      defaultVoice: MODELS.kokoro.defaultVoice,
    });
    expect(BENCHMARK_MODEL_INFO.supertonic).toEqual({
      modelId: MODELS.supertonic.id,
      modelRevision: MODELS.supertonic.revision,
      defaultVoice: MODELS.supertonic.defaultVoice,
    });
    expect(BENCHMARK_MODEL_INFO.supertonic3).toMatchObject({
      modelId: SUPERTONIC3_MODEL_ID,
      modelRevision: SUPERTONIC3_MODEL_REVISION,
      defaultVoice: "M1",
    });
  });

  it("gives Supertonic 3 a voice and language its worker accepts", () => {
    const { defaultVoice, language } = BENCHMARK_MODEL_INFO.supertonic3;
    expect(SUPERTONIC3_VOICES).toContain(defaultVoice);
    expect(SUPERTONIC3_LANGUAGES).toContain(language);
  });
});

describe("resolveBenchmarkVoice", () => {
  it("uses the default voice when READY lists no voices", () => {
    expect(resolveBenchmarkVoice("supertonic", undefined)).toBe("Female");
    expect(resolveBenchmarkVoice("kokoro", [])).toBe("af_heart");
  });

  it("uses the default voice when READY lists it", () => {
    expect(resolveBenchmarkVoice("kokoro", ["af_bella", "af_heart"])).toBe("af_heart");
    expect(resolveBenchmarkVoice("supertonic3", [...SUPERTONIC3_VOICES])).toBe("M1");
  });

  it("falls back to the first listed voice when the default is missing", () => {
    expect(resolveBenchmarkVoice("kokoro", ["bf_emma", "am_adam"])).toBe("bf_emma");
  });
});
