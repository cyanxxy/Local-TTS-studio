// @vitest-environment node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as ort from "onnxruntime-web";
import { describe, expect, it, vi } from "vitest";
import { loadEspeakPhonemizer, type EspeakPhonemize } from "./espeakPhonemizer";
import {
  chunkParadeeText,
  espeakToMisaki,
  normalizeParadeeText,
  paradeePhonemes,
  ParadeeRuntime,
  parseParadeeVocabulary,
  tokenizeParadeePhonemes,
} from "./paradeeRuntime";
import { ChunkTooLongError, type StyleTtsSession } from "./styleTtsRuntime";

const PHONEMIZER_BUILD_URL = pathToFileURL(resolve("node_modules/phonemizer/dist/phonemizer.js")).href;

function configBuffer(value: unknown): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify(value)).buffer;
}

/** A few Kokoro vocabulary entries (the pinned config.json uses these ids). */
const VOCAB = { ";": 1, ",": 3, ".": 4, "!": 5, " ": 16, a: 43, b: 44, d: 46, "ˈ": 156 };

function fakeSession(waveform: Float32Array) {
  const disposed = vi.fn();
  const run = vi.fn(async (feeds: Record<string, ort.Tensor>) => {
    void feeds;
    const output = new ort.Tensor("float32", waveform, [1, waveform.length]);
    vi.spyOn(output, "dispose").mockImplementation(disposed);
    return { waveform: output } as ort.InferenceSession.ReturnType;
  });
  const session = { run, release: vi.fn(async () => undefined) } as unknown as StyleTtsSession;
  return { session, run, disposed };
}

describe("normalizeParadeeText", () => {
  // Expected strings come from kokoro-js 1.2.1's own normalize_text.
  it.each([
    [
      "Dr. Smith paid $4.50 for 3 coffees in 1984, at 10:05 — “really”  (yeah).",
      "Doctor Smith paid 4 dollars and 50 cents for 3 coffees in 19 84, at 10 oh 5 — \"really\" «ye'a».",
    ],
    [
      "Mr. Jones vs. Mrs. Lee, etc. and the 1990s; 1,000 or 2.5 km, 5-7 days.",
      "Mister Jones vs. Mrs Lee, etc. and the 19 90s; 1000 or 2 point 5 km, 5 to 7 days.",
    ],
  ])("matches kokoro-js for %s", (text, expected) => {
    expect(normalizeParadeeText(text)).toBe(expected);
  });

  it("collapses every run of spaces, not only the first", () => {
    expect(normalizeParadeeText("one  two   three\tfour")).toBe("one two three four");
  });
});

describe("espeakToMisaki", () => {
  // Expected strings come from Paradee's web/misaki.js applied after kokoro-js's fixes.
  it.each([
    ["ðə lˈaɪbɹɛɹi ˈoʊpənz æt nˈaɪn", "ðə lˈIbɹɛɹi ˈOpənz æt nˈIn"],
    ["bˈʌʔn̩ nˈeɪvəl ɐ kˈæt tʃˈɜːtʃ dʒˈʌdʒ ɔɪl", "bˈʌtn nˈAvᵊl ɐ kˈæt ʧˈɜɹʧ ʤˈʌʤ Yl"],
  ])("converts %s", (espeak, misaki) => {
    expect(espeakToMisaki(espeak)).toBe(misaki);
  });
});

describe("paradeePhonemes", () => {
  it("normalizes, keeps punctuation, applies kokoro-js's fixes and converts to misaki", async () => {
    const phonemize = vi.fn<EspeakPhonemize>(async (text) => [text === "Ninety hundred" ? "nˈaɪnti hˈʌndɹɪd" : "wˈɜːld"]);

    await expect(paradeePhonemes("Ninety hundred,  world!", phonemize)).resolves.toBe("nˈIndi hˈʌndɹɪd, wˈɜɹld!");
    expect(phonemize.mock.calls).toEqual([["Ninety hundred", "en-us"], ["world", "en-us"]]);
  });

  it.each([
    ["The library opens at nine, and the reading room stays quiet.", "ðə lˈIbɹɛɹi ˈOpənz æt nˈIn, ænd ðə ɹˈidɪŋ ɹˈum stˈAz kwˈIət."],
    ["Ninety bottles; a naval button, (really)!", "nˈIndi bˈɑTəlz; ɐ nˈAvᵊl bˈʌtn, «ɹˈiəli»!"],
  ])("matches the kokoro-js + web/misaki.js pipeline with the real eSpeak build for %s", async (text, expected) => {
    const phonemize = await loadEspeakPhonemizer(PHONEMIZER_BUILD_URL);

    await expect(paradeePhonemes(text, phonemize)).resolves.toBe(expected);
  });
});

describe("parseParadeeVocabulary", () => {
  it("reads the single-character Kokoro vocabulary", () => {
    const vocabulary = parseParadeeVocabulary(configBuffer({ sample_rate: 24_000, vocab: VOCAB }));

    expect(vocabulary.get("ˈ")).toBe(156);
    expect(vocabulary.size).toBe(Object.keys(VOCAB).length);
  });

  it.each([
    ["invalid JSON", new TextEncoder().encode("{").buffer, "invalid JSON"],
    ["another sample rate", configBuffer({ sample_rate: 22_050, vocab: VOCAB }), "unexpected sample rate"],
    ["a missing vocab", configBuffer({ sample_rate: 24_000 }), "has no vocab"],
    ["an empty vocab", configBuffer({ sample_rate: 24_000, vocab: {} }), "empty vocab"],
    ["multi-character symbols", configBuffer({ sample_rate: 24_000, vocab: { ab: 2 } }), "invalid vocab entry for \"ab\""],
    ["the pad id", configBuffer({ sample_rate: 24_000, vocab: { a: 0 } }), "invalid vocab entry for \"a\""],
    ["non-integer ids", configBuffer({ sample_rate: 24_000, vocab: { a: 1.5 } }), "invalid vocab entry"],
  ] as const)("rejects %s", (_label, buffer, message) => {
    expect(() => parseParadeeVocabulary(buffer)).toThrow(message);
  });
});

describe("tokenizeParadeePhonemes", () => {
  it("pads both ends with 0 and drops symbols outside the vocabulary", () => {
    const vocabulary = new Map(Object.entries(VOCAB));

    expect(tokenizeParadeePhonemes("ˈab, ʒd!", vocabulary)).toEqual([0, 156, 43, 44, 3, 16, 46, 5, 0]);
  });
});

describe("chunkParadeeText", () => {
  it("keeps chunks within 280 characters with exact source offsets", () => {
    const text = Array.from({ length: 20 }, (_, index) => `Line ${index} of a long passage that keeps going for a while.`).join(" ");
    const chunks = chunkParadeeText(text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(280);
      expect(text.slice(chunk.start, chunk.end)).toBe(chunk.text);
    }
  });
});

describe("ParadeeRuntime.synthesize", () => {
  const vocabulary = new Map(Object.entries(VOCAB));
  const phonemize: EspeakPhonemize = async (text) => [text.toLowerCase()];

  it("feeds padded ids and speed, returns trimmed standalone audio and disposes the output", async () => {
    // 100 ms of digital silence on each side; 50 ms of it is kept.
    const waveform = new Float32Array(2400 + 3 + 2400);
    waveform.set([0.1, -0.2, 0.3], 2400);
    const { session, run, disposed } = fakeSession(waveform);
    const runtime = new ParadeeRuntime(session, vocabulary, phonemize);

    const audio = await runtime.synthesize("Bad ad.", 1.1);

    const feeds = run.mock.calls[0][0];
    expect(Array.from(feeds.input_ids.data as BigInt64Array, Number)).toEqual([0, 44, 43, 46, 16, 43, 46, 4, 0]);
    expect(feeds.input_ids.dims).toEqual([1, 9]);
    expect((feeds.speed.data as Float32Array)[0]).toBeCloseTo(1.1);
    expect(feeds.speed.dims).toEqual([1]);
    expect(audio.length).toBe(1200 + 3 + 1200);
    expect(Array.from(audio.subarray(1200, 1203))).toEqual(Array.from(waveform.subarray(2400, 2403)));
    expect(audio.buffer).not.toBe(waveform.buffer);
    expect(disposed).toHaveBeenCalledOnce();
  });

  it("rejects chunks over the graph's token limit before inference", async () => {
    const { session, run } = fakeSession(new Float32Array(1));
    const runtime = new ParadeeRuntime(session, vocabulary, phonemize);

    await expect(runtime.synthesize("ab ".repeat(200), 1)).rejects.toBeInstanceOf(ChunkTooLongError);
    expect(run).not.toHaveBeenCalled();
  });

  it("returns empty audio without inference when only punctuation would be spoken", async () => {
    const { session, run } = fakeSession(new Float32Array(1));
    const runtime = new ParadeeRuntime(session, vocabulary, phonemize);

    await expect(runtime.synthesize("... !", 1)).resolves.toEqual(new Float32Array(0));
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects non-finite audio, disposes the output and releases the session on dispose", async () => {
    const { session, disposed } = fakeSession(Float32Array.of(Number.POSITIVE_INFINITY));
    const runtime = new ParadeeRuntime(session, vocabulary, phonemize);

    await expect(runtime.synthesize("Bad.", 1)).rejects.toThrow("non-finite waveform");
    expect(disposed).toHaveBeenCalledOnce();
    await runtime.dispose();
    expect(session.release).toHaveBeenCalledOnce();
  });
});
