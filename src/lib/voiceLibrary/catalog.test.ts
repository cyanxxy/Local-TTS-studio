import { describe, expect, it } from "vitest";
import {
  buildEngineCatalog,
  catalogFacets,
  engineVoiceKey,
  filterCatalog,
  inferGender,
  inferLanguage,
  libraryCatalogVoice,
} from "./catalog";
import type { ClonedVoiceRecord, DesignedVoiceRecord, PresetVoiceRecord } from "./types";

const audio = { sampleRate: 24000, durationSec: 6, byteLength: 100, sha256: "a".repeat(64) };
const base = { schemaVersion: 1 as const, description: "", tags: [], favorite: false, createdAt: 1, updatedAt: 1 };

const preset: PresetVoiceRecord = {
  ...base,
  id: "p1",
  name: "Heart, brisk",
  kind: "preset",
  tags: ["audiobook"],
  preset: { engineId: "kokoro", voiceId: "af_heart", settings: { speed: 1.1, language: "English" } },
};
const clone: ClonedVoiceRecord = {
  ...base,
  id: "c1",
  name: "My voice",
  kind: "cloned",
  description: "A warm female narrator",
  transcript: "Hello there, friend.",
  language: "English",
  targets: ["qwen3-base"],
  source: "recording",
  reference: audio,
};
const designed: DesignedVoiceRecord = {
  ...base,
  id: "d1",
  name: "Gravel",
  kind: "designed",
  favorite: true,
  design: { description: "A low gravelly male storyteller", seed: 7, language: "Auto", previewText: "Once." },
};

describe("inference", () => {
  it("reads gender and language out of engine text", () => {
    expect(inferGender("English · Female")).toBe("female");
    expect(inferGender(undefined, "American · Male")).toBe("male");
    expect(inferGender("English")).toBeNull();
    expect(inferLanguage("English · Female")).toBe("English");
    expect(inferLanguage("Female", "Chinese / English · Female")).toBe("Chinese / English");
    expect(inferLanguage(undefined)).toBeNull();
  });
});

describe("engine catalog", () => {
  it("lists the voices of every engine, using runtime voices where the engine needs them", () => {
    const catalog = buildEngineCatalog({ kokoro: ["af_heart", "bm_george"] }, new Set([engineVoiceKey("kokoro", "bm_george")]));
    const kokoro = catalog.filter((voice) => voice.engineId === "kokoro");
    expect(kokoro.map((voice) => voice.voiceId)).toEqual(["af_heart", "bm_george"]);
    expect(kokoro[0]).toMatchObject({ origin: "engine", gender: "female", preset: { engineId: "kokoro", voiceId: "af_heart", mode: "preset" } });
    expect(kokoro[1].favorite).toBe(true);
    expect(new Set(catalog.map((voice) => voice.engineId)).size).toBeGreaterThan(2);
    expect(new Set(catalog.map((voice) => voice.key)).size).toBe(catalog.length);
    const audio8 = catalog.find((voice) => voice.engineId === "audio8" && voice.voiceId === "arthur");
    expect(audio8).toMatchObject({ language: "English", gender: "male" });
  });
});

describe("library entries and filtering", () => {
  const library = [preset, clone, designed].map((record) => libraryCatalogVoice(record));
  const all = [...buildEngineCatalog({ kokoro: ["af_heart", "bm_george"] }), ...library];

  it("describes each kind with the preset that renders it", () => {
    expect(library[0]).toMatchObject({ engineId: "kokoro", language: "English", detail: "Preset · Kokoro" });
    expect(library[1]).toMatchObject({ engineId: "qwen3", gender: "female", detail: "Cloned voice · 6.0 s", preset: { mode: "voiceClone" } });
    expect(library[2]).toMatchObject({ gender: "male", language: null, favorite: true, preset: { mode: "voiceDesign" } });
  });

  it("filters by scope, engine, language, gender and favorites", () => {
    expect(filterCatalog(all, { scope: "mine" }).map((voice) => voice.name)).toEqual(["Gravel", "Heart, brisk", "My voice"]);
    expect(filterCatalog(all, { scope: "builtin", engineId: "kokoro" })).toHaveLength(2);
    expect(filterCatalog(all, { gender: "male", scope: "builtin", engineId: "kokoro" }).map((voice) => voice.voiceId)).toEqual(["bm_george"]);
    expect(filterCatalog(all, { language: "english", scope: "mine" }).map((voice) => voice.name)).toEqual(["Heart, brisk", "My voice"]);
    expect(filterCatalog(all, { favoritesOnly: true }).map((voice) => voice.name)).toEqual(["Gravel"]);
  });

  it("searches names, tags, transcripts and design descriptions", () => {
    expect(filterCatalog(all, { query: "AUDIOBOOK" }).map((voice) => voice.name)).toEqual(["Heart, brisk"]);
    expect(filterCatalog(all, { query: "hello there" }).map((voice) => voice.name)).toEqual(["My voice"]);
    expect(filterCatalog(all, { query: "gravelly" }).map((voice) => voice.name)).toEqual(["Gravel"]);
    expect(filterCatalog(all, { query: "no such voice" })).toEqual([]);
  });

  it("orders favorites first, then saved voices, then engine order", () => {
    const names = filterCatalog(all).map((voice) => voice.name);
    expect(names.slice(0, 3)).toEqual(["Gravel", "Heart, brisk", "My voice"]);
  });

  it("offers the engines and languages present as filter choices", () => {
    const facets = catalogFacets(all);
    expect(facets.engines.map((engine) => engine.id)).toContain("qwen3");
    expect(facets.languages).toContain("English");
    expect([...facets.languages]).toEqual([...facets.languages].sort((a, b) => a.localeCompare(b)));
  });
});
