// @vitest-environment node

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import * as ort from "onnxruntime-node";
import {
  createSeededRandom,
  decodeFloat16,
  normaliseSpeechText,
  parseVoiceCodes,
  readRuntimeManifest,
  readTrailingValues,
  sampleTokenId,
  startAudio8Worker,
  topKLogitIndices,
  type Audio8WorkerPort,
  type SamplingOptions,
} from "./audio8NativeWorker";
import type { Audio8WorkerResponse } from "./audio8NativeClient";

const NUCLEUS: SamplingOptions = { temperature: 0.3, topP: 0.9, topK: 50 };
const REPEAT_ESCAPE: SamplingOptions = { temperature: 1, topP: 0.9, topK: 50 };

/**
 * Deterministic stand-in for a logits row. The expected token ids below were
 * produced by the reference sampling procedure over this exact row; they are
 * golden values, so a change here is a change in generated audio.
 */
function pseudoLogits(size = 64): Float64Array {
  const logits = new Float64Array(size);
  for (let index = 0; index < size; index += 1) logits[index] = Math.sin(index * 1.7) * 3;
  return logits;
}

function drawMany(count: number, draw: () => number): number[] {
  return Array.from({ length: count }, draw);
}

function encodeNpy(frames: number[][], version: 1 | 2): Uint8Array {
  const rows = frames.length;
  const columns = frames[0].length;
  const header = `{'descr': '<u2', 'fortran_order': False, 'shape': (${rows}, ${columns}), }`;
  const headerStart = version === 1 ? 10 : 12;
  const padded = header.padEnd(header.length + ((64 - (headerStart + header.length) % 64) % 64), " ");
  const buffer = Buffer.alloc(headerStart + padded.length + rows * columns * 2);
  buffer.write("NUMPY", 0, "latin1");
  buffer[6] = version;
  buffer[7] = 0;
  if (version === 1) buffer.writeUInt16LE(padded.length, 8);
  else buffer.writeUInt32LE(padded.length, 8);
  buffer.write(padded, headerStart, "latin1");
  let offset = headerStart + padded.length;
  for (const row of frames) {
    for (const code of row) {
      buffer.writeUInt16LE(code, offset);
      offset += 2;
    }
  }
  // Returned behind a padded slice so a parser that ignores `byteOffset` fails.
  return Buffer.concat([Buffer.alloc(7, 0xff), buffer]).subarray(7);
}

function voiceFrames(columns: number): number[][] {
  return Array.from({ length: 10 }, (_row, book) => (
    Array.from({ length: columns }, (_column, frame) => book * 100 + frame)
  ));
}

describe("decodeFloat16", () => {
  it.each([
    ["zero", 0x0000, 0],
    ["one", 0x3c00, 1],
    ["minus two", 0xc000, -2],
    ["a third", 0x3555, 0.333251953125],
    ["smallest subnormal", 0x0001, 2 ** -24],
    ["infinity", 0x7c00, Infinity],
    ["negative infinity", 0xfc00, -Infinity],
  ])("decodes %s", (_name, bits, expected) => {
    expect(decodeFloat16(bits)).toBe(expected);
  });

  it("decodes a quiet NaN", () => {
    expect(decodeFloat16(0x7e00)).toBeNaN();
  });
});

describe("createSeededRandom", () => {
  it("reproduces the reference stream for the pinned seed", () => {
    expect(drawMany(5, createSeededRandom(42))).toEqual([
      0.6011037519201636,
      0.44829055899754167,
      0.8524657934904099,
      0.6697340414393693,
      0.17481389874592423,
    ]);
  });

  it("gives the same stream to every run of the same seed", () => {
    expect(drawMany(16, createSeededRandom(7))).toEqual(drawMany(16, createSeededRandom(7)));
  });
});

describe("sampleTokenId", () => {
  it("reproduces the reference draws at generation temperature", () => {
    const random = createSeededRandom(42);
    expect(drawMany(8, () => sampleTokenId(pseudoLogits(), NUCLEUS, random)))
      .toEqual([60, 38, 49, 16, 12, 1, 38, 49]);
  });

  it("reproduces the reference draws at the repeat-escape temperature", () => {
    const random = createSeededRandom(42);
    expect(drawMany(8, () => sampleTokenId(pseudoLogits(), REPEAT_ESCAPE, random)))
      .toEqual([60, 16, 56, 16, 12, 1, 38, 20]);
  });

  it("never leaves the top-k candidates", () => {
    const random = createSeededRandom(7);
    const drawn = drawMany(12, () => sampleTokenId(pseudoLogits(), { temperature: 1, topP: 0.99, topK: 4 }, random));

    expect(drawn).toEqual([60, 12, 49, 12, 1, 49, 1, 49, 49, 12, 1, 1]);
    expect(new Set(drawn).size).toBeLessThanOrEqual(4);
    expect([...new Set(drawn)].every((token) => [12, 49, 60, 1].includes(token))).toBe(true);
  });

  it("collapses onto the most likely token as the nucleus narrows", () => {
    const random = createSeededRandom(1);
    const drawn = drawMany(32, () => sampleTokenId(pseudoLogits(), { temperature: 0.01, topP: 0, topK: 50 }, random));

    expect(new Set(drawn)).toEqual(new Set([12]));
  });

  it("ignores NaN logits instead of letting them displace real ones", () => {
    const logits = Float64Array.from([NaN, 1, NaN, 3, 2]);

    expect([...topKLogitIndices(logits, 2)]).toEqual([3, 4]);
    expect(sampleTokenId(logits, { temperature: 0.01, topP: 0, topK: 50 }, createSeededRandom(1))).toBe(3);
  });

  it("refuses a row with nothing to rank rather than returning no token", () => {
    expect(() => sampleTokenId(Float64Array.from([NaN, NaN]), NUCLEUS, createSeededRandom(1)))
      .toThrow("Audio8 sampler received no usable logits.");
  });
});

describe("topKLogitIndices", () => {
  it("ranks largest first and keeps ties in index order", () => {
    const logits = Float64Array.from([2, 5, 5, -1, 5, 2, Infinity, -Infinity]);

    expect([...topKLogitIndices(logits, 5)]).toEqual([6, 1, 2, 4, 0]);
  });

  it("returns the whole row when k exceeds it, and nothing for an empty request", () => {
    const logits = Float64Array.from([0, -Infinity, 1]);

    expect([...topKLogitIndices(logits, 50)]).toEqual([2, 0, 1]);
    expect([...topKLogitIndices(logits, 0)]).toEqual([]);
  });
});

/**
 * The sort-based sampler this file shipped with, kept verbatim as the
 * reference the optimised `sampleTokenId` must reproduce. Every token Audio8
 * has ever generated came from this procedure, so any divergence — a
 * different winner, or a different number of random draws consumed — is a
 * change in generated audio.
 */
function referenceSampleTokenId(
  logits: Float64Array,
  { temperature, topP, topK }: SamplingOptions,
  random: () => number,
): number {
  const ranked = Array.from({ length: logits.length }, (_unused, index) => index)
    .sort((left, right) => logits[right] - logits[left])
    .slice(0, topK);
  const highest = logits[ranked[0]];
  const unscaled = ranked.map((index) => Math.exp(logits[index] - highest));
  const unscaledTotal = unscaled.reduce((total, weight) => total + weight, 0);
  const nucleus: number[] = [];
  let cumulative = 0;
  for (let rank = 0; rank < ranked.length; rank += 1) {
    if (rank && cumulative > topP) break;
    nucleus.push(ranked[rank]);
    cumulative += unscaled[rank] / unscaledTotal;
  }
  const scaledHighest = Math.max(...nucleus.map((index) => logits[index] / temperature));
  const weights = nucleus.map((index) => Math.exp(logits[index] / temperature - scaledHighest));
  const weightTotal = weights.reduce((total, weight) => total + weight, 0);
  let winner = nucleus[0];
  let bestScore = -Infinity;
  for (let candidate = 0; candidate < nucleus.length; candidate += 1) {
    const score = weights[candidate] / weightTotal / -Math.log(Math.max(1e-12, random()));
    if (score > bestScore) {
      bestScore = score;
      winner = nucleus[candidate];
    }
  }
  return winner;
}

/**
 * Logit rows shaped like the real graphs' output: the slow head is 4,097 wide
 * and the fast heads 4,096, values come back through FP16 (so many exact ties),
 * and a masked entry can be -Infinity. The small rows exercise k > length.
 */
function goldenLogitRows(): Float64Array[] {
  const random = createSeededRandom(20_260_710);
  const rows: Float64Array[] = [];
  for (const size of [4097, 4096, 4097, 4096, 512, 64, 50, 7, 1]) {
    for (const shape of ["continuous", "fp16", "coarse", "masked"] as const) {
      const row = new Float64Array(size);
      for (let index = 0; index < size; index += 1) {
        const value = (random() - 0.5) * 24;
        row[index] = shape === "continuous"
          ? value
          : shape === "fp16"
            ? decodeFloat16(encodeFloat16(value))
            : shape === "coarse"
              ? Math.round(value / 4) * 4
              : random() < 0.2 ? -Infinity : value;
      }
      rows.push(row);
    }
  }
  return rows;
}

/**
 * FP16 bit pattern for a finite value in half range, rounding half up and
 * flushing subnormals to zero. Only used to give the golden rows the coarse,
 * tie-heavy grid real FP16 logits land on, so exact IEEE rounding is moot.
 */
function encodeFloat16(value: number): number {
  const buffer = new DataView(new ArrayBuffer(4));
  buffer.setFloat32(0, value);
  const bits = buffer.getUint32(0);
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  const mantissa = bits & 0x7fffff;
  if (exponent <= 0) return sign;
  const rounded = (exponent << 10) + (mantissa >>> 13) + ((mantissa >>> 12) & 1);
  return sign | Math.min(rounded, 0x7bff);
}

describe("sampleTokenId golden equivalence", () => {
  const settings: SamplingOptions[] = [
    NUCLEUS,
    REPEAT_ESCAPE,
    { temperature: 0.1, topP: 0.9, topK: 50 },
    { temperature: 0.3, topP: 1, topK: 4097 },
    { temperature: 0.3, topP: 0, topK: 50 },
    { temperature: 1, topP: 0.5, topK: 1 },
  ];

  it("draws the same tokens and consumes the same randomness as the full-sort reference", () => {
    let draws = 0;
    for (const [rowIndex, logits] of goldenLogitRows().entries()) {
      for (const [settingIndex, options] of settings.entries()) {
        const seed = rowIndex * 31 + settingIndex;
        const expectedStream = createSeededRandom(seed);
        const actualStream = createSeededRandom(seed);
        for (let draw = 0; draw < 4; draw += 1) {
          const expected = referenceSampleTokenId(logits, options, expectedStream);
          expect(sampleTokenId(logits, options, actualStream), `row ${rowIndex}, settings ${settingIndex}, draw ${draw}`)
            .toBe(expected);
          draws += 1;
        }
        // Equal next values prove both consumed exactly as many draws.
        expect(actualStream()).toBe(expectedStream());
      }
    }
    expect(draws).toBe(36 * settings.length * 4);
  });
});

describe("normaliseSpeechText", () => {
  it("collapses whitespace and drops control characters", () => {
    expect(normaliseSpeechText("  Hello\n\tthere\u0000, ​world  ")).toBe("Hello there, world");
  });

  it("keeps punctuation and non-latin scripts", () => {
    expect(normaliseSpeechText("سلام — «Hello»!")).toBe("سلام — «Hello»!");
  });

  it("rejects text that is only whitespace", () => {
    expect(() => normaliseSpeechText("  \n ")).toThrow("Audio8 text is empty.");
  });
});

describe("parseVoiceCodes", () => {
  it.each([1, 2] as const)("reads a v%s uint16 profile", (version) => {
    const frames = voiceFrames(5);

    const parsed = parseVoiceCodes(encodeNpy(frames, version));

    expect(parsed.frames).toBe(5);
    expect([...parsed.codes]).toEqual(frames.flat());
  });

  it("rejects a file that is not a numpy array", () => {
    expect(() => parseVoiceCodes(Buffer.from("not a voice profile at all")))
      .toThrow("Invalid Audio8 voice profile.");
  });

  it("rejects a profile that is not ten codebooks tall", () => {
    const frames = Array.from({ length: 4 }, (_row, book) => [book, book + 1]);

    expect(() => parseVoiceCodes(encodeNpy(frames, 1))).toThrow("Invalid Audio8 voice shape.");
  });
});

describe("readRuntimeManifest", () => {
  it("reads the values the runtime drives the graphs with", () => {
    const manifest = readRuntimeManifest({
      sample_rate: 44100,
      slow_logits_size: 4097,
      codebook_size: 4096,
      max_seq_len: 2048,
      num_layers: 24,
      num_fast_layers: 4,
      num_codebooks: 10,
      n_local_heads: 2,
      fast_n_local_heads: 2,
      head_dim: 64,
      fast_head_dim: 64,
      fast_dim: 896,
      semantic_begin_id: 151678,
      im_end_id: 151645,
    });

    expect(manifest).toMatchObject({ sampleRate: 44100, slowLogitsSize: 4097, semanticBeginId: 151678 });
  });

  it("names the field a truncated manifest is missing", () => {
    expect(() => readRuntimeManifest({ sample_rate: 44100 }))
      .toThrow('Audio8 runtime manifest is missing "slow_logits_size".');
  });

  it("rejects a manifest that is not an object", () => {
    expect(() => readRuntimeManifest("44100")).toThrow("Audio8 runtime manifest is not an object.");
  });
});

class FakePort extends EventEmitter implements Audio8WorkerPort {
  readonly sent: Audio8WorkerResponse[] = [];

  postMessage(value: Audio8WorkerResponse): void {
    this.sent.push(value);
  }

  receive(value: unknown): Promise<void> {
    this.emit("message", value);
    // The handler answers asynchronously; give its rejection path a turn.
    return new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * These requests are all rejected before the runtime is touched, so the port
 * can be driven without a model directory, a network, or an ONNX session.
 */
describe("startAudio8Worker request validation", () => {
  function startWorker(): FakePort {
    const port = new FakePort();
    startAudio8Worker(port, "/nonexistent/audio8/revision");
    return port;
  }

  it("refuses an unknown voice instead of substituting the default", async () => {
    const port = startWorker();

    await port.receive({ type: "generate", requestId: "gen-1", text: "Hello", voice: "nigel" });

    expect(port.sent).toEqual([
      { type: "error", requestId: "gen-1", error: "Unsupported Audio8 voice." },
    ]);
  });

  it("refuses a missing voice", async () => {
    const port = startWorker();

    await port.receive({ type: "generate", requestId: "gen-1", text: "Hello" });

    expect(port.sent[0]).toMatchObject({ error: "Unsupported Audio8 voice." });
  });

  it("refuses empty and oversized text", async () => {
    const port = startWorker();

    await port.receive({ type: "generate", requestId: "gen-1", text: "   ", voice: "clara" });
    await port.receive({ type: "generate", requestId: "gen-2", text: "a".repeat(1001), voice: "clara" });

    expect(port.sent).toEqual([
      { type: "error", requestId: "gen-1", error: "Audio8 synthesis text is empty." },
      { type: "error", requestId: "gen-2", error: "Audio8 synthesis text exceeds 1000 characters." },
    ]);
  });

  it("refuses out-of-range sampling overrides with the IPC boundary's wording", async () => {
    const port = startWorker();

    await port.receive({ type: "generate", requestId: "gen-1", text: "Hello", voice: "clara", seed: -1 });
    await port.receive({ type: "generate", requestId: "gen-2", text: "Hello", voice: "clara", seed: 2 ** 32 });
    await port.receive({ type: "generate", requestId: "gen-3", text: "Hello", voice: "clara", temperature: 0 });
    await port.receive({ type: "generate", requestId: "gen-4", text: "Hello", voice: "clara", temperature: "0.3" });

    expect(port.sent).toEqual([
      { type: "error", requestId: "gen-1", error: "Audio8 seed must be an integer from 0 to 4294967295." },
      { type: "error", requestId: "gen-2", error: "Audio8 seed must be an integer from 0 to 4294967295." },
      { type: "error", requestId: "gen-3", error: "Audio8 temperature must be a number from 0.1 to 1." },
      { type: "error", requestId: "gen-4", error: "Audio8 temperature must be a number from 0.1 to 1." },
    ]);
  });

  it("answers an unsupported request type rather than leaving it pending", async () => {
    const port = startWorker();

    await port.receive({ type: "sing", requestId: "odd-1" });

    expect(port.sent).toEqual([
      { type: "error", requestId: "odd-1", error: 'Unsupported Audio8 request "sing".' },
    ]);
  });

  it("ignores messages it cannot answer and cancels it does not recognise", async () => {
    const port = startWorker();

    await port.receive(null);
    await port.receive({ type: "generate" });
    // A stop that lands after its request finished used to leak an id forever.
    await port.receive({ type: "cancel", requestId: "gen-1" });

    expect(port.sent).toEqual([]);
  });
});

describe("readTrailingValues", () => {
  it("keeps FP16 tensors on Uint16Array under Node 24", () => {
    const tensor = new ort.Tensor("float16", new Uint16Array(262_144), [1, 2, 2048, 64]);

    expect(tensor.data).toBeInstanceOf(Uint16Array);
    expect(tensor.data.byteLength).toBe(524_288);
  });

  it("reads the newest position of a float32 output", () => {
    const tensor = new ort.Tensor("float32", Float32Array.from([1, 2, 3, 4, 5, 6]), [1, 2, 3]);

    expect([...readTrailingValues(tensor, 3)]).toEqual([4, 5, 6]);
  });

  it("decodes an FP16 output rather than reading its bit pattern", () => {
    const tensor = new ort.Tensor("float16", Uint16Array.from([0x3c00, 0xc000, 0x0000]), [1, 1, 3]);

    expect([...readTrailingValues(tensor, 2)]).toEqual([-2, 0]);
  });
});

describe("Audio8 generation completion", () => {
  async function setup(endAfter: number | null, maxSeqLen = 4) {
    const { Audio8Runtime } = await import("./audio8NativeWorker");
    let steps = 0;
    const slow = {
      outputNames: ["logits", "hidden"],
      run: async () => ({
        logits: new ort.Tensor("float32", new Float32Array(endAfter !== null && steps++ >= endAfter ? [-1000, 1000] : [1000, -1000]), [1, 2]),
        hidden: new ort.Tensor("float16", new Uint16Array([0]), [1, 1, 1]),
      }),
    } as unknown as ort.InferenceSession;
    const fast = { outputNames: ["logits"], run: async () => ({ logits: new ort.Tensor("float32", new Float32Array([1]), [1, 1]) }) } as unknown as ort.InferenceSession;
    const decode = vi.fn(async () => ({ audio: new ort.Tensor("float32", new Float32Array([0.25]), [1]) }));
    const decoder = { outputNames: ["audio"], run: decode } as unknown as ort.InferenceSession;
    const runtime = new Audio8Runtime({ sampleRate: 44100, slowLogitsSize: 2, codebookSize: 1, maxSeqLen, numLayers: 0, numFastLayers: 0, numCodebooks: 1, localHeads: 1, fastLocalHeads: 1, headDim: 1, fastHeadDim: 1, fastDim: 1, semanticBeginId: 100, imEndId: 101 }, () => ({ input_ids: [] }), slow, fast, decoder);
    return { runtime, decode, voice: { codes: new Uint16Array([0]), frames: 1, referenceText: "reference" } };
  }

  it("rejects budget exhaustion instead of decoding partial speech", async () => {
    const { runtime, decode, voice } = await setup(null);
    await expect(runtime.synthesize("Hello.", voice)).rejects.toThrow("before end-of-speech");
    expect(decode).not.toHaveBeenCalled();
  });

  it("decodes when the model emits its end token", async () => {
    const { runtime, decode, voice } = await setup(1);
    await expect(runtime.synthesize("Hello.", voice)).resolves.toEqual(new Float32Array([0.25]));
    expect(decode).toHaveBeenCalledOnce();
  });

  it("rejects prompts that leave no generation context", async () => {
    const { runtime, decode, voice } = await setup(null, 1);
    await expect(runtime.synthesize("Hello.", voice)).rejects.toThrow("context window");
    expect(decode).not.toHaveBeenCalled();
  });
});

describe("Audio8 takes", () => {
  const FRAMES = 12;
  const CODEBOOKS = 3;

  /**
   * Drives the real sampling loop over graphs whose logits are close enough
   * together that every draw depends on the random stream, and returns the
   * code matrix handed to the decoder: the take itself.
   */
  async function take(options?: { seed?: number; temperature?: number }): Promise<bigint[]> {
    const { Audio8Runtime } = await import("./audio8NativeWorker");
    let steps = 0;
    const slow = {
      outputNames: ["logits", "hidden"],
      run: async () => ({
        // Four semantic codes, then end-of-speech once FRAMES frames exist.
        logits: new ort.Tensor("float32", Float32Array.from(
          steps++ >= FRAMES ? [-1000, -1000, -1000, -1000, 1000] : [0.4, 0.3, 0.2, 0.1, -1000],
        ), [1, 5]),
        hidden: new ort.Tensor("float16", new Uint16Array([0]), [1, 1, 1]),
      }),
    } as unknown as ort.InferenceSession;
    const fast = {
      outputNames: ["logits"],
      run: async () => ({ logits: new ort.Tensor("float32", Float32Array.from([0.3, 0.2, 0.1, 0]), [1, 4]) }),
    } as unknown as ort.InferenceSession;
    let codes: bigint[] = [];
    const decoder = {
      outputNames: ["audio"],
      run: async ({ codes: input }: { codes: ort.Tensor }) => {
        codes = [...(input.data as BigInt64Array)];
        return { audio: new ort.Tensor("float32", new Float32Array([0.25]), [1]) };
      },
    } as unknown as ort.InferenceSession;
    const runtime = new Audio8Runtime({ sampleRate: 44100, slowLogitsSize: 5, codebookSize: 4, maxSeqLen: 64, numLayers: 0, numFastLayers: 0, numCodebooks: CODEBOOKS, localHeads: 1, fastLocalHeads: 1, headDim: 1, fastHeadDim: 1, fastDim: 1, semanticBeginId: 100, imEndId: 104 }, () => ({ input_ids: [] }), slow, fast, decoder);
    await runtime.synthesize("Hello there.", { codes: new Uint16Array(10), frames: 1, referenceText: "reference" }, options);
    expect(codes).toHaveLength(FRAMES * CODEBOOKS);
    return codes;
  }

  it("keeps the reference take when the defaults are spelled out", async () => {
    const reference = await take();

    expect(await take({ seed: 42, temperature: 0.3 })).toEqual(reference);
    expect(await take({ seed: undefined, temperature: undefined })).toEqual(reference);
  });

  it("repeats a take for the same seed and changes it for another", async () => {
    const pinned = await take({ seed: 7 });

    expect(await take({ seed: 7 })).toEqual(pinned);
    expect(await take({ seed: 8 })).not.toEqual(pinned);
    expect(await take()).not.toEqual(pinned);
  });

  it("samples the nucleus at the requested temperature", async () => {
    expect(await take({ seed: 7, temperature: 1 })).not.toEqual(await take({ seed: 7 }));
  });
});
