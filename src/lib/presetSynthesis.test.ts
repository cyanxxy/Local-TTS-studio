import { describe, expect, it } from "vitest";
import { collectSynthesizedAudio, type SynthesizedAudioChunk } from "./presetSynthesis";

async function* chunks(...items: SynthesizedAudioChunk[]): AsyncGenerator<SynthesizedAudioChunk> {
  for (const item of items) yield item;
}

describe("collectSynthesizedAudio", () => {
  it("joins chunks at the first rate, skips empty chunks and times the first audio", async () => {
    const times = [100, 112.5];
    const collected = await collectSynthesizedAudio(chunks(
      { audio: new Float32Array(0), samplingRate: 16000 },
      { audio: new Float32Array([0.1, 0.2]), samplingRate: 10 },
      { audio: new Float32Array(4).fill(0.3), samplingRate: 20 },
    ), new AbortController().signal, () => times.shift() ?? 0);
    expect(collected.sampleRate).toBe(10);
    expect(collected.samples).toHaveLength(4);
    expect(Array.from(collected.samples.slice(0, 2))).toEqual([Math.fround(0.1), Math.fround(0.2)]);
    expect(collected.samples[3]).toBeCloseTo(0.3, 5);
    expect(collected.firstAudioMs).toBe(12.5);
  });

  it("uses performance.now by default", async () => {
    const collected = await collectSynthesizedAudio(chunks({ audio: new Float32Array([0.5]), samplingRate: 24000 }), new AbortController().signal);
    expect(collected.firstAudioMs).toBeGreaterThanOrEqual(0);
  });

  it("rejects invalid rates, empty streams and aborts", async () => {
    const signal = new AbortController().signal;
    await expect(collectSynthesizedAudio(chunks({ audio: new Float32Array(1), samplingRate: 0 }), signal)).rejects.toThrow(/invalid sample rate/);
    await expect(collectSynthesizedAudio(chunks({ audio: new Float32Array(0), samplingRate: 24000 }), signal)).rejects.toThrow(/no audio/);

    const aborted = new AbortController();
    aborted.abort();
    await expect(collectSynthesizedAudio(chunks(), aborted.signal)).rejects.toMatchObject({ name: "AbortError" });

    const midway = new AbortController();
    async function* abortAfterFirst(): AsyncGenerator<SynthesizedAudioChunk> {
      yield { audio: new Float32Array(1), samplingRate: 24000 };
      midway.abort();
      yield { audio: new Float32Array(1), samplingRate: 24000 };
    }
    await expect(collectSynthesizedAudio(abortAfterFirst(), midway.signal)).rejects.toMatchObject({ name: "AbortError" });

    const atEnd = new AbortController();
    async function* abortAtEnd(): AsyncGenerator<SynthesizedAudioChunk> {
      yield { audio: new Float32Array(1), samplingRate: 24000 };
      atEnd.abort();
    }
    await expect(collectSynthesizedAudio(abortAtEnd(), atEnd.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
