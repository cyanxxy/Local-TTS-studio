import { describe, expect, it } from "vitest";
import { CHATTERBOX_TAG_TOKENS } from "../lib/chatterboxTags";
import { chunkChatterboxText } from "../lib/phonemeModels";
import type { GenerationTuningSettings } from "../types";
import {
  CHATTERBOX_DOWNLOAD_BYTES,
  CHATTERBOX_MAX_SEED,
  chatterboxClipVoice,
  chatterboxEngine,
  isChatterboxClipVoice,
} from "./chatterbox";
import { browserEngineVoiceLabel, browserEngineWorkerFields, engineRequiresWebGPU, ENGINES } from "./registry";
import type { AnyEngineDescriptor } from "./types";

const TUNING: GenerationTuningSettings = {
  speed: 1,
  quality: 5,
  language: "en",
  pauseOverridesSec: { none: 0, comma: 0.1, sentence: 0.2, paragraph: 0.3 },
};
const CLIP = chatterboxClipVoice("0123456789abcdef", "My narrator.wav");

describe("Chatterbox Turbo engine descriptor", () => {
  it("is a desktop browser-worker engine that needs WebGPU, with cloning, seed and tags", () => {
    expect(chatterboxEngine).toMatchObject({ id: "chatterbox", runtime: "browser-worker", picker: "browser", targets: ["desktop"] });
    expect(engineRequiresWebGPU("chatterbox")).toBe(true);
    expect(engineRequiresWebGPU("kokoro")).toBe(false);
    expect(chatterboxEngine.capabilities).toEqual({
      speed: false,
      pauses: true,
      pronunciationLexicon: true,
      quality: null,
      languages: ["en"],
      voiceCloning: { reference: "wav", maxSeconds: 10 },
      voiceDesign: false,
      instruct: false,
      seed: true,
      expressionTags: CHATTERBOX_TAG_TOKENS,
      retake: true,
      streamingGranularity: "chunk",
    });
    expect(chatterboxEngine.capabilities.expressionTags).toContain("[laugh]");
  });

  it("downloads about 0.9 GB the first time", () => {
    expect(CHATTERBOX_DOWNLOAD_BYTES / 1e9).toBeGreaterThan(0.8);
    expect(CHATTERBOX_DOWNLOAD_BYTES / 1e9).toBeLessThan(1.1);
  });

  it("keeps valid settings and replaces unreadable fields with the defaults", () => {
    expect(chatterboxEngine.defaultSettings).toEqual({ voice: "chatterbox-default", temperature: 0.8, seed: null });
    expect(chatterboxEngine.parseSettings({ voice: CLIP, temperature: 1.2, seed: 42 }))
      .toEqual({ voice: CLIP, temperature: 1.2, seed: 42 });
    expect(chatterboxEngine.parseSettings({ temperature: 9 }).temperature).toBe(2);
    expect(chatterboxEngine.parseSettings({ temperature: -1 }).temperature).toBe(0);
    expect(chatterboxEngine.parseSettings({ temperature: "hot" }).temperature).toBe(0.8);
    for (const seed of [-1, 1.5, CHATTERBOX_MAX_SEED + 1, "7", Number.NaN]) {
      expect(chatterboxEngine.parseSettings({ seed }).seed, String(seed)).toBeNull();
    }
    expect(chatterboxEngine.parseSettings({ seed: CHATTERBOX_MAX_SEED }).seed).toBe(CHATTERBOX_MAX_SEED);
    for (const voice of ["", 7, "x".repeat(201), null]) {
      expect(chatterboxEngine.parseSettings({ voice }).voice, String(voice)).toBe("chatterbox-default");
    }
    for (const garbage of [undefined, null, 42, "x", []]) {
      expect(chatterboxEngine.parseSettings(garbage)).toEqual(chatterboxEngine.defaultSettings);
    }
  });

  it("names a loaded clip's voice by its content and shows the file name", () => {
    expect(CLIP).toBe("0123456789abcdef~My narrator");
    expect(chatterboxClipVoice("abc", "   ")).toBe("abc~Cloned voice");
    expect(chatterboxClipVoice("abc", "x".repeat(100)).length).toBe("abc~".length + 60);
    expect(isChatterboxClipVoice(CLIP)).toBe(true);
    expect(isChatterboxClipVoice("chatterbox-default")).toBe(false);
    expect(chatterboxEngine.voices()).toEqual([{ id: "chatterbox-default", label: "Default voice", detail: "Built-in sample" }]);
    expect(chatterboxEngine.voiceLabel({ ...chatterboxEngine.defaultSettings, voice: CLIP })).toBe("My narrator");
    expect(chatterboxEngine.voiceLabel(chatterboxEngine.defaultSettings)).toBe("Default voice");
    expect(chatterboxEngine.voiceLabel({ ...chatterboxEngine.defaultSettings, voice: "no-name" })).toBe("Cloned voice");
    expect(chatterboxEngine.detail({ ...chatterboxEngine.defaultSettings, voice: CLIP })).toBe("350M · My narrator");
    expect(browserEngineVoiceLabel("chatterbox", CLIP)).toBe("My narrator");
  });

  it("signs the reference, temperature and seed, and only the Creator inputs the worker applies", () => {
    const sign = (patch: object, tuning = TUNING) => chatterboxEngine.signatureParts({
      settings: { ...chatterboxEngine.defaultSettings, ...patch },
      tuning,
      quality: 5,
    });
    const base = sign({});
    expect(base?.tuning).toEqual({ pauseOverridesSec: TUNING.pauseOverridesSec, pronunciationRules: undefined, emphasisStrength: undefined });
    for (const patch of [{ voice: CLIP }, { temperature: 1 }, { seed: 3 }]) expect(sign(patch)).not.toEqual(base);
    // It has no speed input, so speed must not discard its cached audio.
    const faster = sign({}, { ...TUNING, speed: 1.1 });
    expect(faster?.tuning).toEqual(base?.tuning);
    expect(faster?.voice).toBe(base?.voice);
    expect(base?.legacy).toMatchObject({ quality: 5 });
  });

  it("sends the worker its reference and sampling, and the seed only when one is set", () => {
    expect(browserEngineWorkerFields("chatterbox", { voice: CLIP, temperature: 0.4, seed: 9 }))
      .toEqual({ referenceId: CLIP, temperature: 0.4, seed: 9 });
    expect(browserEngineWorkerFields("chatterbox", chatterboxEngine.defaultSettings))
      .toEqual({ referenceId: "chatterbox-default", temperature: 0.8 });
    expect(browserEngineWorkerFields("kokoro", ENGINES.kokoro.defaultSettings)).toEqual({});
  });

  it("previews the passages the worker generates and none for blank text", () => {
    const context = { settings: chatterboxEngine.defaultSettings, backend: "webgpu" as const, quality: 5 };
    const text = "Hello there, this is a test of the preview. [laugh] And here is a second sentence to speak.";
    expect((chatterboxEngine as AnyEngineDescriptor).previewChunks(text, context)).toEqual(chunkChatterboxText(text));
    expect((chatterboxEngine as AnyEngineDescriptor).previewChunks("   ", context)).toEqual([]);
  });

  it("skips passages made only of directions it cannot perform", () => {
    expect(chunkChatterboxText("[waves hello]")).toEqual([]);
    expect(chunkChatterboxText("[laugh]")).toHaveLength(1);
    expect(chunkChatterboxText("Spoken words here.")).toHaveLength(1);
  });

  it("credits Resemble AI's model under its licence", () => {
    expect(chatterboxEngine.credits[0]).toMatchObject({ author: "Resemble AI", license: "MIT" });
    expect(chatterboxEngine.credits[0].sourceUrl).toMatch(/^https:\/\/huggingface\.co\/ResembleAI\//);
  });
});
