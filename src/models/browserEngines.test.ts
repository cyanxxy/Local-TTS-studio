import { describe, expect, it } from "vitest";
import { KITTEN_VOICES } from "../lib/kittenVoices";
import { chunkKittenText, chunkParadeeText, chunkPiperText } from "../lib/phonemeModels";
import { PIPER_DEFAULT_VOICE, PIPER_VOICES } from "../lib/piperVoices";
import type { GenerationTuningSettings } from "../types";
import { KITTEN_DOWNLOAD_BYTES, kittenEngine } from "./kitten";
import { PARADEE_DOWNLOAD_BYTES, paradeeEngine } from "./paradee";
import {
  joinPiperVoice,
  piperAccentLabel,
  piperEngine,
  piperQualityLabel,
  piperVoiceDownloadBytes,
  splitPiperVoice,
} from "./piper";
import {
  BROWSER_ENGINE_IDS,
  browserEnginePreviewChunks,
  browserEngineVoiceLabel,
  engineIsWasmOnly,
  ENGINE_REGISTRY,
  isBrowserEngineId,
} from "./registry";

const TUNING: GenerationTuningSettings = {
  speed: 1,
  quality: 5,
  language: "en",
  pauseOverridesSec: { none: 0, comma: 0.1, sentence: 0.2, paragraph: 0.3 },
};

const PREVIEW_TEXT = [
  "Chapter One",
  "",
  "The first paragraph has a few sentences. It keeps going, with a comma here; and a clause there.",
  "",
  "A second paragraph follows after a blank line, long enough that every chunker has to make a decision about where to cut it into passages for synthesis. And a third sentence closes it out.",
].join("\n");

const ENGINES = { kitten: kittenEngine, paradee: paradeeEngine, piper: piperEngine } as const;
const IDS = ["kitten", "paradee", "piper"] as const;

describe.each(IDS)("%s engine descriptor", (id) => {
  const engine = ENGINES[id];

  it("is a browser engine on both targets that honours exactly the Creator inputs its worker applies", () => {
    expect(isBrowserEngineId(id)).toBe(true);
    expect(BROWSER_ENGINE_IDS).toContain(id);
    expect(engine.runtime).toBe("browser-worker");
    expect(engine.targets).toEqual(["web", "desktop"]);
    expect(engine.capabilities).toEqual({
      speed: true,
      pauses: true,
      pronunciationLexicon: true,
      quality: null,
      languages: ["en"],
      voiceCloning: null,
      voiceDesign: false,
      instruct: false,
      seed: false,
      expressionTags: [],
      retake: true,
      streamingGranularity: "chunk",
    });
  });

  it("keeps its default voice among its voices and falls back to it for anything unreadable", () => {
    expect(engine.voices().map((voice) => voice.id).some((voiceId) => engine.defaultSettings.voice.startsWith(voiceId))).toBe(true);
    for (const garbage of [undefined, null, 42, "x", [], { voice: 7 }, { voice: "not-a-voice" }]) {
      expect(engine.parseSettings(garbage)).toEqual(engine.defaultSettings);
    }
    expect(engine.parseSettings(JSON.parse(JSON.stringify(engine.defaultSettings)))).toEqual(engine.defaultSettings);
  });

  it("credits its model with a licence and an https source", () => {
    expect(engine.credits.length).toBeGreaterThan(0);
    for (const credit of engine.credits) {
      expect(credit.name.length).toBeGreaterThan(0);
      expect(credit.license.length).toBeGreaterThan(0);
      expect(credit.sourceUrl).toMatch(/^https:\/\//);
    }
  });

  it("previews no passages for blank text and tracks the text it is given", () => {
    const context = { settings: engine.defaultSettings, backend: "wasm" as const, quality: 5 };
    expect(engine.previewChunks("   \n ", context)).toEqual([]);
    const chunks = engine.previewChunks(PREVIEW_TEXT, context);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(PREVIEW_TEXT.slice(chunk.start, chunk.end)).toBe(chunk.text);
  });

  it("is reachable through the browser-engine helpers the Reader uses", () => {
    expect(browserEnginePreviewChunks(id, PREVIEW_TEXT, { backend: "wasm", quality: 5 }))
      .toEqual(engine.previewChunks(PREVIEW_TEXT, { settings: engine.defaultSettings, backend: "wasm", quality: 5 }));
    expect(browserEngineVoiceLabel(id, engine.defaultSettings.voice)).toBe(engine.voiceLabel(engine.defaultSettings));
    expect(ENGINE_REGISTRY.map((entry) => entry.id)).toContain(id);
  });

  it("signs the voice and the audible Creator inputs, version 1 inputs included", () => {
    const parts = engine.signatureParts({ settings: engine.defaultSettings, tuning: TUNING, quality: 5 });
    expect(parts).toMatchObject({
      voice: engine.defaultSettings.voice,
      tuning: { speed: 1, pauseOverridesSec: TUNING.pauseOverridesSec },
      legacy: { voice: engine.defaultSettings.voice, quality: 5, tuning: TUNING },
    });
    // Neither a quality slider nor a language picker exists, so neither may invalidate audio.
    expect(parts?.tuning).not.toHaveProperty("quality");
    expect(parts?.tuning).not.toHaveProperty("language");
    expect(engine.signatureParts({ settings: engine.defaultSettings, tuning: { ...TUNING, language: "ko" }, quality: 12 })?.tuning)
      .toEqual(parts?.tuning);
  });
});

describe("Kitten TTS", () => {
  it("offers the eight voices the worker reports, each with its gender", () => {
    expect(kittenEngine.voices().map((voice) => voice.id)).toEqual(["Bella", "Jasper", "Luna", "Bruno", "Rosie", "Hugo", "Kiki", "Leo"]);
    expect(kittenEngine.voices().map((voice) => voice.id)).toEqual(KITTEN_VOICES.map((voice) => voice.id));
    expect(kittenEngine.voices()[0]).toMatchObject({ detail: "English · Female" });
    expect(kittenEngine.voices()[1]).toMatchObject({ detail: "English · Male" });
    expect(kittenEngine.parseSettings({ voice: "Leo" })).toEqual({ voice: "Leo" });
    expect(kittenEngine.voiceLabel({ voice: "Luna" })).toBe("Luna");
    expect(kittenEngine.detail({ voice: "Luna" })).toBe("15M · Luna");
  });

  it("previews with the worker's chunker for the backend it resolved", () => {
    for (const backend of ["webgpu", "wasm", null] as const) {
      expect(kittenEngine.previewChunks(PREVIEW_TEXT, { settings: kittenEngine.defaultSettings, backend, quality: 5 }))
        .toEqual(chunkKittenText(PREVIEW_TEXT, backend));
    }
    const long = Array.from({ length: 12 }, (_, index) => `Sentence ${index} is long enough to need planning.`).join(" ");
    const longest = (backend: "webgpu" | "wasm") => Math.max(...kittenEngine
      .previewChunks(long, { settings: kittenEngine.defaultSettings, backend, quality: 5 })
      .map((chunk) => chunk.text.length));
    expect(longest("webgpu")).toBeGreaterThan(longest("wasm"));
  });

  it("reports the size of its pinned download", () => {
    expect(KITTEN_DOWNLOAD_BYTES).toBe(60_046_685);
  });

  it("is not wasm-only: it uses WebGPU when it can", () => {
    expect(engineIsWasmOnly("kitten")).toBe(false);
  });
});

describe("Paradee", () => {
  it("offers its single voice", () => {
    expect(paradeeEngine.voices()).toEqual([{ id: "heart", label: "Heart", detail: "English · Female" }]);
    expect(paradeeEngine.parseSettings({ voice: "bella" })).toEqual({ voice: "heart" });
    expect(paradeeEngine.voiceLabel({ voice: "heart" })).toBe("Heart");
    expect(paradeeEngine.detail({ voice: "heart" })).toBe("8M · Heart");
  });

  it("previews with the worker's chunker, whatever the backend", () => {
    for (const backend of ["webgpu", "wasm", null] as const) {
      expect(paradeeEngine.previewChunks(PREVIEW_TEXT, { settings: paradeeEngine.defaultSettings, backend, quality: 5 }))
        .toEqual(chunkParadeeText(PREVIEW_TEXT));
    }
  });

  it("runs on the CPU by design and reports the size of its pinned download", () => {
    expect(engineIsWasmOnly("paradee")).toBe(true);
    expect(PARADEE_DOWNLOAD_BYTES).toBe(9_039_745);
  });
});

describe("Piper", () => {
  const LIBRITTS = "en_US-libritts-high";

  it("offers the eight curated catalog voices, grouped by accent with their size and licence", () => {
    const voices = piperEngine.voices();
    expect(voices.map((voice) => voice.id)).toEqual(PIPER_VOICES.map((voice) => voice.id));
    expect(voices).toHaveLength(8);
    expect(new Set(voices.map((voice) => voice.label)).size).toBe(8);
    expect(new Set(voices.map((voice) => voice.group))).toEqual(new Set(["American English", "British English"]));
    const kristin = voices.find((voice) => voice.id === "en_US-kristin-medium");
    expect(kristin).toMatchObject({ label: "Kristin · Medium", group: "American English" });
    expect(kristin?.detail).toMatch(/^\d+ MB · public-domain$/);
    expect(voices.find((voice) => voice.id === LIBRITTS)?.detail).toMatch(/CC-BY-4\.0$/);
  });

  it("sums a voice's graph and config for its download size", () => {
    for (const voice of PIPER_VOICES) {
      expect(piperVoiceDownloadBytes(voice), voice.id).toBeGreaterThan(40_000_000);
      expect(piperVoiceDownloadBytes(voice), voice.id).toBeLessThan(200_000_000);
    }
  });

  it("names accents and quality tiers for the voice browser", () => {
    expect(piperAccentLabel(PIPER_VOICES.find((voice) => voice.locale === "en_GB")!)).toBe("British");
    expect(piperAccentLabel(PIPER_VOICES.find((voice) => voice.locale === "en_US")!)).toBe("American");
    expect(piperQualityLabel("high")).toBe("High");
    expect(piperQualityLabel("x_low")).toBe("Compact");
  });

  it("keeps a multi-speaker voice's speaker and drops one that cannot exist", () => {
    expect(piperEngine.parseSettings({ voice: `${LIBRITTS}#12` })).toEqual({ voice: `${LIBRITTS}#12` });
    expect(piperEngine.parseSettings({ voice: `${LIBRITTS}#903` })).toEqual({ voice: `${LIBRITTS}#903` });
    expect(piperEngine.parseSettings({ voice: `${LIBRITTS}#904` })).toEqual({ voice: LIBRITTS });
    expect(piperEngine.parseSettings({ voice: `${LIBRITTS}#p239` })).toEqual({ voice: LIBRITTS });
    expect(piperEngine.parseSettings({ voice: "en_US-kristin-medium#3" })).toEqual({ voice: "en_US-kristin-medium" });
    expect(piperEngine.parseSettings({ voice: "en_US-nobody-medium" })).toEqual({ voice: PIPER_DEFAULT_VOICE });
    expect(piperEngine.parseSettings({ voice: "en_US-nobody-medium#1" })).toEqual({ voice: PIPER_DEFAULT_VOICE });
  });

  it("splits and joins the worker's voice string", () => {
    expect(splitPiperVoice(`${LIBRITTS}#12`)).toEqual({ id: LIBRITTS, speaker: 12 });
    expect(splitPiperVoice(LIBRITTS)).toEqual({ id: LIBRITTS, speaker: null });
    expect(splitPiperVoice(`${LIBRITTS}#abc`)).toEqual({ id: LIBRITTS, speaker: null });
    const libritts = PIPER_VOICES.find((voice) => voice.id === LIBRITTS)!;
    const kristin = PIPER_VOICES.find((voice) => voice.id === "en_US-kristin-medium")!;
    expect(joinPiperVoice(libritts, 4)).toBe(`${LIBRITTS}#4`);
    expect(joinPiperVoice(libritts, null)).toBe(LIBRITTS);
    expect(joinPiperVoice(kristin, 4)).toBe("en_US-kristin-medium");
  });

  it("labels the voice and the speaker the way the picker shows them", () => {
    expect(piperEngine.voiceLabel({ voice: "en_US-kristin-medium" })).toBe("Kristin · Medium");
    expect(piperEngine.voiceLabel({ voice: `${LIBRITTS}#12` })).toBe("LibriTTS · High · Speaker 12");
    expect(piperEngine.detail({ voice: "en_GB-cori-high" })).toBe("VITS · Cori · High");
    expect(browserEngineVoiceLabel("piper", `${LIBRITTS}#12`)).toBe("LibriTTS · High · Speaker 12");
  });

  it("signs the speaker, because it changes the audio", () => {
    const sign = (voice: string) => piperEngine.signatureParts({ settings: { voice }, tuning: TUNING, quality: 5 });
    expect(sign(`${LIBRITTS}#12`)).not.toEqual(sign(`${LIBRITTS}#13`));
    expect(sign(`${LIBRITTS}#12`)).not.toEqual(sign("en_US-kristin-medium"));
  });

  it("previews with the worker's chunker for every voice", () => {
    for (const voice of PIPER_VOICES) {
      expect(piperEngine.previewChunks(PREVIEW_TEXT, { settings: { voice: voice.id }, backend: "wasm", quality: 5 }))
        .toEqual(chunkPiperText(PREVIEW_TEXT));
    }
  });

  it("credits the Piper voices and every dataset, with the CC BY 4.0 attribution for LibriTTS", () => {
    const [piper, ...datasets] = piperEngine.credits;
    expect(piper).toMatchObject({ name: "Piper voices", license: "MIT" });
    const libritts = datasets.find((credit) => credit.license === "CC-BY-4.0");
    expect(libritts).toBeDefined();
    expect(libritts).toMatchObject({
      name: "LibriTTS",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      sourceUrl: "https://www.openslr.org/60/",
    });
    expect(libritts?.note).toBe(PIPER_VOICES.find((voice) => voice.id === LIBRITTS)?.attribution);
    // Every catalog voice appears in the credits by name, so none is used uncredited.
    const credited = datasets.map((credit) => credit.name).join(", ");
    for (const voice of PIPER_VOICES) expect(credited, voice.id).toContain(voice.name);
  });

  it("ships a licence and attribution line for every voice it offers", () => {
    for (const voice of PIPER_VOICES) {
      expect(voice.license.id, voice.id).toMatch(/^(public-domain|CC0-1\.0|CC-BY-4\.0|Apache-2\.0|MIT)$/);
      expect(voice.attribution, voice.id).toContain(voice.name);
    }
    const ccBy = PIPER_VOICES.filter((voice) => voice.license.id === "CC-BY-4.0");
    expect(ccBy.length).toBeGreaterThan(0);
    for (const voice of ccBy) expect(voice.attribution, voice.id).toMatch(/CC BY 4\.0/);
  });

  it("runs on the CPU by design", () => {
    expect(engineIsWasmOnly("piper")).toBe(true);
  });
});
