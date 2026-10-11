import * as ort from "onnxruntime-web";
import { describe, expect, it, vi } from "vitest";
import type { EspeakPhonemize } from "./espeakPhonemizer";
import {
  chunkKittenText,
  ensureTerminalPunctuation,
  KITTEN_MAX_CHUNK_CHARACTERS,
  KittenRuntime,
  kittenWordTimings,
  tokenizeKittenPhonemes,
} from "./kittenRuntime";
import { KITTEN_VOICES, KittenStyleTable } from "./kittenVoices";
import { ChunkTooLongError, type StyleTtsSession } from "./styleTtsRuntime";

const FRAME = 600;

/** Stands in for eSpeak: lower-cased letters are valid Kitten symbols. */
const lowerCasePhonemize: EspeakPhonemize = async (text) => [text.toLowerCase()];

function styleTables(): Map<string, KittenStyleTable> {
  // Row r of every table starts with r, so tests can see which row was used.
  const data = new Float32Array(400 * 256);
  for (let row = 0; row < 400; row += 1) data[row * 256] = row;
  return new Map(KITTEN_VOICES.map((voice) => [voice.styleKey, new KittenStyleTable({ shape: [400, 256], data }, voice.styleKey)]));
}

interface FakeOutputs {
  waveform: Float32Array;
  duration?: number[];
}

function fakeSession(outputs: (feeds: Record<string, ort.Tensor>) => FakeOutputs) {
  const disposed: string[] = [];
  const run = vi.fn(async (feeds: Record<string, ort.Tensor>) => {
    const result = outputs(feeds);
    const waveform = new ort.Tensor("float32", result.waveform, [result.waveform.length]);
    vi.spyOn(waveform, "dispose").mockImplementation(() => disposed.push("waveform"));
    const tensors: Record<string, ort.Tensor> = { waveform };
    if (result.duration) {
      const duration = new ort.Tensor("int64", BigInt64Array.from(result.duration, BigInt), [result.duration.length]);
      vi.spyOn(duration, "dispose").mockImplementation(() => disposed.push("duration"));
      tensors.duration = duration;
    }
    return tensors as ort.InferenceSession.ReturnType;
  });
  const session = { run, release: vi.fn(async () => undefined) } as unknown as StyleTtsSession;
  return { session, run, disposed };
}

/** A waveform whose frames are loud (0.5) inside [loudStart, loudEnd) and silent elsewhere. */
function framedWaveform(frameCount: number, loudStart: number, loudEnd: number): Float32Array {
  const samples = new Float32Array(frameCount * FRAME);
  samples.fill(0.5, loudStart * FRAME, loudEnd * FRAME);
  return samples;
}

describe("tokenizeKittenPhonemes", () => {
  // Expected ids come from upstream's basic_english_tokenize + TextCleaner
  // (kittenml/kittentts_legacy/onnx_model.py) run on the same strings.
  it.each([
    ["həlˈoʊ, wˈɜːld!", [0, 50, 83, 54, 156, 57, 135, 16, 3, 16, 65, 156, 87, 158, 54, 46, 16, 5, 10, 0]],
    ["ɹˈɪðəm bˈʌʔn̩.", [0, 123, 156, 102, 81, 83, 55, 16, 44, 156, 138, 148, 56, 16, 175, 16, 4, 10, 0]],
    [
      "ðə “lˈɪɾəl” — ˈoʊpən… x1y",
      [0, 81, 83, 16, 16, 54, 156, 102, 125, 83, 54, 16, 16, 9, 16, 156, 57, 135, 58, 83, 56, 16, 10, 16, 66, 67, 10, 0],
    ],
  ])("matches the Python front end for %s", (phonemes, ids) => {
    expect(tokenizeKittenPhonemes(phonemes).ids).toEqual(ids);
  });

  it("records where every id came from in the phoneme string", () => {
    expect(tokenizeKittenPhonemes("ab, c")).toEqual({
      ids: [0, 43, 44, 16, 3, 16, 45, 10, 0],
      phonemeOffsets: [-1, 0, 1, -1, 2, -1, 4, -1, -1],
    });
  });
});

describe("ensureTerminalPunctuation", () => {
  it("appends a comma like upstream ensure_punctuation, keeping existing prosodic marks", () => {
    expect(ensureTerminalPunctuation("Hello there  ")).toBe("Hello there,");
    expect(ensureTerminalPunctuation("Hello there.")).toBe("Hello there.");
    expect(ensureTerminalPunctuation("Wait;")).toBe("Wait;");
    expect(ensureTerminalPunctuation("   ")).toBe("   ");
  });
});

describe("chunkKittenText", () => {
  const text = Array.from({ length: 30 }, (_, index) => `Sentence number ${index} keeps the reader company for a while.`).join(" ");

  it.each([["webgpu", KITTEN_MAX_CHUNK_CHARACTERS], ["wasm", 240], [null, 240]] as const)(
    "keeps %s chunks within %i characters with exact source offsets",
    (backend, limit) => {
      const chunks = chunkKittenText(text, backend);

      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(limit);
        expect(text.slice(chunk.start, chunk.end)).toBe(chunk.text);
      }
    },
  );
});

describe("KittenRuntime.synthesize", () => {
  // "Hi there" becomes "hi there," → ids [0, h, i, ␠, t, h, e, r, e, ␠, ",", …, 0].
  const durations = [30, 2, 2, 1, 2, 2, 2, 2, 2, 1, 3, 2, 4];
  const frameCount = durations.reduce((sum, value) => sum + value, 0);

  it("feeds ids, the length-indexed style row and the prior-scaled speed, then trims by duration", async () => {
    const { session, run, disposed } = fakeSession(() => ({ waveform: framedWaveform(frameCount, 30, 45), duration: durations }));
    const runtime = new KittenRuntime(session, styleTables(), { speedPriors: { "expr-voice-2-f": 0.8 } }, lowerCasePhonemize);

    const result = await runtime.synthesize("Hi there", "Bella", 1.1);

    const feeds = run.mock.calls[0][0];
    expect(Array.from(feeds.input_ids.data as BigInt64Array, Number)).toEqual([0, 50, 51, 16, 62, 50, 47, 60, 47, 16, 3, 10, 0]);
    expect(feeds.input_ids.dims).toEqual([1, 13]);
    // Style row = len("Hi there,") = 9.
    expect(feeds.style.dims).toEqual([1, 256]);
    expect((feeds.style.data as Float32Array)[0]).toBe(9);
    expect((feeds.speed.data as Float32Array)[0]).toBeCloseTo(0.88);
    expect(feeds.speed.dims).toEqual([1]);

    // Speech is frames 30-44. The cut keeps a 3-frame margin before it (27) but
    // never trims into the leading pad's end; after it, the margin (48) wins
    // over the start of the trailing punctuation and pad tokens (45).
    expect(result.audio.length).toBe((48 - 27) * FRAME);
    expect(result.audio.byteOffset).toBe(0);
    expect(result.audio.buffer.byteLength).toBe(result.audio.byteLength);
    expect(result.audio[0]).toBe(0);
    expect(result.audio[3 * FRAME]).toBe(0.5);
    expect(result.durations).toEqual(durations);
    expect(result.wordTimings).toEqual([
      { start: 0, end: 2, startSec: 3 / 40, endSec: 7 / 40 },
      { start: 3, end: 8, startSec: 8 / 40, endSec: 18 / 40 },
    ]);
    expect(disposed.sort()).toEqual(["duration", "waveform"]);
  });

  it("never trims past the leading pad or into spoken tokens, even when they are quiet", async () => {
    const { session } = fakeSession(() => ({ waveform: framedWaveform(frameCount, 0, 34), duration: durations }));
    const runtime = new KittenRuntime(session, styleTables(), { speedPriors: {} }, lowerCasePhonemize);

    const result = await runtime.synthesize("Hi there", "Bella", 1);

    // Loud from frame 0 keeps the start; quiet "there" still ends at frame 45.
    expect(result.audio.length).toBe(45 * FRAME);
  });

  it("falls back to upstream's fixed 5000-sample trim when durations do not tile the waveform", async () => {
    const { session } = fakeSession(() => ({ waveform: new Float32Array(9000).fill(0.25), duration: [1, 2, 3] }));
    const runtime = new KittenRuntime(session, styleTables(), { speedPriors: {} }, lowerCasePhonemize);

    const result = await runtime.synthesize("Hi there", "Bella", 1);

    expect(result.audio.length).toBe(4000);
    expect(result.wordTimings).toBeUndefined();
  });

  it("uses the default voice for unknown ids and a prior of 1 when none is configured", async () => {
    const { session, run } = fakeSession(() => ({ waveform: framedWaveform(frameCount, 30, 45), duration: durations }));
    const runtime = new KittenRuntime(session, styleTables(), { speedPriors: { "expr-voice-5-m": 0.5 } }, lowerCasePhonemize);

    await runtime.synthesize("Hi there", "af_heart", 1);
    await runtime.synthesize("Hi there", "Leo", 1);

    expect((run.mock.calls[0][0].speed.data as Float32Array)[0]).toBe(1);
    expect((run.mock.calls[1][0].speed.data as Float32Array)[0]).toBe(0.5);
  });

  it("rejects chunks over the graph's token limit before inference", async () => {
    const { session, run } = fakeSession(() => ({ waveform: new Float32Array(0) }));
    const runtime = new KittenRuntime(session, styleTables(), { speedPriors: {} }, lowerCasePhonemize);

    // 300 words plus the appended comma, joined by spaces, plus three markers.
    const error = await runtime.synthesize("a ".repeat(300), "Bella", 1).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ChunkTooLongError);
    expect((error as ChunkTooLongError).tokenCount).toBe(604);
    expect(run).not.toHaveBeenCalled();
  });

  it("returns empty audio without inference when nothing would be spoken", async () => {
    const { session, run } = fakeSession(() => ({ waveform: new Float32Array(0) }));
    const runtime = new KittenRuntime(session, styleTables(), { speedPriors: {} }, lowerCasePhonemize);

    await expect(runtime.synthesize("... !", "Bella", 1)).resolves.toEqual({ audio: new Float32Array(0), durations: [], wordTimings: [] });
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects non-finite audio and still disposes the outputs", async () => {
    const { session, disposed } = fakeSession(() => ({ waveform: Float32Array.of(0, Number.NaN), duration: durations }));
    const runtime = new KittenRuntime(session, styleTables(), { speedPriors: {} }, lowerCasePhonemize);

    await expect(runtime.synthesize("Hi there", "Bella", 1)).rejects.toThrow("non-finite waveform");
    expect(disposed.sort()).toEqual(["duration", "waveform"]);
  });

  it("fails clearly when a voice's style table is missing and releases the session on dispose", async () => {
    const { session } = fakeSession(() => ({ waveform: new Float32Array(0) }));
    const runtime = new KittenRuntime(session, new Map(), { speedPriors: {} }, lowerCasePhonemize);

    await expect(runtime.synthesize("Hi", "Bella", 1)).rejects.toThrow("expr-voice-2-f is not loaded");
    await runtime.dispose();
    expect(session.release).toHaveBeenCalledOnce();
  });
});

describe("kittenWordTimings", () => {
  it("shares a run's exact span by source word length when eSpeak splits words differently", async () => {
    const { phonemizeKeepingPunctuation } = await import("./espeakPhonemizer");
    const text = "I have 42,";
    const phonemized = await phonemizeKeepingPunctuation(text, async (source) => [source.replace("42", "forty two").toLowerCase()]);
    const tokens = tokenizeKittenPhonemes(phonemized.phonemes);
    const durations = tokens.ids.map(() => 2);

    const timings = kittenWordTimings(text, phonemized, tokens, durations, { start: 0, end: durations.length * 2 });

    // The run's phonemes span frames 2-34 ("i" is token 1, the last "o" token 16).
    const at = (fraction: number) => (2 + 32 * fraction) / 40;
    expect(timings.map(({ start, end }) => text.slice(start, end))).toEqual(["I", "have", "42"]);
    expect(timings[0].startSec).toBeCloseTo(at(0));
    expect(timings[0].endSec).toBeCloseTo(at(1 / 7));
    expect(timings[1].endSec).toBeCloseTo(at(5 / 7));
    expect(timings[2].endSec).toBeCloseTo(at(1));
  });

  it("clamps timings into the kept speech range", async () => {
    const { phonemizeKeepingPunctuation } = await import("./espeakPhonemizer");
    const phonemized = await phonemizeKeepingPunctuation("ab cd", lowerCasePhonemize);
    const tokens = tokenizeKittenPhonemes(phonemized.phonemes);
    const durations = tokens.ids.map(() => 4);

    const timings = kittenWordTimings("ab cd", phonemized, tokens, durations, { start: 8, end: 20 });

    expect(timings).toEqual([
      { start: 0, end: 2, startSec: 0, endSec: 4 / 40 },
      { start: 3, end: 5, startSec: 8 / 40, endSec: 12 / 40 },
    ]);
  });
});
