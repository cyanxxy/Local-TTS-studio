import { describe, expect, it, vi } from "vitest";
import type { EngineRuntimeMap, SynthesisRequest } from "../shared/engineRuntime";
import type { SurfaceEngineSettings } from "../models/registry";
import { collectSynthesizedAudio } from "./presetSynthesis";
import {
  buildSynthesisRequest,
  createRuntimeSynthesize,
  presetFromSelection,
  settingsForPreset,
  type SynthesisBase,
} from "./studioSynthesis";

const settings = {
  kokoro: { voice: "af_heart" },
  supertonic: { voice: "F1", language: "en" },
  audio8: { voice: "narrator" },
  supertonic3: { voice: "M1", language: "en" },
  qwen3: {
    profile: { repo: "org/qwen", revision: "main", mode: "customVoice", parameters: "0.6B", provider: "metal" },
    modelPath: "/models/qwen",
    speaker: "Ryan",
    language: "English",
    instruct: "",
    temperature: 0.9,
    topK: 50,
    maxNewTokens: 300,
    seed: 7,
    referenceAudioSignature: "",
    referenceText: "",
  },
} as unknown as SurfaceEngineSettings;

const base: SynthesisBase = { settings, tuning: { speed: 1.1, quality: 8 } };

describe("buildSynthesisRequest", () => {
  it("renders with the selected settings when no preset is given", () => {
    const request = buildSynthesisRequest("kokoro", base, "Hello");
    expect(request).toEqual({ text: "Hello", settings: { voice: "af_heart" }, tuning: { speed: 1.1, quality: 8 } });
  });

  it("lays a preset's voice, language, speed and seed over the base", () => {
    const controller = new AbortController();
    const request = buildSynthesisRequest("supertonic3", base, "Hi", {
      preset: { engineId: "supertonic3", voiceId: "F2", settings: { language: "fr", speed: 0.9, seed: 5, quality: 4 } },
      signal: controller.signal,
    });
    expect(request.settings).toEqual({ voice: "F2", language: "fr" });
    expect(request.tuning).toMatchObject({ speed: 0.9, quality: 4, language: "fr" });
    expect(request.seed).toBe(5);
    expect(request.signal).toBe(controller.signal);
  });

  it("lets an explicit seed and speed beat the preset", () => {
    const request = buildSynthesisRequest("audio8", base, "Hi", {
      preset: { engineId: "audio8", voiceId: "x", settings: { seed: 1, speed: 0.8 } },
      seed: 99,
      speed: 1.3,
    });
    expect(request.seed).toBe(99);
    expect(request.tuning.speed).toBe(1.3);
  });

  it("completes Qwen3 settings for the synthesize contract", () => {
    const request = buildSynthesisRequest("qwen3", base, "Hi", {
      preset: { engineId: "qwen3", voiceId: "Aiden", settings: { language: "German", instruction: "calm", extra: { temperature: 0.5 } } },
    });
    expect(request.settings).toMatchObject({
      speaker: "Aiden",
      language: "German",
      instruct: "calm",
      temperature: 0.5,
      topK: 50,
      referenceAudioBase64: null,
      profile: { label: "org/qwen", mode: "customVoice" },
    });
  });

  it("rejects an engine that cannot render here", () => {
    expect(() => settingsForPreset("neutts" as never, settings)).toThrow(/cannot render/);
  });
});

describe("presetFromSelection", () => {
  it("captures the voice, language and seed of the selected engine", () => {
    expect(presetFromSelection("kokoro", base)).toEqual({ engineId: "kokoro", voiceId: "af_heart", settings: { speed: 1.1, quality: 8 } });
    expect(presetFromSelection("supertonic3", base).settings).toMatchObject({ language: "en" });
    expect(presetFromSelection("qwen3", base)).toMatchObject({
      voiceId: "Ryan",
      mode: "preset",
      settings: { language: "English", seed: 7, extra: { temperature: 0.9, topK: 50 } },
    });
  });
});

describe("createRuntimeSynthesize", () => {
  it("streams a runtime's chunks for a preset and passes the signal through", async () => {
    let received: SynthesisRequest | null = null;
    const synthesize = vi.fn((request: SynthesisRequest) => {
      received = request;
      return (async function* () {
        yield { audio: new Float32Array([0.1, 0.2]), samplingRate: 10, text: "Hi", index: 1, total: 1 };
      })();
    });
    const runtimes = { kokoro: { synthesize } } as unknown as EngineRuntimeMap;
    const run = createRuntimeSynthesize(() => runtimes, () => base);
    const controller = new AbortController();
    const audio = await collectSynthesizedAudio(
      run("Hi", { engineId: "kokoro", voiceId: "bf_emma", settings: {} }, controller.signal),
      controller.signal,
    );
    expect(audio.samples).toHaveLength(2);
    expect(received).toMatchObject({ text: "Hi", settings: { voice: "bf_emma" }, signal: controller.signal });
  });

  it("fails clearly for an engine without a runtime", async () => {
    const run = createRuntimeSynthesize(() => ({}) as EngineRuntimeMap, () => base);
    const stream = run("Hi", { engineId: "nope", voiceId: "x", settings: {} }, new AbortController().signal);
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow(/not available/);
  });
});
