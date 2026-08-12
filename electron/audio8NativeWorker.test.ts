// @vitest-environment node

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
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
