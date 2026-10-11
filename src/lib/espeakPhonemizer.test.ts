// @vitest-environment node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const PHONEMIZER_BUILD_URL = pathToFileURL(resolve("node_modules/phonemizer/dist/phonemizer.js")).href;

/** A fresh module instance, so each test starts with no phonemizer loaded. */
async function importPhonemizer() {
  vi.resetModules();
  return import("./espeakPhonemizer");
}

afterEach(() => {
  vi.resetModules();
});

describe("phonemizeKeepingPunctuation", () => {
  it("phonemizes only the words and splices punctuation back in with exact source ranges", async () => {
    const { phonemizeKeepingPunctuation } = await importPhonemizer();
    const phonemize = vi.fn(async (text: string) => [`<${text}>`]);

    const result = await phonemizeKeepingPunctuation("Hello, big world! Bye", phonemize);

    expect(phonemize.mock.calls).toEqual([["Hello", "en-us"], ["big world", "en-us"], ["Bye", "en-us"]]);
    expect(result.phonemes).toBe("<Hello>, <big world>! <Bye>");
    expect(result.segments).toEqual([
      { textStart: 0, textEnd: 5, phonemeStart: 0, phonemeEnd: 7, punctuation: false },
      { textStart: 5, textEnd: 7, phonemeStart: 7, phonemeEnd: 9, punctuation: true },
      { textStart: 7, textEnd: 16, phonemeStart: 9, phonemeEnd: 20, punctuation: false },
      { textStart: 16, textEnd: 18, phonemeStart: 20, phonemeEnd: 22, punctuation: true },
      { textStart: 18, textEnd: 21, phonemeStart: 22, phonemeEnd: 27, punctuation: false },
    ]);
  });

  it("joins multi-line eSpeak output, keeps every preserved mark and normalizes curly apostrophes", async () => {
    const { phonemizeKeepingPunctuation, PRESERVED_PUNCTUATION } = await importPhonemizer();
    const phonemize = vi.fn(async (text: string) => text.split(" "));

    const result = await phonemizeKeepingPunctuation(`(don’t stop) [a-b] ${PRESERVED_PUNCTUATION}`, phonemize, "en");

    expect(phonemize.mock.calls).toEqual([["don't stop", "en"], ["a-b", "en"]]);
    expect(result.phonemes).toBe(`(don't stop) [a-b] ${PRESERVED_PUNCTUATION}`);
    expect(result.segments.map((segment) => segment.punctuation)).toEqual([true, false, true, false, true]);
  });

  it("keeps decimal, thousands and time separators inside their numbers", async () => {
    const { phonemizeKeepingPunctuation } = await importPhonemizer();
    const phonemize = vi.fn(async (text: string) => [text]);

    await phonemizeKeepingPunctuation("Pay $4.50, 1,000 or 10:30. Then 7. 8", phonemize);

    expect(phonemize.mock.calls.map(([text]) => text)).toEqual(["Pay $4.50", "1,000 or 10:30", "Then 7", "8"]);
  });

  it("passes whitespace-only text through without calling eSpeak", async () => {
    const { phonemizeKeepingPunctuation } = await importPhonemizer();
    const phonemize = vi.fn(async () => ["unused"]);

    await expect(phonemizeKeepingPunctuation("   ", phonemize)).resolves.toEqual({
      phonemes: "   ",
      segments: [{ textStart: 0, textEnd: 3, phonemeStart: 0, phonemeEnd: 3, punctuation: false }],
    });
    await expect(phonemizeKeepingPunctuation("", phonemize)).resolves.toEqual({ phonemes: "", segments: [] });
    expect(phonemize).not.toHaveBeenCalled();
  });
});

describe("loadEspeakPhonemizer", () => {
  it("loads the real unbundled phonemizer build once and produces American English IPA", async () => {
    const { loadEspeakPhonemizer, phonemizeKeepingPunctuation } = await importPhonemizer();

    const phonemize = await loadEspeakPhonemizer(PHONEMIZER_BUILD_URL);
    expect(await loadEspeakPhonemizer(PHONEMIZER_BUILD_URL)).toBe(phonemize);
    const result = await phonemizeKeepingPunctuation("Hello, world!", phonemize);

    expect(result.phonemes).toBe("həlˈoʊ, wˈɜːld!");
  });

  it("rejects a module without phonemize() and lets a later call retry", async () => {
    const { loadEspeakPhonemizer } = await importPhonemizer();
    const brokenUrl = "data:text/javascript,export const other = 1;";

    await expect(loadEspeakPhonemizer(brokenUrl)).rejects.toThrow("does not export phonemize()");
    await expect(loadEspeakPhonemizer(brokenUrl)).rejects.toThrow("does not export phonemize()");
    await expect(loadEspeakPhonemizer(PHONEMIZER_BUILD_URL)).resolves.toBeTypeOf("function");
  });
});
