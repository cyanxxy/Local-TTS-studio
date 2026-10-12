import { describe, expect, it } from "vitest";
import { mean, median, summarizeIterations, type IterationResult } from "./inferenceSpeedSummary";

function iteration(overrides: Partial<IterationResult> = {}): IterationResult {
  return {
    iteration: 1,
    warmup: false,
    generationMs: 1000,
    firstChunkMs: 200,
    chunks: 2,
    audioSeconds: 4,
    charsPerSec: 100,
    rtf: 0.25,
    ...overrides,
  };
}

describe("mean and median", () => {
  it("computes the mean", () => {
    expect(mean([1, 2, 6])).toBe(3);
  });

  it("takes the middle value of an odd-length list without mutating it", () => {
    const values = [9, 1, 5];
    expect(median(values)).toBe(5);
    expect(values).toEqual([9, 1, 5]);
  });

  it("averages the two middle values of an even-length list", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe("summarizeIterations", () => {
  it("returns null when there are no measured iterations", () => {
    expect(summarizeIterations([])).toBeNull();
    expect(summarizeIterations([iteration({ warmup: true })])).toBeNull();
  });

  it("summarizes only measured iterations", () => {
    const summary = summarizeIterations([
      iteration({ warmup: true, generationMs: 9000, firstChunkMs: 5000, charsPerSec: 1, rtf: 9 }),
      iteration({ iteration: 2, generationMs: 1000, firstChunkMs: 300, charsPerSec: 100, rtf: 0.2 }),
      iteration({ iteration: 3, generationMs: 3000, firstChunkMs: 100, charsPerSec: 50, rtf: 0.6 }),
      iteration({ iteration: 4, generationMs: 1400, firstChunkMs: 200, charsPerSec: 90, rtf: 0.4 }),
    ]);

    expect(summary).toEqual({
      meanGenerationMs: 1800,
      medianGenerationMs: 1400,
      bestGenerationMs: 1000,
      meanFirstChunkMs: 200,
      medianFirstChunkMs: 200,
      bestFirstChunkMs: 100,
      meanCharsPerSec: 80,
      meanRtf: expect.closeTo(0.4, 10),
    });
  });

  it("leaves iterations without audio out of first-chunk and RTF statistics", () => {
    const summary = summarizeIterations([
      iteration({ firstChunkMs: null, rtf: null, audioSeconds: 0, chunks: 0 }),
      iteration({ iteration: 2, firstChunkMs: 400, rtf: 0.5 }),
    ]);

    expect(summary).toMatchObject({
      meanFirstChunkMs: 400,
      medianFirstChunkMs: 400,
      bestFirstChunkMs: 400,
      meanRtf: 0.5,
    });
  });

  it("reports null first-chunk and RTF statistics when no iteration produced audio", () => {
    expect(summarizeIterations([iteration({ firstChunkMs: null, rtf: null })])).toMatchObject({
      meanGenerationMs: 1000,
      meanFirstChunkMs: null,
      medianFirstChunkMs: null,
      bestFirstChunkMs: null,
      meanRtf: null,
    });
  });
});
