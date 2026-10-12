import { describe, expect, it } from "vitest";
import type { LocalTtsAudioChunkEvent, LocalTtsAudioGapEvent } from "../electron";
import { createLocalAudioAssembler, isPlayableAudioChunk, type AssembledAudio } from "./localTtsStream";

function chunk(index: number, overrides: Partial<LocalTtsAudioChunkEvent> = {}, samples = [0.5, 0.25]): LocalTtsAudioChunkEvent {
  const audio = new Float32Array(samples);
  return {
    requestId: "r1",
    model: "qwen3",
    index,
    total: 0,
    sampleRate: 24_000,
    sampleCount: audio.length,
    silenceAfterSamples: 0,
    audio: audio.buffer,
    ...overrides,
  };
}

function gap(afterChunkIndex: number, overrides: Partial<LocalTtsAudioGapEvent> = {}): LocalTtsAudioGapEvent {
  return {
    kind: "gap",
    requestId: "r1",
    model: "qwen3",
    afterChunkIndex,
    sampleRate: 24_000,
    silenceSamples: 4_800,
    textUnitIndex: 0,
    textUnitTotal: 2,
    ...overrides,
  };
}

function setup() {
  const parts: AssembledAudio[] = [];
  const assembler = createLocalAudioAssembler((part) => parts.push(part));
  return { parts, assembler };
}

describe("createLocalAudioAssembler", () => {
  it("releases chunks in index order once the earlier ones have arrived", () => {
    const { parts, assembler } = setup();
    assembler.accept(chunk(1));
    assembler.accept(chunk(2));
    expect(parts).toHaveLength(0);
    assembler.accept(chunk(0));
    expect(parts.map((part) => part.chunkIndex)).toEqual([0, 1, 2]);
    expect(assembler.receivedCount).toBe(3);
  });

  it("ignores a duplicate chunk and a malformed one", () => {
    const { parts, assembler } = setup();
    assembler.accept(chunk(0));
    assembler.accept(chunk(0));
    assembler.accept(chunk(1, { sampleCount: 0 }));
    assembler.accept(chunk(1, { sampleCount: 5 }));
    expect(parts).toHaveLength(1);
    expect(isPlayableAudioChunk(chunk(0))).toBe(true);
    expect(isPlayableAudioChunk(chunk(0, { sampleCount: 3 }))).toBe(false);
  });

  it("zeroes non-finite samples and appends silence a chunk declares itself", () => {
    const { parts, assembler } = setup();
    assembler.accept(chunk(0, { silenceAfterSamples: 2 }, [0.5, Number.NaN, Number.POSITIVE_INFINITY]));
    expect(Array.from(parts[0].samples)).toEqual([0.5, 0, 0, 0, 0]);
    expect(parts[0].pauseAfterSec).toBeCloseTo(2 / 24_000);
  });

  it("carries the text unit and the declared total of a chunk", () => {
    const { parts, assembler } = setup();
    assembler.accept(chunk(0, { total: 4, textUnitIndex: 1, textUnitTotal: 3 }));
    expect(parts[0]).toMatchObject({ kind: "audio", declaredTotal: 4, textUnitIndex: 1, textUnitTotal: 3, pauseAfterSec: 0 });
  });

  it("puts a gap right after the chunk it follows, as silence with the unit's pause", () => {
    const { parts, assembler } = setup();
    assembler.accept(chunk(0, { textUnitIndex: 0, textUnitTotal: 2 }));
    assembler.accept(gap(0));
    assembler.accept(chunk(1, { textUnitIndex: 1, textUnitTotal: 2 }));
    expect(parts.map((part) => [part.kind, part.chunkIndex])).toEqual([["audio", 0], ["gap", 0], ["audio", 1]]);
    expect(parts[1].samples).toHaveLength(4_800);
    expect(parts[1].samples.every((sample) => sample === 0)).toBe(true);
    expect(parts[1]).toMatchObject({ sampleRate: 24_000, textUnitIndex: 0, textUnitTotal: 2 });
    expect(parts[1].pauseAfterSec).toBeCloseTo(0.2);
    // Gaps are not chunks.
    expect(assembler.receivedCount).toBe(2);
  });

  it("holds a gap that outruns its chunk and keeps it in position", () => {
    const { parts, assembler } = setup();
    assembler.accept(chunk(1, { textUnitIndex: 1, textUnitTotal: 2 }));
    assembler.accept(gap(0));
    expect(parts).toHaveLength(0);
    assembler.accept(chunk(0, { textUnitIndex: 0, textUnitTotal: 2 }));
    expect(parts.map((part) => [part.kind, part.chunkIndex])).toEqual([["audio", 0], ["gap", 0], ["audio", 1]]);
  });

  it("gives a gap the declared total of the chunks before it", () => {
    const { parts, assembler } = setup();
    assembler.accept(chunk(0, { total: 3 }));
    assembler.accept(gap(0));
    expect(parts[1].declaredTotal).toBe(3);
  });

  it("drops a gap with no silence, a bad rate or another sample rate", () => {
    const { parts, assembler } = setup();
    assembler.accept(chunk(0));
    assembler.accept(gap(0, { silenceSamples: 0 }));
    assembler.accept(gap(0, { sampleRate: 0 }));
    assembler.accept(gap(0, { sampleRate: 48_000 }));
    expect(parts).toHaveLength(1);
  });

  it("starts over when the sample rate changes or on reset", () => {
    const { parts, assembler } = setup();
    assembler.accept(chunk(0));
    assembler.accept(chunk(0, { sampleRate: 48_000 }));
    expect(parts.map((part) => part.sampleRate)).toEqual([24_000, 48_000]);
    assembler.reset();
    expect(assembler.receivedCount).toBe(0);
    assembler.accept(chunk(0));
    expect(parts).toHaveLength(3);
  });
});
