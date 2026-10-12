import { describe, expect, it } from "vitest";
import {
  VOICE_LIBRARY_LIMITS,
  VoiceLibraryValidationError,
  isNewerSchemaRecord,
  normalizeCloneTargets,
  normalizeEngineId,
  normalizeLanguage,
  normalizePresetSettings,
  normalizeSeed,
  normalizeStoredAudioInfo,
  normalizeTranscript,
  normalizeVoiceDesign,
  normalizeVoiceName,
  normalizeVoicePreset,
  normalizeVoiceSource,
  normalizeVoiceTags,
  parseStoredVoiceRecord,
} from "./validation";

const SHA = "a".repeat(64);
const AUDIO = { sampleRate: 24000, durationSec: 5, byteLength: 240044, sha256: SHA };

function storedBase(kind: string, extra: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    id: "voice-1",
    name: "Narrator",
    description: "",
    tags: ["warm"],
    favorite: true,
    createdAt: 1,
    updatedAt: 2,
    kind,
    ...extra,
  };
}

describe("voice library validation", () => {
  it("mirrors the bridge limits", () => {
    expect(VOICE_LIBRARY_LIMITS.maxAudioBytes).toBe(45_000_000);
    expect(VOICE_LIBRARY_LIMITS.maxTranscriptLength).toBe(2000);
    expect(VOICE_LIBRARY_LIMITS.maxInstructionLength).toBe(1000);
    expect(VOICE_LIBRARY_LIMITS.maxSeed).toBe(0xffffffff);
    expect(VOICE_LIBRARY_LIMITS.maxReferenceDurationSec).toBe(20);
  });

  it("normalizes names, tags, languages and transcripts", () => {
    expect(normalizeVoiceName("  Warm   narrator ")).toBe("Warm narrator");
    expect(() => normalizeVoiceName("   ")).toThrow(VoiceLibraryValidationError);
    expect(() => normalizeVoiceName("x".repeat(81))).toThrow(/at most 80/);
    expect(() => normalizeVoiceName(5)).toThrow(/must be text/);
    expect(normalizeVoiceTags([" Calm ", "calm", "", "Deep"])).toEqual(["Calm", "Deep"]);
    expect(normalizeVoiceTags(undefined)).toEqual([]);
    expect(() => normalizeVoiceTags("calm")).toThrow(/list/);
    expect(() => normalizeVoiceTags(Array.from({ length: 17 }, (_, index) => `t${index}`))).toThrow(/16 tags/);
    expect(normalizeLanguage(undefined)).toBe("Auto");
    expect(normalizeLanguage(" English ")).toBe("English");
    // Transcripts keep inner whitespace: they are sent verbatim.
    expect(normalizeTranscript("  Hello,  world. ")).toBe("Hello,  world.");
    expect(() => normalizeTranscript("")).toThrow(/required/);
  });

  it("validates seeds, engine ids, sources and clone targets", () => {
    expect(normalizeSeed(0)).toBe(0);
    expect(normalizeSeed(0xffffffff)).toBe(0xffffffff);
    expect(() => normalizeSeed(-1)).toThrow(/Seed/);
    expect(() => normalizeSeed(1.5)).toThrow(/Seed/);
    expect(normalizeEngineId("qwen3")).toBe("qwen3");
    expect(() => normalizeEngineId("Qwen 3")).toThrow(/Engine id/);
    expect(() => normalizeEngineId("")).toThrow(/Engine id/);
    expect(normalizeVoiceSource(undefined)).toBe("upload");
    expect(normalizeVoiceSource("recording")).toBe("recording");
    expect(() => normalizeVoiceSource("stolen")).toThrow(/source/);
    expect(normalizeCloneTargets(["neutts", "qwen3-base", "neutts"])).toEqual(["qwen3-base", "neutts"]);
    expect(() => normalizeCloneTargets([])).toThrow(/Clone targets/);
    expect(() => normalizeCloneTargets(["neutts", "kokoro"])).toThrow(/Clone targets/);
    expect(() => normalizeCloneTargets("neutts")).toThrow(/at least one/);
  });

  it("validates preset settings and drops empty values", () => {
    expect(normalizePresetSettings(undefined)).toEqual({});
    expect(normalizePresetSettings({
      speed: 1.1,
      seed: 7,
      instruction: "  ",
      language: "English",
      quality: 5,
      extra: {},
    })).toEqual({ speed: 1.1, seed: 7, language: "English", quality: 5 });
    expect(normalizePresetSettings({ extra: { temperature: 0.9, sampling: true, style: "calm" } }).extra)
      .toEqual({ temperature: 0.9, sampling: true, style: "calm" });
    expect(() => normalizePresetSettings([])).toThrow(/object/);
    expect(() => normalizePresetSettings({ speed: 0 })).toThrow(/Speed/);
    expect(() => normalizePresetSettings({ quality: "high" })).toThrow(/Quality/);
    expect(() => normalizePresetSettings({ extra: [] })).toThrow(/Extra settings/);
    expect(() => normalizePresetSettings({ extra: { nested: { a: 1 } } })).toThrow(/text, a number/);
    expect(() => normalizePresetSettings({ extra: { long: "x".repeat(1001) } })).toThrow(/too long/);
    expect(() => normalizePresetSettings({ extra: JSON.parse('{"__proto__": 1}') })).toThrow(/names/);
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`k${index}`, index]));
    expect(() => normalizePresetSettings({ extra: many })).toThrow(/Too many/);
  });

  it("validates full voice presets", () => {
    expect(normalizeVoicePreset({
      engineId: "kokoro",
      voiceId: "af_heart",
      mode: "preset",
      settings: { speed: 1 },
      libraryVoiceId: "voice-1",
      label: " Heart ",
    })).toEqual({
      engineId: "kokoro",
      voiceId: "af_heart",
      mode: "preset",
      settings: { speed: 1 },
      libraryVoiceId: "voice-1",
      label: "Heart",
    });
    expect(() => normalizeVoicePreset({ engineId: "kokoro", voiceId: "a", mode: "sing" })).toThrow(/mode/);
    expect(() => normalizeVoicePreset(null)).toThrow(/Preset/);
    expect(() => normalizeVoicePreset({ engineId: "kokoro", voiceId: "" })).toThrow(/Voice id/);
  });

  it("validates voice designs and stored audio metadata", () => {
    expect(normalizeVoiceDesign({ description: "A calm voice", seed: 3, previewText: "Hello there." }))
      .toEqual({ description: "A calm voice", seed: 3, language: "Auto", previewText: "Hello there." });
    expect(normalizeVoiceDesign({ description: "d", seed: 3, previewText: "p", profileRepo: "repo/x" }).profileRepo)
      .toBe("repo/x");
    expect(() => normalizeVoiceDesign("design")).toThrow(/object/);
    expect(normalizeStoredAudioInfo(AUDIO)).toEqual(AUDIO);
    expect(() => normalizeStoredAudioInfo(null)).toThrow(/missing/);
    expect(() => normalizeStoredAudioInfo({ ...AUDIO, sampleRate: 0 })).toThrow(/sample rate/);
    expect(() => normalizeStoredAudioInfo({ ...AUDIO, durationSec: 0 })).toThrow(/duration/);
    expect(() => normalizeStoredAudioInfo({ ...AUDIO, byteLength: 0 })).toThrow(/size/);
    expect(() => normalizeStoredAudioInfo({ ...AUDIO, byteLength: 45_000_001 })).toThrow(/45,000,000/);
    expect(() => normalizeStoredAudioInfo({ ...AUDIO, sha256: "xyz" })).toThrow(/digest/);
    expect(normalizeStoredAudioInfo({ ...AUDIO, durationSec: 20.004 }, { maxDurationSec: 20 }).durationSec).toBe(20.004);
    expect(() => normalizeStoredAudioInfo({ ...AUDIO, durationSec: 21 }, { maxDurationSec: 20 })).toThrow(/20 seconds/);
  });
});

describe("parseStoredVoiceRecord", () => {
  it("parses each voice kind", () => {
    expect(parseStoredVoiceRecord(storedBase("preset", {
      preset: { engineId: "kokoro", voiceId: "af_heart", settings: {} },
    }))).toMatchObject({ kind: "preset", favorite: true, tags: ["warm"] });
    expect(parseStoredVoiceRecord(storedBase("cloned", {
      transcript: "Hello.",
      language: "English",
      targets: ["neutts"],
      source: "recording",
      reference: AUDIO,
      designedFromId: "voice-0",
    }))).toMatchObject({ kind: "cloned", designedFromId: "voice-0", source: "recording" });
    expect(parseStoredVoiceRecord(storedBase("designed", {
      design: { description: "Calm", seed: 1, language: "English", previewText: "Hi." },
      sample: AUDIO,
    }))).toMatchObject({ kind: "designed", sample: AUDIO });
  });

  it("rejects damaged records instead of throwing", () => {
    expect(parseStoredVoiceRecord(null)).toBeNull();
    expect(parseStoredVoiceRecord({ ...storedBase("preset", {}), schemaVersion: 2 })).toBeNull();
    expect(parseStoredVoiceRecord({ ...storedBase("preset", {}), id: "" })).toBeNull();
    expect(parseStoredVoiceRecord({ ...storedBase("preset", {}), createdAt: -1 })).toBeNull();
    expect(parseStoredVoiceRecord(storedBase("preset", { preset: null }))).toBeNull();
    expect(parseStoredVoiceRecord(storedBase("robot", {}))).toBeNull();
    expect(parseStoredVoiceRecord(storedBase("cloned", {
      transcript: "Hi.", targets: ["neutts"], reference: { ...AUDIO, durationSec: 30 },
    }))).toBeNull();
  });

  it("recognizes records from a newer schema", () => {
    expect(isNewerSchemaRecord({ schemaVersion: 2 })).toBe(true);
    expect(isNewerSchemaRecord({ schemaVersion: 1 })).toBe(false);
    expect(isNewerSchemaRecord("record")).toBe(false);
  });
});
