import { describe, expect, it, vi } from "vitest";
import type { LocalTtsQwen3Setup } from "../../electron";
import { getQwen3Profiles } from "../../../electron/qwen3Profiles";
import type { Qwen3RuntimeSettings } from "../../contexts/Qwen3RuntimeContext";
import type { SurfaceEngineSettings } from "../../models/registry";
import { PresetRequestError, buildPresetRequest, isSurfaceEngine, presetRenderKey, type PresetRequestContext } from "./presetRequest";
import type { VoicePreset } from "./types";

const profiles = getQwen3Profiles("darwin", "arm64");
const byMode = (mode: string, parameters?: string) =>
  profiles.find((profile) => profile.mode === mode && (!parameters || profile.parameters === parameters))!;
const customVoice = byMode("customVoice", "1.7B");
const base = byMode("voiceClone");
const design = byMode("voiceDesign");

function setupOf(...installedProfiles: Array<{ repo: string }>): LocalTtsQwen3Setup {
  return {
    provider: "mlx",
    recommendedModelRepo: customVoice.repo,
    recommendedModelDir: "/models/x",
    profiles: profiles.map((profile) => ({
      ...profile,
      platforms: profile.platforms,
      modelDir: `/models/${profile.repo.split("/")[1]}`,
      readiness: installedProfiles.some((entry) => entry.repo === profile.repo) ? "verified" : "missing",
    })),
  } as LocalTtsQwen3Setup;
}

function context(overrides: Partial<PresetRequestContext> = {}): PresetRequestContext {
  const qwen3 = {
    profile: customVoice,
    modelPath: "/models/live",
    readiness: "verified",
    speaker: "Aiden",
    language: "English",
    instruct: "",
    temperature: 0.9,
    topK: 50,
    maxNewTokens: 384,
    seed: null,
    referenceAudioName: "",
    referenceAudioBase64: null,
    referenceAudioSignature: "",
    referenceAudioDurationSec: null,
    referenceText: "",
  } as Qwen3RuntimeSettings;
  return {
    tuning: { speed: 1, quality: 5 },
    engineSettings: {
      kokoro: { voice: "af_heart" },
      supertonic: { voice: "F1", language: "en" },
      audio8: { voice: "clara" },
      kitten: { voice: "Bella" },
      paradee: { voice: "heart" },
      piper: { voice: "en_US-amy-medium" },
      chatterbox: { voice: "default", temperature: 0.8, seed: null },
      supertonic3: { voice: "M1", language: "en" },
      qwen3,
    } as unknown as SurfaceEngineSettings,
    qwen3Profiles: profiles,
    qwen3Setup: setupOf(customVoice, base, design),
    loadVoiceAudio: vi.fn(async () => ({ wav: new Uint8Array([1, 2, 3]), transcript: "Said clip.", sha256: "f".repeat(64) })),
    ...overrides,
  };
}

const preset = (overrides: Partial<VoicePreset>): VoicePreset => ({ engineId: "kokoro", voiceId: "bm_george", settings: {}, ...overrides });

describe("buildPresetRequest", () => {
  it("builds simple engine requests with the preset's voice, speed and seed", async () => {
    const result = await buildPresetRequest("Hi.", preset({ settings: { speed: 1.25, seed: 9 } }), context());
    expect(result).toEqual({
      engineId: "kokoro",
      request: { text: "Hi.", settings: { voice: "bm_george" }, tuning: { speed: 1.25, quality: 5 }, seed: 9 },
    });
    expect((await buildPresetRequest("Hi.", preset({ engineId: "audio8", voiceId: "arthur" }), context())).request.settings)
      .toEqual({ voice: "arthur" });
  });

  it("keeps an engine's current language unless the preset names one", async () => {
    const keep = await buildPresetRequest("Hi.", preset({ engineId: "supertonic3", voiceId: "F2" }), context());
    expect(keep.request.settings).toEqual({ voice: "F2", language: "en" });
    const override = await buildPresetRequest("Hola.", preset({ engineId: "supertonic", voiceId: "M2", settings: { language: "es" } }), context());
    expect(override.request.settings).toEqual({ voice: "M2", language: "es" });
  });

  it("renders a Qwen3 preset speaker with the CustomVoice profile and its instruction", async () => {
    const { request } = await buildPresetRequest(
      "Hi.",
      preset({ engineId: "qwen3", voiceId: "Ryan", settings: { instruction: "Calm.", seed: 3, language: "English" } }),
      context(),
    );
    expect(request.settings).toMatchObject({
      profile: { repo: customVoice.repo },
      modelPath: "/models/live",
      speaker: "Ryan",
      instruct: "Calm.",
      seed: 3,
      referenceAudioBase64: null,
    });
  });

  it("finds an installed profile of the right mode and its model directory", async () => {
    const { request } = await buildPresetRequest(
      "Preview.",
      preset({ engineId: "qwen3", voiceId: "voice-design", mode: "voiceDesign", settings: { instruction: "A low voice.", seed: 5 } }),
      context(),
    );
    expect(request.settings).toMatchObject({
      profile: { mode: "voiceDesign" },
      modelPath: `/models/${design.repo.split("/")[1]}`,
      instruct: "A low voice.",
      seed: 5,
    });
  });

  it("sends a clone's reference clip, transcript and a signature that identifies the clip", async () => {
    const loadVoiceAudio = vi.fn(async () => ({ wav: new Uint8Array([1, 2, 3]), transcript: "Said clip.", sha256: "f".repeat(64) }));
    const { request } = await buildPresetRequest(
      "Hello.",
      preset({ engineId: "qwen3", voiceId: "library:c1", mode: "voiceClone", libraryVoiceId: "c1", settings: { language: "English" } }),
      context({ loadVoiceAudio }),
    );
    expect(loadVoiceAudio).toHaveBeenCalledWith("c1");
    expect(request.settings).toMatchObject({
      profile: { mode: "voiceClone" },
      referenceAudioBase64: "AQID",
      referenceAudioSignature: "f".repeat(64),
      referenceText: "Said clip.",
      instruct: "",
    });
  });

  it("explains what is missing instead of failing inside the bridge", async () => {
    const noModel = context({ qwen3Setup: setupOf(customVoice) });
    await expect(buildPresetRequest("Hi.", preset({ engineId: "qwen3", voiceId: "x", mode: "voiceDesign" }), noModel))
      .rejects.toThrow(/Qwen3 VoiceDesign model isn't downloaded yet/);
    await expect(buildPresetRequest("Hi.", preset({ engineId: "qwen3", voiceId: "x", mode: "voiceClone" }), context()))
      .rejects.toThrow(/no saved reference/);
    const missingAudio = context({ loadVoiceAudio: async () => null });
    await expect(buildPresetRequest("Hi.", preset({ engineId: "qwen3", voiceId: "x", mode: "voiceClone", libraryVoiceId: "gone" }), missingAudio))
      .rejects.toBeInstanceOf(PresetRequestError);
  });

  it("builds requests for the newer browser engines", async () => {
    const piper = await buildPresetRequest("Hi.", preset({ engineId: "piper", voiceId: "en_US-amy-medium#1" }), context());
    expect(piper).toMatchObject({ engineId: "piper", request: { settings: { voice: "en_US-amy-medium#1" } } });
    const kitten = await buildPresetRequest("Hi.", preset({ engineId: "kitten", voiceId: "Luna" }), context());
    expect(kitten.request.settings).toEqual({ voice: "Luna" });
  });

  it("renders a saved Chatterbox clone with the engine's clip voice id and its own sampling settings", async () => {
    const resolveChatterboxVoice = vi.fn(async () => "0123456789abcdef~Me");
    const result = await buildPresetRequest(
      "Hi.",
      preset({ engineId: "chatterbox", voiceId: "library:c1", mode: "voiceClone", libraryVoiceId: "c1", settings: { seed: 5, extra: { temperature: 1.1 } } }),
      context({ resolveChatterboxVoice }),
    );
    expect(resolveChatterboxVoice).toHaveBeenCalledWith("c1");
    expect(result.request.settings).toEqual({ voice: "0123456789abcdef~Me", temperature: 1.1, seed: 5 });
    const plain = await buildPresetRequest("Hi.", preset({ engineId: "chatterbox", voiceId: "default" }), context());
    expect(plain.request.settings).toEqual({ voice: "default", temperature: 0.8, seed: null });
    await expect(buildPresetRequest("Hi.", preset({ engineId: "chatterbox", voiceId: "x", libraryVoiceId: "c1" }), context()))
      .rejects.toThrow(/aren't available/);
  });

  it("refuses engines without a surface runtime", async () => {
    await expect(buildPresetRequest("Hi.", preset({ engineId: "neutts" }), context())).rejects.toThrow(/own page/);
    expect(isSurfaceEngine("kokoro")).toBe(true);
    expect(isSurfaceEngine("neutts")).toBe(false);
    expect(isSurfaceEngine("nonsense")).toBe(false);
  });

  describe("presetRenderKey", () => {
    const keyOf = (voice: VoicePreset, ctx = context(), reference?: { sha256: string; transcript: string }) => presetRenderKey(voice, ctx, reference);
    const kokoro = preset({});

    it("is stable and ignores display labels", async () => {
      expect(await keyOf(kokoro)).toBe(await keyOf({ ...kokoro, label: "Renamed" }));
    });

    it("changes with every input that changes the audio", async () => {
      const base = await keyOf(kokoro);
      const different = [
        await keyOf({ ...kokoro, settings: { speed: 1.4 } }),
        await keyOf(kokoro, { ...context(), tuning: { speed: 1.2, quality: 5 } }),
        await keyOf(kokoro, { ...context(), tuning: { speed: 1, quality: 5, pauseOverridesSec: { sentence: 0.9 } } }),
        await keyOf({ ...kokoro, settings: { seed: 3 } }),
        await keyOf({ ...kokoro, voiceId: "af_heart" }),
      ];
      for (const key of different) expect(key).not.toBe(base);
      expect(new Set(different).size).toBe(different.length);
    });

    it("follows the engine's live settings that the preset leaves open", async () => {
      const sup = preset({ engineId: "supertonic", voiceId: "F1" });
      const ctx = context();
      const changed = { ...ctx, engineSettings: { ...ctx.engineSettings, supertonic: { voice: "F1", language: "fr" } } } as PresetRequestContext;
      expect(await keyOf(sup, changed)).not.toBe(await keyOf(sup, ctx));
      const chatter = preset({ engineId: "chatterbox", voiceId: "default" });
      const warmer = { ...ctx, engineSettings: { ...ctx.engineSettings, chatterbox: { voice: "default", temperature: 1.4, seed: null } } } as PresetRequestContext;
      expect(await keyOf(chatter, warmer)).not.toBe(await keyOf(chatter, ctx));
    });

    it("tracks the Qwen3 profile, sampling and the reference clip", async () => {
      const ctx = context();
      const design = preset({ engineId: "qwen3", voiceId: "voice-design", mode: "voiceDesign", settings: { instruction: "Low.", seed: 1 } });
      const base = await keyOf(design, ctx);
      const hotter = { ...ctx, engineSettings: { ...ctx.engineSettings, qwen3: { ...ctx.engineSettings.qwen3, temperature: 1.5 } } } as PresetRequestContext;
      expect(await keyOf(design, hotter)).not.toBe(base);
      expect(await keyOf({ ...design, settings: { instruction: "Low.", seed: 1, language: "German" } }, ctx)).not.toBe(base);
      expect(await keyOf({ ...design, settings: { instruction: "Lower.", seed: 1 } }, ctx)).not.toBe(base);

      const clone = preset({ engineId: "qwen3", voiceId: "library:c1", mode: "voiceClone", libraryVoiceId: "c1" });
      const one = await keyOf(clone, ctx, { sha256: "a".repeat(64), transcript: "Hello." });
      expect(await keyOf(clone, ctx, { sha256: "b".repeat(64), transcript: "Hello." })).not.toBe(one);
      expect(await keyOf(clone, ctx, { sha256: "a".repeat(64), transcript: "Hello there." })).not.toBe(one);
      expect(one).not.toContain("AQID");
    });
  });
});
