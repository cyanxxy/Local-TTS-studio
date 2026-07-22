import { describe, it, expect } from "vitest";
import {
  MODELS,
  SPEED_MIN,
  SPEED_MAX,
  SPEED_DEFAULT,
  QUALITY_MIN,
  QUALITY_MAX,
  QUALITY_DEFAULT,
  MIN_TEXT_LENGTH,
  MAX_CHUNK_LENGTH,
  SUPERTONIC3_LANGUAGES,
  SUPERTONIC3_MODEL_ID,
  SUPERTONIC3_MODEL_REVISION,
  SUPERTONIC3_VOICES,
} from "./constants";
import type { ModelType } from "./types";

describe("constants", () => {
  it("defines both model configs", () => {
    const keys = Object.keys(MODELS) as ModelType[];
    expect(keys).toContain("kokoro");
    expect(keys).toContain("supertonic");
  });

  it("kokoro has correct default voice", () => {
    expect(MODELS.kokoro.defaultVoice).toBe("af_heart");
  });

  it("supertonic exposes all bundled voice presets", () => {
    expect(MODELS.supertonic.voices).toEqual([
      "Female", "Female 2", "Female 3", "Female 4", "Female 5",
      "Male", "Male 2", "Male 3", "Male 4", "Male 5",
    ]);
  });

  it("pins the Electron-only Supertonic 3 model and its published presets", () => {
    expect(SUPERTONIC3_MODEL_ID).toBe("Supertone/supertonic-3");
    expect(SUPERTONIC3_MODEL_REVISION).toMatch(/^[a-f0-9]{40}$/);
    expect(SUPERTONIC3_VOICES).toHaveLength(10);
    expect(SUPERTONIC3_LANGUAGES).toHaveLength(31);
  });

  it("speed range is valid", () => {
    expect(SPEED_MIN).toBeLessThan(SPEED_MAX);
    expect(SPEED_DEFAULT).toBeGreaterThanOrEqual(SPEED_MIN);
    expect(SPEED_DEFAULT).toBeLessThanOrEqual(SPEED_MAX);
  });

  it("quality range is valid", () => {
    expect(QUALITY_MIN).toBeLessThan(QUALITY_MAX);
    expect(QUALITY_DEFAULT).toBeGreaterThanOrEqual(QUALITY_MIN);
    expect(QUALITY_DEFAULT).toBeLessThanOrEqual(QUALITY_MAX);
  });

  it("text constraints are valid", () => {
    expect(MIN_TEXT_LENGTH).toBeGreaterThan(0);
    expect(MAX_CHUNK_LENGTH).toBeGreaterThan(MIN_TEXT_LENGTH);
  });
});
