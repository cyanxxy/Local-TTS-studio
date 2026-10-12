import { describe, expect, it } from "vitest";
import { PIPER_CATALOG } from "../workers/manifests/piperVoices";
import {
  findPiperVoice,
  isEnglishEspeakVoice,
  PIPER_DEFAULT_VOICE,
  PIPER_PERMISSIVE_LICENSES,
  PIPER_VOICES,
  resolvePiperVoice,
} from "./piperVoices";

describe("the Piper catalog", () => {
  it("pins a full commit of the MIT-licensed voices repository", () => {
    expect(PIPER_CATALOG.repo).toBe("rhasspy/piper-voices");
    expect(PIPER_CATALOG.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(PIPER_CATALOG.license).toBe("mit");
  });

  it("lists only permissively licensed, English-phonemizable voices with a credit line", () => {
    expect(PIPER_VOICES.length).toBeGreaterThan(0);
    for (const voice of PIPER_VOICES) {
      expect(PIPER_PERMISSIVE_LICENSES, voice.id).toContain(voice.license.id);
      expect(isEnglishEspeakVoice(voice.espeakVoice), voice.id).toBe(true);
      expect(["en_US", "en_GB"], voice.id).toContain(voice.locale);
      expect(voice.attribution, voice.id).toContain(voice.name);
      if (voice.license.id !== "public-domain") expect(voice.attribution, voice.id).toContain(voice.datasetUrl ?? voice.license.url ?? "");
    }
  });

  it("has unique ids and a pinned size and digest for every graph and config", () => {
    expect(new Set(PIPER_VOICES.map((voice) => voice.id)).size).toBe(PIPER_VOICES.length);
    for (const voice of PIPER_VOICES) {
      expect(voice.model).toBe(`${voice.language}/${voice.locale}/${voice.id.split("-")[1]}/${voice.quality}/${voice.id}.onnx`);
      expect(voice.config).toBe(`${voice.model}.json`);
      for (const file of [voice.model, voice.config]) {
        expect((PIPER_CATALOG.files as Record<string, unknown>)[file], file).toMatchObject({ byteLength: expect.any(Number), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
      }
    }
    expect(Object.keys(PIPER_CATALOG.files).length).toBe(PIPER_VOICES.length * 2);
  });

  it("includes the default voice and none of the known non-permissive datasets", () => {
    expect(findPiperVoice(PIPER_DEFAULT_VOICE)).toBeDefined();
    const names = PIPER_VOICES.map((voice) => voice.name.toLowerCase());
    for (const excluded of ["ryan", "lessac", "amy", "hfc_female", "semaine", "kathleen", "alba", "aru", "vctk", "joe", "mike", "sam", "reza ibrahim", "libritts-r"]) expect(names).not.toContain(excluded);
  });
});

describe("resolvePiperVoice", () => {
  const multi = PIPER_VOICES.find((voice) => voice.numSpeakers > 1)!;
  const single = PIPER_VOICES.find((voice) => voice.numSpeakers === 1)!;

  it("finds a voice by id and splits off a speaker for multi-speaker voices", () => {
    expect(resolvePiperVoice(single.id)).toEqual({ voice: single, speaker: null });
    expect(resolvePiperVoice(`${multi.id}#p239`)).toEqual({ voice: multi, speaker: "p239" });
    expect(resolvePiperVoice(multi.id)).toEqual({ voice: multi, speaker: null });
  });

  it("ignores a speaker on single-speaker voices", () => {
    expect(resolvePiperVoice(`${single.id}#3`)).toEqual({ voice: single, speaker: null });
  });

  it("falls back to the default voice for ids from other models", () => {
    expect(resolvePiperVoice("af_heart").voice.id).toBe(PIPER_DEFAULT_VOICE);
    expect(resolvePiperVoice("").voice.id).toBe(PIPER_DEFAULT_VOICE);
  });
});

describe("isEnglishEspeakVoice", () => {
  it("accepts English variants only", () => {
    expect(["en", "en-us", "en-gb-x-rp"].map(isEnglishEspeakVoice)).toEqual([true, true, true]);
    expect(["de", "eng", "fr-fr", ""].map(isEnglishEspeakVoice)).toEqual([false, false, false, false]);
  });
});
