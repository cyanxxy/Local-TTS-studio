// @vitest-environment node

import { describe, expect, it } from "vitest";
import { AUDIO8_DEFAULT_VOICE, AUDIO8_VOICE_IDS } from "../../electron/audio8Model";
import {
  LOCAL_MODELS,
  sanitizeNeuttsPayload,
  sanitizeQwen3Payload,
} from "../../electron/localTtsIpc";
import {
  QWEN3_MAX_NEW_TOKENS_PER_PASSAGE,
  QWEN3_MAX_SEED,
  QWEN3_MIN_NEW_TOKENS,
} from "../../electron/localTtsLimits";
import {
  QWEN3_DEFAULT_LANGUAGE,
  QWEN3_DEFAULT_SPEAKER,
  QWEN3_LANGUAGES,
  QWEN3_PROFILES,
  QWEN3_SPEAKER_NATIVE_LANGUAGES,
  QWEN3_SPEAKERS,
} from "../../electron/qwen3Profiles";
import { QWEN3_SPEAKER_OPTIONS, qwen3SupportsInstruct } from "../components/localRuntime/modelOptions";
import { audio8Engine } from "./audio8";
import { NEUTTS_MODEL_OPTIONS } from "./neutts";
import {
  QWEN3_ENGINE_DEFAULT_LANGUAGE,
  QWEN3_ENGINE_DEFAULT_SPEAKER,
  QWEN3_ENGINE_LANGUAGES,
  QWEN3_ENGINE_MAX_SEED,
  QWEN3_ENGINE_SPEAKERS,
  QWEN3_INSTRUCT_MAX_LENGTH,
  QWEN3_MAX_NEW_TOKENS_RANGE,
  QWEN3_TEMPERATURE_RANGE,
  QWEN3_TOP_K_RANGE,
  qwen3Engine,
  qwen3ProfileSupportsInstruct,
} from "./qwen3";
import { ENGINE_REGISTRY } from "./registry";

// The registry is bundled into the web app and may not import `electron/`, so
// the tables it mirrors are pinned to their desktop sources here, the way
// `vite.audio8Catalogue.test.ts` pins the Audio8 display catalogue.

describe("engine registry parity with the desktop runtimes", () => {
  it("offers exactly the Audio8 voices the native worker can synthesise", () => {
    expect(audio8Engine.voices().map((voice) => voice.id)).toEqual([...AUDIO8_VOICE_IDS]);
    expect(audio8Engine.defaultSettings.voice).toBe(AUDIO8_DEFAULT_VOICE);
  });

  it("lists the engines the Rust bridge IPC accepts", () => {
    const bridgeEngines = ENGINE_REGISTRY
      .filter((engine) => engine.runtime === "rust-bridge")
      .map((engine) => engine.id);
    expect([...bridgeEngines].sort()).toEqual([...LOCAL_MODELS].sort());
  });

  it("mirrors the Qwen3 speaker and language tables", () => {
    expect(QWEN3_ENGINE_SPEAKERS.map((speaker) => speaker.id)).toEqual([...QWEN3_SPEAKERS]);
    for (const speaker of QWEN3_ENGINE_SPEAKERS) {
      expect(speaker.nativeLanguage, speaker.id).toBe(QWEN3_SPEAKER_NATIVE_LANGUAGES[speaker.id]);
    }
    expect([...QWEN3_ENGINE_LANGUAGES]).toEqual([...QWEN3_LANGUAGES]);
    expect(QWEN3_ENGINE_DEFAULT_SPEAKER).toBe(QWEN3_DEFAULT_SPEAKER);
    expect(QWEN3_ENGINE_DEFAULT_LANGUAGE).toBe(QWEN3_DEFAULT_LANGUAGE);
    expect(qwen3Engine.voices().map((voice) => voice.id))
      .toEqual(QWEN3_SPEAKER_OPTIONS.map((option) => option.value));
  });

  it("mirrors the Qwen3 sampling limits the IPC validator enforces", () => {
    expect(QWEN3_MAX_NEW_TOKENS_RANGE.min).toBe(QWEN3_MIN_NEW_TOKENS);
    expect(QWEN3_MAX_NEW_TOKENS_RANGE.max).toBe(QWEN3_MAX_NEW_TOKENS_PER_PASSAGE);
    expect(QWEN3_ENGINE_MAX_SEED).toBe(QWEN3_MAX_SEED);

    const profile = QWEN3_PROFILES.find((candidate) => (
      candidate.repo === "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-6bit"
    ))!;
    const accepts = (patch: Record<string, unknown>) => {
      try {
        sanitizeQwen3Payload({
          text: "A short request.",
          mode: profile.mode,
          modelRepo: profile.repo,
          modelPath: "/models/qwen3",
          ...patch,
        }, "darwin", "arm64");
        return true;
      } catch {
        return false;
      }
    };
    expect(accepts({ temperature: QWEN3_TEMPERATURE_RANGE.min })).toBe(true);
    expect(accepts({ temperature: QWEN3_TEMPERATURE_RANGE.max })).toBe(true);
    expect(accepts({ temperature: QWEN3_TEMPERATURE_RANGE.max + 0.01 })).toBe(false);
    expect(accepts({ topK: QWEN3_TOP_K_RANGE.min })).toBe(true);
    expect(accepts({ topK: QWEN3_TOP_K_RANGE.max })).toBe(true);
    expect(accepts({ topK: QWEN3_TOP_K_RANGE.max + 1 })).toBe(false);
    expect(accepts({ instruct: "x".repeat(QWEN3_INSTRUCT_MAX_LENGTH) })).toBe(true);
    expect(accepts({ instruct: "x".repeat(QWEN3_INSTRUCT_MAX_LENGTH + 1) })).toBe(false);
    expect(accepts({ speaker: "Aiden", language: "Italian", seed: QWEN3_ENGINE_MAX_SEED })).toBe(true);
  });

  it("persists every Qwen3 profile repository it may be asked to restore", () => {
    for (const profile of QWEN3_PROFILES) {
      expect(qwen3Engine.parseSettings({ profileRepo: profile.repo }).profileRepo, profile.repo).toBe(profile.repo);
      expect(qwen3ProfileSupportsInstruct(profile), profile.repo).toBe(qwen3SupportsInstruct(profile.repo));
    }
  });

  it("offers only NeuTTS backbones the IPC validator accepts", () => {
    for (const option of NEUTTS_MODEL_OPTIONS) {
      expect(() => sanitizeNeuttsPayload({
        text: "A short request.",
        referenceText: "Reference words.",
        referenceAudioBase64: "AAAA",
        modelRepo: option.value,
      }), option.value).not.toThrow();
    }
  });
});
