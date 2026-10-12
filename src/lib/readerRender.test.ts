import { describe, expect, it } from "vitest";
import type { SynthesisChunk } from "../shared/engineRuntime";
import {
  cachedChunksDurationSec,
  collectSectionChunks,
  estimateSpeechBytes,
  RenderBudgetError,
  sealRenderedChunks,
  toCachedChunk,
} from "./readerRender";

const chunk = (overrides: Partial<SynthesisChunk> = {}): SynthesisChunk => ({
  audio: new Float32Array([0.1, 0.2, 0.3, 0.4]),
  samplingRate: 24_000,
  text: "spoken",
  index: 1,
  total: 0,
  ...overrides,
});

describe("estimateSpeechBytes", () => {
  it("sizes Float32 audio from the characters and the sample rate", () => {
    expect(estimateSpeechBytes(14, 24_000)).toBe(24_000 * 4);
    expect(estimateSpeechBytes(-5, 24_000)).toBe(0);
  });
});

describe("toCachedChunk", () => {
  it("hands over a buffer the chunk owns and copies a window of a larger one", () => {
    const owned = chunk();
    expect(toCachedChunk(owned).audio).toBe(owned.audio.buffer);

    const whole = new Float32Array([1, 2, 3, 4, 5, 6]);
    const windowed = chunk({ audio: whole.subarray(2, 4) });
    const cached = toCachedChunk(windowed);
    expect(cached.audio).not.toBe(whole.buffer);
    expect(Array.from(new Float32Array(cached.audio))).toEqual([3, 4]);
  });

  it("carries the passage's text range and pause", () => {
    expect(toCachedChunk(chunk({ textStart: 3, textEnd: 9, pauseAfterSec: 0.4, pauseKind: "sentence" }))).toMatchObject({
      text: "spoken",
      index: 1,
      textStart: 3,
      textEnd: 9,
      pauseAfterSec: 0.4,
      pauseKind: "sentence",
    });
  });
});

describe("sealRenderedChunks", () => {
  it("fills in the passage count that engines report as 0, and keeps one they reported", () => {
    const cached = [toCachedChunk(chunk()), toCachedChunk(chunk({ index: 2, total: 7 }))];
    expect(sealRenderedChunks(cached).map((entry) => entry.total)).toEqual([2, 7]);
  });
});

describe("cachedChunksDurationSec", () => {
  it("adds up chunks of different sample rates", () => {
    const cached = [
      toCachedChunk(chunk({ audio: new Float32Array(24_000), samplingRate: 24_000 })),
      toCachedChunk(chunk({ audio: new Float32Array(44_100), samplingRate: 44_100 })),
    ];
    expect(cachedChunksDurationSec(cached)).toBeCloseTo(2);
  });
});

async function* stream(chunks: SynthesisChunk[]): AsyncGenerator<SynthesisChunk> {
  for (const entry of chunks) yield entry;
}

describe("collectSectionChunks", () => {
  it("collects a stream into sealed cache chunks", async () => {
    const seen: number[] = [];
    const chunks = await collectSectionChunks(stream([chunk(), chunk({ index: 2 })]), {
      onChunk: (_chunk, bytes) => seen.push(bytes),
    });
    expect(chunks.map((entry) => entry.total)).toEqual([2, 2]);
    expect(seen).toEqual([16, 32]);
  });

  it("stops once the audio outgrows its budget", async () => {
    await expect(collectSectionChunks(stream([chunk(), chunk()]), { maxBytes: 20 })).rejects.toBeInstanceOf(
      RenderBudgetError,
    );
  });

  it("passes on the error that ends the stream", async () => {
    async function* failing(): AsyncGenerator<SynthesisChunk> {
      yield chunk();
      throw new Error("engine fell over");
    }
    await expect(collectSectionChunks(failing())).rejects.toThrow("engine fell over");
  });
});
