import { describe, expect, it, vi } from "vitest";
import { createPronunciationDictionary } from "../lib/pronunciation/dictionary";
import type { EngineRuntime, EngineRuntimeMap, SynthesisChunk, SynthesisRequest } from "./engineRuntime";
import {
  engineSpeechLanguage,
  resolveSpeechPipelineSettings,
  speechBreakBoundary,
  withSpeechPipeline,
  withSpeechPipelineAll,
  type SpeechPipelineChoices,
} from "./speechPipelineRuntime";

const LANGUAGE_SETTINGS = {
  kokoro: { voice: "af_heart" },
  supertonic: { voice: "Female", language: "ko" },
  supertonic3: { voice: "M1", language: "ja" },
  qwen3: { language: "English" },
} as unknown as Parameters<typeof engineSpeechLanguage>[1];

describe("engineSpeechLanguage", () => {
  it("reads each engine's language from its own settings", () => {
    expect(engineSpeechLanguage("supertonic", LANGUAGE_SETTINGS)).toBe("ko");
    expect(engineSpeechLanguage("supertonic3", LANGUAGE_SETTINGS)).toBe("ja");
    expect(engineSpeechLanguage("qwen3", LANGUAGE_SETTINGS)).toBe("en");
    expect(engineSpeechLanguage("audio8", LANGUAGE_SETTINGS)).toBeUndefined();
  });

  it("takes Kokoro's language from the voice name", () => {
    const kokoro = (voice: string) => engineSpeechLanguage("kokoro", { ...LANGUAGE_SETTINGS, kokoro: { voice } });
    expect(kokoro("af_heart")).toBe("en-US");
    expect(kokoro("bm_george")).toBe("en-GB");
    expect(kokoro("jf_alpha")).toBe("ja");
    expect(kokoro("xf_mystery")).toBe("und");
    // A custom voice name says nothing, so the default (English) stands.
    expect(kokoro("my-blend")).toBeUndefined();
  });

  it("treats Qwen3's automatic language as unknown", () => {
    expect(engineSpeechLanguage("qwen3", { ...LANGUAGE_SETTINGS, qwen3: { language: "Auto" } } as never)).toBe("und");
  });
});

describe("speechBreakBoundary", () => {
  it("splits unit-streaming engines at pause marks and the rest at blank lines", () => {
    expect(speechBreakBoundary("qwen3")).toBe("mark");
    expect(speechBreakBoundary("kokoro")).toBe("paragraph");
    expect(speechBreakBoundary("audio8")).toBe("paragraph");
  });
});

describe("resolveSpeechPipelineSettings", () => {
  const dictionaries = [
    createPronunciationDictionary({ name: "All", rules: [{ type: "alias", from: "GIF", to: "jif" }] }),
    createPronunciationDictionary({ name: "French", language: "fr", rules: [{ type: "alias", from: "GIF", to: "guif" }] }),
    createPronunciationDictionary({ name: "Off", enabled: false, rules: [{ type: "alias", from: "SQL", to: "sequel" }] }),
  ];
  const choices: SpeechPipelineChoices = { dictionaries, normalize: true, cleanup: false };

  it("keeps the enabled dictionaries that apply to the engine's language", () => {
    expect(resolveSpeechPipelineSettings(choices, "en-US")).toEqual({
      rules: [{ from: "GIF", to: "jif" }],
      normalize: true,
      cleanup: false,
      language: "en-US",
    });
    expect(resolveSpeechPipelineSettings(choices, "fr").rules.map((rule) => rule.to)).toEqual(["jif", "guif"]);
  });
});

describe("withSpeechPipeline", () => {
  const chunk = (overrides: Partial<SynthesisChunk>): SynthesisChunk => ({
    audio: new Float32Array(100),
    samplingRate: 100,
    text: "",
    index: 1,
    total: 1,
    ...overrides,
  });

  function runtimeFor(chunks: SynthesisChunk[]) {
    const requests: SynthesisRequest<"kokoro">[] = [];
    const runtime = {
      id: "kokoro",
      handleGenerate: vi.fn(),
      synthesize: vi.fn((request: SynthesisRequest<"kokoro">) => {
        requests.push(request);
        return (async function* () {
          yield* chunks;
        })();
      }),
    } as unknown as EngineRuntime<"kokoro">;
    return { runtime, requests };
  }

  const request = (text: string): SynthesisRequest<"kokoro"> => ({
    text,
    settings: { voice: "af_heart" },
    tuning: { speed: 1, quality: 5, pronunciationRules: [{ from: "x", to: "y" }] },
  });
  const settings = resolveSpeechPipelineSettings(
    { dictionaries: [createPronunciationDictionary({ name: "Q", rules: [{ type: "alias", from: "GIF", to: "jif" }] })], normalize: false, cleanup: false },
    undefined,
  );

  it("speaks the spoken form and reports chunks against the request text", async () => {
    const { runtime, requests } = runtimeFor([chunk({ text: "jif.", textStart: 0, textEnd: 4, pauseAfterSec: 0.44, audio: new Float32Array(144) })]);
    const wrapped = withSpeechPipeline("kokoro", runtime, () => settings);

    const out: SynthesisChunk[] = [];
    for await (const next of wrapped.synthesize(request('GIF.<break time="2s"/>Done'))) out.push(next);

    expect(requests[0].text).toBe("jif.\n\nDone");
    expect(requests[0].tuning.pronunciationRules).toEqual([]);
    expect(out[0]).toMatchObject({ text: "GIF.", textStart: 0, textEnd: 4, pauseAfterSec: 2 });
    expect(out[0].audio).toHaveLength(100 + 200);
    expect(wrapped.handleGenerate).toBe(runtime.handleGenerate);
  });

  it("queues the request at once, not when someone starts reading", () => {
    const { runtime } = runtimeFor([]);
    withSpeechPipeline("kokoro", runtime, () => settings).synthesize(request("GIF"));
    expect(runtime.synthesize).toHaveBeenCalledOnce();
  });

  it("passes text that needs nothing straight through, still without the engine's own rules", async () => {
    const { runtime, requests } = runtimeFor([chunk({ text: "Plain.", textStart: 0, textEnd: 6 })]);
    const wrapped = withSpeechPipeline("kokoro", runtime, () => resolveSpeechPipelineSettings({ dictionaries: [], normalize: false, cleanup: false }, undefined));

    const out: SynthesisChunk[] = [];
    for await (const next of wrapped.synthesize(request("Plain."))) out.push(next);

    expect(requests[0].text).toBe("Plain.");
    expect(requests[0].tuning.pronunciationRules).toEqual([]);
    expect(out).toEqual([chunk({ text: "Plain.", textStart: 0, textEnd: 6 })]);
  });

  it("wraps every runtime in the map under its own id", () => {
    const { runtime } = runtimeFor([]);
    const map = { kokoro: runtime, audio8: { ...runtime, id: undefined } } as unknown as EngineRuntimeMap;
    const wrapped = withSpeechPipelineAll(map, () => settings);

    expect(Object.keys(wrapped).sort()).toEqual(["audio8", "kokoro"]);
    expect(wrapped.kokoro.synthesize).not.toBe(runtime.synthesize);
    expect(wrapped.audio8.synthesize).toEqual(expect.any(Function));
  });
});
