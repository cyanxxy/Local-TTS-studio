import { describe, expect, expectTypeOf, it } from "vitest";
import type { GenerationTuningSettings, ModelType } from "../types";
import { chunkForKokoroDetailed, chunkWithConstraintsDetailed } from "../lib/chunking";
import { buildQwen3RequestPlan } from "../lib/qwenChunking";
import { audio8Engine, chunkAudio8Text } from "./audio8";
import { formatKokoroVoiceName, kokoroEngine, kokoroVoiceGroup } from "./kokoro";
import { neuttsEngine } from "./neutts";
import { qwen3Engine, qwen3ProfileSupportsInstruct, type Qwen3LiveSettings } from "./qwen3";
import {
  BROWSER_ENGINE_IDS,
  DESKTOP_INLINE_ENGINE_IDS,
  ENGINE_IDS,
  ENGINE_REGISTRY,
  ENGINES,
  SETUP_PAGE_ENGINE_IDS,
  engineDetail,
  enginePreviewChunks,
  engineSignatureParts,
  engineVoiceLabel,
  getEngine,
  isBrowserEngineId,
  isDesktopInlineEngineId,
  isEngineId,
  surfaceEngineDetail,
  surfaceEnginePreviewChunks,
  surfaceEngineSignatureParts,
  surfaceEngineVoiceLabel,
  type BrowserEngineId,
  type DesktopInlineEngineId,
  type EngineId,
  type EngineLiveSettings,
  type EngineSettings,
  type RustBridgeEngineId,
  type SetupPageEngineId,
  type SurfaceEngineId,
  type SurfaceEngineSettings,
} from "./registry";
import { supertonicEngine } from "./supertonic";
import { supertonic3Engine } from "./supertonic3";

const TUNING: GenerationTuningSettings = {
  speed: 1,
  quality: 5,
  language: "en",
  pauseOverridesSec: { none: 0, comma: 0.1, sentence: 0.2, paragraph: 0.3 },
  pronunciationRules: [{ from: "GIF", to: "jif" }],
};

const QWEN3_LIVE: Qwen3LiveSettings = {
  profile: {
    repo: "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit",
    revision: "7dc92af14613355896fcab13b268c19ede233139",
    mode: "customVoice",
    parameters: "0.6B",
    provider: "mlx",
  },
  modelPath: "/models/qwen3",
  speaker: "Uncle_Fu",
  language: "English",
  instruct: "",
  temperature: 0.9,
  topK: 50,
  maxNewTokens: 384,
  seed: null,
  referenceAudioSignature: "",
  referenceText: "",
};

const SURFACE_SETTINGS: SurfaceEngineSettings = {
  kokoro: { voice: "af_heart" },
  supertonic: { voice: "Female", language: "en" },
  audio8: { voice: "clara" },
  supertonic3: { voice: "M1", language: "en" },
  qwen3: QWEN3_LIVE,
};

const SURFACE_ENGINE_IDS: readonly SurfaceEngineId[] = [...BROWSER_ENGINE_IDS, ...DESKTOP_INLINE_ENGINE_IDS];

const PREVIEW_TEXT = [
  "Chapter One",
  "",
  "The first paragraph has a few sentences. It keeps going, with a comma here; and a clause there.",
  "",
  "A second paragraph follows after a blank line, long enough that every chunker has to make a decision about where to cut it into passages for synthesis.",
].join("\n");

function signature(id: SurfaceEngineId, tuning: GenerationTuningSettings, quality = 5) {
  return surfaceEngineSignatureParts(id, SURFACE_SETTINGS, { tuning, quality });
}

describe("engine registry", () => {
  it("registers every engine once under its own id", () => {
    expect(new Set(ENGINE_IDS).size).toBe(ENGINE_IDS.length);
    expect(ENGINE_IDS).toEqual(["kokoro", "supertonic", "audio8", "supertonic3", "neutts", "qwen3"]);
    for (const id of ENGINE_IDS) {
      expect(ENGINES[id].id).toBe(id);
      expect(getEngine(id)).toBe(ENGINES[id]);
      expect(ENGINES[id].label.length).toBeGreaterThan(0);
      expect(ENGINES[id].params.length).toBeGreaterThan(0);
    }
    expect(ENGINE_REGISTRY).toHaveLength(ENGINE_IDS.length);
  });

  it("derives the engine id unions from the descriptors", () => {
    expectTypeOf<EngineId>().toEqualTypeOf<"kokoro" | "supertonic" | "audio8" | "supertonic3" | "qwen3" | "neutts">();
    expectTypeOf<BrowserEngineId>().toEqualTypeOf<"kokoro" | "supertonic">();
    expectTypeOf<DesktopInlineEngineId>().toEqualTypeOf<"audio8" | "supertonic3" | "qwen3">();
    expectTypeOf<SetupPageEngineId>().toEqualTypeOf<"qwen3" | "neutts">();
    expectTypeOf<RustBridgeEngineId>().toEqualTypeOf<"qwen3" | "neutts">();
    expectTypeOf<ModelType>().toEqualTypeOf<BrowserEngineId>();
    expectTypeOf<EngineSettings<"supertonic3">>().toEqualTypeOf<{ voice: string; language: string }>();
    expectTypeOf<EngineLiveSettings<"qwen3">>().toEqualTypeOf<Qwen3LiveSettings>();

    expect(BROWSER_ENGINE_IDS).toEqual(["kokoro", "supertonic"]);
    expect(DESKTOP_INLINE_ENGINE_IDS).toEqual(["audio8", "supertonic3", "qwen3"]);
    expect(SETUP_PAGE_ENGINE_IDS).toEqual(["neutts", "qwen3"]);
  });

  it("narrows unknown values to registered ids", () => {
    expect(isEngineId("neutts")).toBe(true);
    expect(isEngineId("kitten")).toBe(false);
    expect(isEngineId(7)).toBe(false);
    expect(isBrowserEngineId("supertonic")).toBe(true);
    expect(isBrowserEngineId("audio8")).toBe(false);
    expect(isDesktopInlineEngineId("qwen3")).toBe(true);
    expect(isDesktopInlineEngineId("neutts")).toBe(false);
    expect(isDesktopInlineEngineId(null)).toBe(false);
  });

  it("keeps pickers, targets and setup pages consistent", () => {
    for (const engine of ENGINE_REGISTRY) {
      if (engine.picker === "browser") {
        expect(engine.runtime, engine.id).toBe("browser-worker");
        expect(engine.targets, engine.id).toContain("web");
      } else if (engine.picker === "desktop") {
        expect(engine.targets, engine.id).toEqual(["desktop"]);
        expect(engine.badge?.length, engine.id).toBeGreaterThan(0);
      } else {
        // An engine no surface lists is only reachable from its setup page.
        expect("setupPage" in engine, engine.id).toBe(true);
      }
      if ("setupPage" in engine) {
        expect(engine.setupPage.tabLabel.length, engine.id).toBeGreaterThan(0);
        expect(engine.setupPage.highlights.length, engine.id).toBeGreaterThan(0);
        for (const link of engine.setupPage.links) expect(link.href, engine.id).toMatch(/^https:\/\//);
      }
    }
  });
});

describe("engine settings", () => {
  it.each(ENGINE_IDS)("round-trips %s defaults through storage", (id) => {
    const engine: { defaultSettings: unknown; parseSettings: (raw: unknown) => unknown } = ENGINES[id];
    expect(engine.parseSettings(engine.defaultSettings)).toEqual(engine.defaultSettings);
    expect(engine.parseSettings(JSON.parse(JSON.stringify(engine.defaultSettings)))).toEqual(engine.defaultSettings);
    for (const garbage of [undefined, null, "kokoro", 42, [], { voice: 7, language: {} }]) {
      expect(engine.parseSettings(garbage)).toEqual(engine.defaultSettings);
    }
  });

  it("keeps valid stored values and replaces invalid ones field by field", () => {
    expect(kokoroEngine.parseSettings({ voice: "bf_emma" })).toEqual({ voice: "bf_emma" });
    expect(kokoroEngine.parseSettings({ voice: "   " })).toEqual({ voice: "af_heart" });
    expect(supertonicEngine.parseSettings({ voice: "Male 3", language: "xx" }))
      .toEqual({ voice: "Male 3", language: "en" });
    expect(supertonicEngine.parseSettings({ voice: "Robot", language: "fr" }))
      .toEqual({ voice: "Female", language: "fr" });
    expect(supertonic3Engine.parseSettings({ voice: "F4", language: "ja" })).toEqual({ voice: "F4", language: "ja" });
    expect(supertonic3Engine.parseSettings({ voice: "F9", language: "ja" })).toEqual({ voice: "M1", language: "ja" });
    expect(audio8Engine.parseSettings({ voice: "sophie" })).toEqual({ voice: "sophie" });
    expect(audio8Engine.parseSettings({ voice: "nobody" })).toEqual({ voice: "clara" });
    expect(neuttsEngine.parseSettings({ modelRepo: "neuphonic/neutts-air-q8-gguf" }))
      .toEqual({ modelRepo: "neuphonic/neutts-air-q8-gguf" });
    expect(neuttsEngine.parseSettings({ modelRepo: "neuphonic/neutts-nano-q8-gguf" }))
      .toEqual(neuttsEngine.defaultSettings);
  });

  it("validates and clamps stored Qwen3 settings without trusting them", () => {
    expect(qwen3Engine.parseSettings({
      profileRepo: "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-6bit",
      speaker: "Sohee",
      language: "Korean",
      instructByMode: { customVoice: "Warm.", voiceDesign: "x".repeat(1_200) },
      temperature: 9,
      topK: 0.4,
      maxNewTokens: 10_000,
      seed: 12.6,
    })).toEqual({
      profileRepo: "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-6bit",
      speaker: "Sohee",
      language: "Korean",
      instructByMode: { customVoice: "Warm.", voiceDesign: "x".repeat(1_000) },
      temperature: 2,
      topK: 1,
      maxNewTokens: 384,
      seed: 13,
    });
    expect(qwen3Engine.parseSettings({
      profileRepo: "../../etc/passwd",
      speaker: "Nobody",
      language: "Klingon",
      instructByMode: { customVoice: 4 },
      temperature: Number.NaN,
      topK: "50",
      maxNewTokens: 1,
      seed: -5,
    })).toEqual({ ...qwen3Engine.defaultSettings, maxNewTokens: 64, seed: 0 });
    expect(qwen3Engine.parseSettings({ seed: 2 ** 40 }).seed).toBe(0xFFFF_FFFF);
    expect(qwen3Engine.parseSettings({ seed: null }).seed).toBeNull();
  });
});

describe("engine voices and labels", () => {
  it("offers each engine's default voice among its voices", () => {
    const ids = (voices: readonly { id: string }[]) => voices.map((voice) => voice.id);
    expect(ids(supertonicEngine.voices())).toContain(supertonicEngine.defaultSettings.voice);
    expect(ids(supertonic3Engine.voices())).toContain(supertonic3Engine.defaultSettings.voice);
    expect(ids(audio8Engine.voices())).toContain(audio8Engine.defaultSettings.voice);
    expect(ids(qwen3Engine.voices())[0]).toBe(qwen3Engine.defaultSettings.speaker);
    expect(neuttsEngine.voices()).toEqual([]);
  });

  it("groups and names the voices a Kokoro model reports", () => {
    expect(kokoroEngine.voices()).toEqual([]);
    expect(kokoroEngine.voices({ runtimeVoices: ["af_heart", "bm_george", "zz_custom_voice"] })).toEqual([
      { id: "af_heart", label: "Heart", group: "American · Female" },
      { id: "bm_george", label: "George", group: "British · Male" },
      { id: "zz_custom_voice", label: "Custom voice", group: "Other" },
    ]);
    expect(formatKokoroVoiceName("plain")).toBe("plain");
    expect(kokoroVoiceGroup("am_adam")).toBe("American · Male");
  });

  it("orders Qwen3 speakers with the English default first", () => {
    expect(qwen3Engine.voices().slice(0, 3)).toEqual([
      { id: "Aiden", label: "Aiden", detail: "English" },
      { id: "Ryan", label: "Ryan", detail: "English" },
      { id: "Vivian", label: "Vivian", detail: "Chinese" },
    ]);
    expect(qwen3Engine.voices().find((voice) => voice.id === "Uncle_Fu")?.label).toBe("Uncle Fu");
  });

  it("summarises the current settings the way the desktop pickers show them", () => {
    expect(surfaceEngineDetail("audio8", SURFACE_SETTINGS)).toBe("0.6B · ONNX INT4 · Clara");
    expect(surfaceEngineDetail("supertonic3", SURFACE_SETTINGS)).toBe("99M · EN · M1");
    expect(surfaceEngineDetail("qwen3", SURFACE_SETTINGS)).toBe("0.6B Uncle_Fu · Apple MLX");
    expect(engineDetail("qwen3", { ...QWEN3_LIVE, profile: { ...QWEN3_LIVE.profile, mode: "voiceDesign", provider: "libtorch" } }))
      .toBe("0.6B VoiceDesign · LibTorch");
    expect(surfaceEngineDetail("kokoro", SURFACE_SETTINGS)).toBe("82M · Heart");
    expect(surfaceEngineDetail("supertonic", SURFACE_SETTINGS)).toBe("300M · EN · Female");
    expect(engineDetail("neutts", neuttsEngine.defaultSettings)).toBe("English · neutts-nano · Q4 GGUF");

    expect(surfaceEngineVoiceLabel("audio8", { ...SURFACE_SETTINGS, audio8: { voice: "sophie" } })).toBe("Sophie");
    expect(surfaceEngineVoiceLabel("qwen3", SURFACE_SETTINGS)).toBe("Uncle Fu");
    expect(engineVoiceLabel("qwen3", { ...QWEN3_LIVE, profile: { ...QWEN3_LIVE.profile, mode: "voiceClone" } }))
      .toBe("Voice clone");
    expect(surfaceEngineVoiceLabel("supertonic3", SURFACE_SETTINGS)).toBe("M1");
    expect(surfaceEngineVoiceLabel("supertonic", SURFACE_SETTINGS)).toBe("Female");
    expect(surfaceEngineVoiceLabel("kokoro", SURFACE_SETTINGS)).toBe("Heart");
    expect(engineVoiceLabel("neutts", { modelRepo: "neuphonic/neutts-nano-french-q4-gguf" }))
      .toBe("French · neutts-nano · Q4 GGUF");
  });
});

describe("capability-aware signatures", () => {
  const variations: Array<{
    capability: "speed" | "pauses" | "pronunciationLexicon";
    tuning: Partial<GenerationTuningSettings>;
  }> = [
    { capability: "speed", tuning: { speed: 1.1 } },
    { capability: "speed", tuning: { sentenceSpeedVariance: 0.2 } },
    { capability: "pauses", tuning: { pauseOverridesSec: { ...TUNING.pauseOverridesSec, comma: 0.5 } } },
    { capability: "pronunciationLexicon", tuning: { pronunciationRules: [{ from: "SQL", to: "sequel" }] } },
    { capability: "pronunciationLexicon", tuning: { emphasisStrength: 0.4 } },
  ];

  it.each(SURFACE_ENGINE_IDS)("hashes only the Creator inputs %s reads", (id) => {
    const { capabilities } = ENGINES[id];
    const base = signature(id, TUNING);
    expect(base).not.toBeNull();
    for (const variation of variations) {
      const changed = signature(id, { ...TUNING, ...variation.tuning });
      if (capabilities[variation.capability]) expect(changed, `${id} ${JSON.stringify(variation.tuning)}`).not.toEqual(base);
      else expect(changed, `${id} ${JSON.stringify(variation.tuning)}`).toEqual(base);
    }

    const otherQuality = signature(id, TUNING, 12);
    if (capabilities.quality) expect(otherQuality).not.toEqual(base);
    else expect(otherQuality).toEqual(base);

    // The shared tuning carries the Supertonic 2 language for every engine; no
    // engine may read its language from there.
    expect(signature(id, { ...TUNING, language: "ko" })).toEqual(base);
  });

  it("uses each engine's own language setting", () => {
    const korean = { ...SURFACE_SETTINGS, supertonic: { voice: "Female", language: "ko" } } as const;
    expect(surfaceEngineSignatureParts("supertonic", korean, { tuning: TUNING, quality: 5 }))
      .not.toEqual(signature("supertonic", TUNING));
    const japanese = { ...SURFACE_SETTINGS, supertonic3: { voice: "M1", language: "ja" } } as const;
    expect(surfaceEngineSignatureParts("supertonic3", japanese, { tuning: TUNING, quality: 5 }))
      .not.toEqual(signature("supertonic3", TUNING));
    expect(engineSignatureParts("qwen3", { settings: { ...QWEN3_LIVE, language: "German" }, tuning: TUNING, quality: 5 }))
      .not.toEqual(signature("qwen3", TUNING));
  });

  it("keeps the voice and the Qwen3 configuration in the signature", () => {
    expect(surfaceEngineSignatureParts("kokoro", { ...SURFACE_SETTINGS, kokoro: { voice: "af_bella" } }, { tuning: TUNING, quality: 5 }))
      .not.toEqual(signature("kokoro", TUNING));
    expect(surfaceEngineSignatureParts("audio8", { ...SURFACE_SETTINGS, audio8: { voice: "iris" } }, { tuning: TUNING, quality: 5 }))
      .not.toEqual(signature("audio8", TUNING));
    const qwen = (patch: Partial<Qwen3LiveSettings>) => engineSignatureParts("qwen3", {
      settings: { ...QWEN3_LIVE, ...patch },
      tuning: TUNING,
      quality: 5,
    });
    for (const patch of [
      { speaker: "Ryan" },
      { seed: 7 },
      { temperature: 0.5 },
      { topK: 10 },
      { maxNewTokens: 128 },
      { modelPath: "/elsewhere" },
    ] satisfies Partial<Qwen3LiveSettings>[]) {
      expect(qwen(patch), JSON.stringify(patch)).not.toEqual(qwen({}));
    }
  });

  it("ignores Qwen3 inputs the selected profile does not condition on", () => {
    const qwen = (patch: Partial<Qwen3LiveSettings>, profile: Partial<Qwen3LiveSettings["profile"]> = {}) => (
      engineSignatureParts("qwen3", {
        settings: { ...QWEN3_LIVE, ...patch, profile: { ...QWEN3_LIVE.profile, ...profile } },
        tuning: TUNING,
        quality: 5,
      })
    );
    // The 0.6B CustomVoice wrapper drops instructions; 1.7B honours them.
    expect(qwen({ instruct: "Whisper." })).toEqual(qwen({}));
    expect(qwen({ instruct: "Whisper." }, { parameters: "1.7B" })).not.toEqual(qwen({}, { parameters: "1.7B" }));
    // VoiceDesign has no preset speaker.
    const design = { mode: "voiceDesign", parameters: "1.7B" } as const;
    expect(qwen({ speaker: "Ryan", instruct: "Bright." }, design)).toEqual(qwen({ instruct: "Bright." }, design));
    // A clone depends on its reference, never on the preset speaker.
    const clone = { mode: "voiceClone" } as const;
    const reference = { referenceAudioSignature: "sha-1", referenceText: "Reference words." };
    expect(qwen({ ...reference, speaker: "Ryan" }, clone)).toEqual(qwen(reference, clone));
    expect(qwen({ ...reference, referenceAudioSignature: "sha-2" }, clone)).not.toEqual(qwen(reference, clone));
  });

  it("reports no Qwen3 signature until its model directory and clone reference are known", () => {
    const qwen = (patch: Partial<Qwen3LiveSettings>, profile: Partial<Qwen3LiveSettings["profile"]> = {}) => (
      engineSignatureParts("qwen3", {
        settings: { ...QWEN3_LIVE, ...patch, profile: { ...QWEN3_LIVE.profile, ...profile } },
        tuning: TUNING,
        quality: 5,
      })
    );
    expect(qwen({ modelPath: "   " })).toBeNull();
    expect(qwen({}, { mode: "voiceClone" })).toBeNull();
    expect(qwen({ referenceAudioSignature: "sha-1" }, { mode: "voiceClone" })).not.toBeNull();
    expect(engineSignatureParts("neutts", { settings: neuttsEngine.defaultSettings, tuning: TUNING, quality: 5 }))
      .toBeNull();
  });

  it("matches the instruction support the IPC layer derives from repository names", () => {
    expect(qwen3ProfileSupportsInstruct({ mode: "voiceDesign", parameters: "1.7B" })).toBe(true);
    expect(qwen3ProfileSupportsInstruct({ mode: "voiceClone", parameters: "1.7B" })).toBe(false);
    expect(qwen3ProfileSupportsInstruct({ mode: "customVoice", parameters: "0.6B" })).toBe(false);
    expect(qwen3ProfileSupportsInstruct({ mode: "customVoice", parameters: "1.7B" })).toBe(true);
  });
});

describe("preview chunkers", () => {
  it("chunk with exactly the parameters each runtime uses", () => {
    for (const backend of ["webgpu", "wasm", null] as const) {
      expect(enginePreviewChunks("kokoro", PREVIEW_TEXT, { settings: SURFACE_SETTINGS.kokoro, backend, quality: 5 }))
        .toEqual(chunkForKokoroDetailed(PREVIEW_TEXT, { backend }));
      for (const quality of [2, 5, 15]) {
        expect(surfaceEnginePreviewChunks("supertonic", PREVIEW_TEXT, SURFACE_SETTINGS, { backend, quality }))
          .toEqual(chunkWithConstraintsDetailed(PREVIEW_TEXT, { runtime: { backend, quality } }));
        expect(surfaceEnginePreviewChunks("supertonic3", PREVIEW_TEXT, SURFACE_SETTINGS, { backend, quality }))
          .toEqual(chunkWithConstraintsDetailed(PREVIEW_TEXT, {
            minCharacters: 30,
            maxCharacters: 280,
            runtime: { backend, quality },
          }));
      }
    }
    const japanese = { ...SURFACE_SETTINGS, supertonic3: { voice: "M1", language: "ja" } } as const;
    expect(surfaceEnginePreviewChunks("supertonic3", PREVIEW_TEXT, japanese, { backend: "wasm", quality: 5 }))
      .toEqual(chunkWithConstraintsDetailed(PREVIEW_TEXT, {
        minCharacters: 30,
        maxCharacters: 120,
        runtime: { backend: "wasm", quality: 5 },
      }));
    expect(surfaceEnginePreviewChunks("audio8", PREVIEW_TEXT, SURFACE_SETTINGS, { backend: null, quality: 5 }))
      .toEqual(chunkAudio8Text(PREVIEW_TEXT));
    expect(chunkAudio8Text(PREVIEW_TEXT)).toEqual(chunkWithConstraintsDetailed(PREVIEW_TEXT, {
      minCharacters: 30,
      maxCharacters: 180,
    }));
    expect(surfaceEnginePreviewChunks("qwen3", PREVIEW_TEXT, SURFACE_SETTINGS, { backend: null, quality: 5 }))
      .toEqual(buildQwen3RequestPlan(PREVIEW_TEXT).units);
    expect(enginePreviewChunks("neutts", PREVIEW_TEXT, { settings: neuttsEngine.defaultSettings, backend: null, quality: 5 }))
      .toEqual([{ text: PREVIEW_TEXT, start: 0, end: PREVIEW_TEXT.length, pauseAfterSec: 0, pauseKind: "none" }]);
  });

  it.each(ENGINE_IDS)("previews no passages for blank %s text", (id) => {
    const engine = ENGINES[id] as unknown as {
      defaultSettings: unknown;
      previewChunks: (text: string, context: { settings: unknown; backend: null; quality: number }) => unknown[];
    };
    const settings = id === "qwen3" ? QWEN3_LIVE : engine.defaultSettings;
    expect(engine.previewChunks("  \n ", { settings, backend: null, quality: 5 })).toEqual([]);
  });
});
