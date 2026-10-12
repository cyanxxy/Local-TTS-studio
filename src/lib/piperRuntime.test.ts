// @vitest-environment node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as ort from "onnxruntime-web";
import { describe, expect, it, vi } from "vitest";
import { loadEspeakPhonemizer, type EspeakPhonemize } from "./espeakPhonemizer";
import {
  chunkPiperText,
  normalizePeak,
  parsePiperConfig,
  phonemesToIds,
  PiperRuntime,
  resolvePiperSpeaker,
  type PiperVoiceConfig,
} from "./piperRuntime";
import type { StyleTtsSession } from "./styleTtsRuntime";

const PHONEMIZER_BUILD_URL = pathToFileURL(resolve("node_modules/phonemizer/dist/phonemizer.js")).href;

function configJson(overrides: Record<string, unknown> = {}) {
  return {
    audio: { sample_rate: 22_050 },
    espeak: { voice: "en-us" },
    inference: { noise_scale: 0.667, length_scale: 1, noise_w: 0.8 },
    phoneme_type: "espeak",
    phoneme_id_map: { _: [0], "^": [1], $: [2], " ": [3], ",": [4], h: [20], ə: [21], l: [22], o: [23], "ʊ": [24, 25] },
    num_speakers: 1,
    speaker_id_map: {},
    ...overrides,
  };
}

function buffer(value: unknown): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify(value)).buffer;
}

function config(overrides: Record<string, unknown> = {}): PiperVoiceConfig {
  return parsePiperConfig(buffer(configJson(overrides)));
}

describe("parsePiperConfig", () => {
  it("reads the audio, scales, speakers and phoneme ids", () => {
    const parsed = config({ num_speakers: 2, speaker_id_map: { alice: 0, bob: 1 } });

    expect(parsed).toMatchObject({ sampleRate: 22_050, espeakVoice: "en-us", noiseScale: 0.667, lengthScale: 1, noiseW: 0.8, numSpeakers: 2 });
    expect(parsed.speakerIds.get("bob")).toBe(1);
    expect(parsed.phonemeIds.get("ʊ")).toEqual([24, 25]);
  });

  it("treats a config without phoneme_type or num_speakers as an eSpeak single-speaker voice", () => {
    const parsed = config({ phoneme_type: undefined, num_speakers: undefined, speaker_id_map: undefined });

    expect(parsed.numSpeakers).toBe(1);
    expect(parsed.speakerIds.size).toBe(0);
  });

  it.each([
    ["not JSON", new TextEncoder().encode("{").buffer, "invalid JSON"],
    ["not an object", buffer([]), "not an object"],
    ["a missing section", buffer({ ...configJson(), inference: undefined }), "missing its audio, espeak or inference section"],
    ["another phoneme type", buffer(configJson({ phoneme_type: "text" })), "does not use eSpeak phonemes"],
    ["a non-English eSpeak voice", buffer(configJson({ espeak: { voice: "de" } })), "other than English"],
    ["no phoneme map", buffer(configJson({ phoneme_id_map: undefined })), "no phoneme_id_map"],
    ["an empty id list", buffer(configJson({ phoneme_id_map: { _: [0], "^": [1], $: [2], a: [] } })), "invalid phoneme_id_map entry"],
    ["a negative id", buffer(configJson({ phoneme_id_map: { _: [0], "^": [1], $: [-2] } })), "invalid phoneme_id_map entry"],
    ["no BOS marker", buffer(configJson({ phoneme_id_map: { _: [0], $: [2] } })), "has no ^ entry"],
    ["a bad sample rate", buffer(configJson({ audio: { sample_rate: 0 } })), "invalid audio.sample_rate"],
    ["a bad noise scale", buffer(configJson({ inference: { noise_scale: "x", length_scale: 1, noise_w: 1 } })), "invalid inference.noise_scale"],
    ["zero speakers", buffer(configJson({ num_speakers: 0 })), "invalid num_speakers"],
    ["a bad speaker id", buffer(configJson({ speaker_id_map: { a: -1 } })), "invalid speaker_id_map entry"],
  ])("rejects %s", (_name, input, message) => {
    expect(() => parsePiperConfig(input)).toThrow(message);
  });
});

describe("phonemesToIds", () => {
  const { phonemeIds } = config();

  it("wraps the phonemes in BOS and EOS with a pad before and after every phoneme", () => {
    expect(phonemesToIds("hə", phonemeIds)).toEqual([1, 0, 20, 0, 21, 0, 2]);
    expect(phonemesToIds("", phonemeIds)).toEqual([1, 0, 2]);
  });

  it("expands phonemes with several ids and drops code points without one", () => {
    expect(phonemesToIds("hʊ?x", phonemeIds)).toEqual([1, 0, 20, 0, 24, 25, 0, 2]);
  });

  it("normalizes to NFD before looking phonemes up", () => {
    const withCombining = new Map([...phonemeIds, ["e", [30]], ["́", [31]]]);

    // "é" (U+00E9) decomposes into "e" and a combining acute accent.
    expect(phonemesToIds("é", withCombining)).toEqual([1, 0, 30, 0, 31, 0, 2]);
  });
});

describe("resolvePiperSpeaker", () => {
  const multi = config({ num_speakers: 3, speaker_id_map: { p1: 0, p2: 2 } });

  it("maps names and numbers to ids and falls back to the first speaker", () => {
    expect(resolvePiperSpeaker(multi, "p2")).toBe(2);
    expect(resolvePiperSpeaker(multi, "1")).toBe(1);
    expect(resolvePiperSpeaker(multi, "3")).toBe(0);
    expect(resolvePiperSpeaker(multi, "nobody")).toBe(0);
    expect(resolvePiperSpeaker(multi, null)).toBe(0);
  });

  it("ignores speakers on single-speaker voices", () => {
    expect(resolvePiperSpeaker(config(), "1")).toBe(0);
  });
});

describe("normalizePeak", () => {
  it("scales the peak to 0.95 like Piper's writers do", () => {
    expect(Array.from(normalizePeak(Float32Array.of(0.1, -0.2, 0.05)))).toEqual([
      expect.closeTo(0.475, 6), expect.closeTo(-0.95, 6), expect.closeTo(0.2375, 6),
    ]);
  });

  it("does not amplify near-silence into noise", () => {
    expect(Math.max(...normalizePeak(Float32Array.of(0.001, -0.002)).map(Math.abs))).toBeCloseTo(0.19, 5);
    expect(normalizePeak(new Float32Array(0))).toHaveLength(0);
  });
});

describe("chunkPiperText", () => {
  it("keeps sentence-sized chunks with exact offsets", () => {
    const text = `${"First sentence goes right here. ".repeat(10)}Last one.`;
    const chunks = chunkPiperText(text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(250);
      expect(text.slice(chunk.start, chunk.end)).toBe(chunk.text);
    }
  });
});

function fakeSession(waveform: Float32Array) {
  const disposed = vi.fn();
  const run = vi.fn(async (feeds: Record<string, ort.Tensor>) => {
    void feeds;
    const output = new ort.Tensor("float32", waveform, [1, 1, 1, waveform.length]);
    vi.spyOn(output, "dispose").mockImplementation(disposed);
    return { output } as ort.InferenceSession.ReturnType;
  });
  const session = { run, release: vi.fn(async () => undefined) } as unknown as StyleTtsSession;
  return { session, run, disposed };
}

/** One "word" per run of letters, one letter per phoneme, like a real phonemizer's shape. */
const letters: EspeakPhonemize = async (text) => [text.toLowerCase().replace(/[^a-zəʊ ]/g, "")];

describe("PiperRuntime", () => {
  it("phonemizes with the voice's eSpeak voice, keeping punctuation in place", async () => {
    const phonemize = vi.fn(letters);
    const runtime = new PiperRuntime(fakeSession(new Float32Array(1)).session, config(), phonemize);

    expect(await runtime.idsFor("hello, hello")).toEqual([1, 0, 20, 0, 22, 0, 22, 0, 23, 0, 4, 0, 3, 0, 20, 0, 22, 0, 22, 0, 23, 0, 2]);
    expect(phonemize.mock.calls.map(([text, language]) => [text, language])).toEqual([["hello", "en-us"], ["hello", "en-us"]]);
  });

  it("runs the graph with the voice's scales divided by speed and normalizes the peak", async () => {
    const { session, run, disposed } = fakeSession(Float32Array.of(0.2, -0.4));
    const runtime = new PiperRuntime(session, config({ inference: { noise_scale: 0.5, length_scale: 1.2, noise_w: 0.7 } }), letters);

    const audio = await runtime.synthesize("hello", 0, 1.2);

    expect(Array.from(audio)).toEqual([expect.closeTo(0.475, 6), expect.closeTo(-0.95, 6)]);
    const feeds = run.mock.calls[0][0];
    expect(Array.from(feeds.scales.data as Float32Array)).toEqual([expect.closeTo(0.5, 6), expect.closeTo(1, 6), expect.closeTo(0.7, 6)]);
    expect(feeds.input.dims).toEqual([1, 11]);
    expect(Array.from(feeds.input_lengths.data as BigInt64Array)).toEqual([11n]);
    expect(feeds).not.toHaveProperty("sid");
    expect(disposed).toHaveBeenCalled();
    expect(runtime.sampleRate).toBe(22_050);
  });

  it("passes the speaker id only to multi-speaker voices", async () => {
    const { session, run } = fakeSession(Float32Array.of(0.5));
    const runtime = new PiperRuntime(session, config({ num_speakers: 4 }), letters);

    await runtime.synthesize("hello", 3, 1);

    expect(Array.from(run.mock.calls[0][0].sid.data as BigInt64Array)).toEqual([3n]);
  });

  it("returns no audio, without running the graph, for text with no known phoneme", async () => {
    const { session, run } = fakeSession(Float32Array.of(0.5));
    const runtime = new PiperRuntime(session, config(), letters);

    expect(await runtime.synthesize("???", 0, 1)).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects non-finite audio and releases its session on dispose", async () => {
    const { session } = fakeSession(Float32Array.of(0.5, Number.NaN));
    const runtime = new PiperRuntime(session, config(), letters);

    await expect(runtime.synthesize("hello", 0, 1)).rejects.toThrow("non-finite");
    await runtime.dispose();
    expect(session.release).toHaveBeenCalledOnce();
  });

  it("produces known phonemes for English text with the shipped eSpeak build", async () => {
    const phonemize = await loadEspeakPhonemizer(PHONEMIZER_BUILD_URL);
    const runtime = new PiperRuntime(fakeSession(new Float32Array(1)).session, config(), phonemize);

    // The tiny test map knows few of eSpeak's phonemes; the front end must still run and keep the comma.
    const ids = await runtime.idsFor("Hello, hello");

    expect(ids[0]).toBe(1);
    expect(ids.at(-1)).toBe(2);
    expect(ids).toContain(4);
  });
});
