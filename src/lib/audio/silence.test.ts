import { describe, expect, it } from "vitest";
import { findSpeechBounds } from "./silence";

const RATE = 1000; // 10 ms frames are 10 samples.

function signal(parts: Array<[length: number, amplitude: number]>): Float32Array {
  const output = new Float32Array(parts.reduce((sum, [length]) => sum + length, 0));
  let offset = 0;
  for (const [length, amplitude] of parts) {
    for (let i = 0; i < length; i += 1) output[offset + i] = i % 2 === 0 ? amplitude : -amplitude;
    offset += length;
  }
  return output;
}

describe("findSpeechBounds", () => {
  it("finds the voiced span on the frame grid", () => {
    expect(findSpeechBounds(signal([[30, 0], [50, 0.5], [40, 0]]), RATE)).toEqual({ start: 30, end: 80 });
  });

  it("returns whole frames around speech that does not align with them", () => {
    expect(findSpeechBounds(signal([[25, 0], [10, 0.5], [25, 0]]), RATE)).toEqual({ start: 20, end: 40 });
  });

  it("returns null for silence, empty ranges and invalid rates", () => {
    expect(findSpeechBounds(new Float32Array(100), RATE)).toBeNull();
    expect(findSpeechBounds(signal([[10, 0.5]]), RATE, {}, 5, 5)).toBeNull();
    expect(findSpeechBounds(signal([[10, 0.5]]), 0)).toBeNull();
  });

  it("treats audio under the threshold as silence", () => {
    const quiet = signal([[20, 0], [20, 0.001], [20, 0.5], [20, 0]]);
    expect(findSpeechBounds(quiet, RATE)).toEqual({ start: 40, end: 60 });
    expect(findSpeechBounds(quiet, RATE, { thresholdDb: -70 })).toEqual({ start: 20, end: 60 });
  });

  it("searches only the requested range and clamps it", () => {
    const audio = signal([[20, 0.5], [40, 0], [20, 0.5]]);
    expect(findSpeechBounds(audio, RATE, {}, 20, 60)).toBeNull();
    expect(findSpeechBounds(audio, RATE, {}, 10, 1000)).toEqual({ start: 10, end: 80 });
    expect(findSpeechBounds(audio, RATE, {}, -5, 15)).toEqual({ start: 0, end: 15 });
  });

  it("supports other frame sizes and a single voiced frame", () => {
    expect(findSpeechBounds(signal([[40, 0], [5, 0.5], [40, 0]]), RATE, { frameMs: 20 })).toEqual({ start: 40, end: 60 });
    expect(findSpeechBounds(signal([[5, 0.5]]), RATE)).toEqual({ start: 0, end: 5 });
  });
});
