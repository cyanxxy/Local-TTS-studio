import { describe, expect, it } from "vitest";
import type { SurfaceEngineSettings } from "../models/registry";
import type { ReaderListeningProfile } from "./readerDocument";
import { buildListeningProfile, isSurfaceListeningEngine, listeningMatches } from "./readerListening";

const settings = {
  kokoro: { voice: "af_heart" },
  supertonic: { voice: "F1", language: "en" },
  audio8: { voice: "alloy" },
  supertonic3: { voice: "M1", language: "fr" },
  qwen3: {},
  kitten: { voice: "Bella" },
  paradee: { voice: "af_heart" },
  piper: { voice: "en_US-libritts-high#12" },
  chatterbox: { voice: "default" },
} as unknown as SurfaceEngineSettings;

describe("buildListeningProfile", () => {
  it("captures the engine's voice and rate, and language and quality only where it has them", () => {
    expect(buildListeningProfile("kokoro", settings, 5, 1.25, 9)).toEqual({
      engine: "kokoro",
      voice: "af_heart",
      playbackRate: 1.25,
      updatedAt: 9,
    });
    expect(buildListeningProfile("supertonic3", settings, 7, 1, 9)).toMatchObject({
      engine: "supertonic3",
      voice: "M1",
      language: "fr",
      quality: 7,
    });
    expect(buildListeningProfile("qwen3", settings, 5, 1, 9)).toEqual({
      engine: "qwen3",
      voice: "",
      playbackRate: 1,
      updatedAt: 9,
    });
  });
});

describe("buildListeningProfile for the added engines", () => {
  it("captures the voice of Kitten, Paradee, Piper and Chatterbox", () => {
    for (const [engine, voice] of [
      ["kitten", "Bella"],
      ["paradee", "af_heart"],
      ["piper", "en_US-libritts-high#12"],
      ["chatterbox", "default"],
    ] as const) {
      expect(buildListeningProfile(engine, settings, 5, 1, 9)).toMatchObject({ engine, voice });
    }
  });
});

describe("listeningMatches", () => {
  const profile = (overrides: Partial<Omit<ReaderListeningProfile, "engine">>) => ({
    engine: "supertonic3" as const,
    voice: "M1",
    language: "fr",
    quality: 7,
    playbackRate: 1,
    updatedAt: 1,
    ...overrides,
  });

  it("matches when engine, voice, language and quality agree, whatever the speed", () => {
    expect(listeningMatches(profile({ playbackRate: 1.5 }), "supertonic3", settings, 7)).toBe(true);
  });

  it("reports a difference in any input that shapes the audio", () => {
    expect(listeningMatches(profile({}), "kokoro", settings, 7)).toBe(false);
    expect(listeningMatches(profile({ voice: "F2" }), "supertonic3", settings, 7)).toBe(false);
    expect(listeningMatches(profile({ language: "en" }), "supertonic3", settings, 7)).toBe(false);
    expect(listeningMatches(profile({ quality: 3 }), "supertonic3", settings, 7)).toBe(false);
  });

  it("ignores a quality the engine does not read, and Qwen3's voice", () => {
    expect(listeningMatches(
      { engine: "kokoro", voice: "af_heart", quality: 2, playbackRate: 1, updatedAt: 1 },
      "kokoro",
      settings,
      9,
    )).toBe(true);
    expect(listeningMatches(
      { engine: "qwen3", voice: "", playbackRate: 1, updatedAt: 1 },
      "qwen3",
      settings,
      5,
    )).toBe(true);
  });
});

describe("isSurfaceListeningEngine", () => {
  it("accepts engines a surface can drive and rejects unknown or setup-page-only ones", () => {
    const base = { voice: "", playbackRate: 1, updatedAt: 1 };
    expect(isSurfaceListeningEngine({ ...base, engine: "audio8" })).toBe(true);
    expect(isSurfaceListeningEngine({ ...base, engine: "neutts" })).toBe(false);
    expect(isSurfaceListeningEngine({ ...base, engine: "nonsense" })).toBe(false);
  });
});
