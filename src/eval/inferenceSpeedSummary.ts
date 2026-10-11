/** One GENERATE round trip, timed from postMessage to GENERATION_COMPLETE. */
export interface IterationResult {
  iteration: number;
  warmup: boolean;
  generationMs: number;
  /** Time to the first AUDIO_CHUNK, or null when no audio arrived. */
  firstChunkMs: number | null;
  chunks: number;
  audioSeconds: number;
  charsPerSec: number;
  /** Generation seconds per audio second, or null when no audio arrived. */
  rtf: number | null;
}

export interface IterationSummary {
  meanGenerationMs: number;
  medianGenerationMs: number;
  bestGenerationMs: number;
  meanFirstChunkMs: number | null;
  medianFirstChunkMs: number | null;
  bestFirstChunkMs: number | null;
  meanCharsPerSec: number;
  meanRtf: number | null;
}

/** Arithmetic mean; NaN for an empty list, which callers guard against. */
export function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Median that averages the two middle values of an even-length list. */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function present(values: readonly (number | null)[]): number[] {
  return values.filter((value): value is number => value !== null);
}

/**
 * Summary statistics over the measured (non-warm-up) iterations, or null when
 * every iteration was a warm-up. Iterations without audio are left out of the
 * first-chunk and RTF statistics instead of being counted as zero.
 */
export function summarizeIterations(iterations: readonly IterationResult[]): IterationSummary | null {
  const measured = iterations.filter((iteration) => !iteration.warmup);
  if (measured.length === 0) return null;

  const generationMs = measured.map((iteration) => iteration.generationMs);
  const firstChunkMs = present(measured.map((iteration) => iteration.firstChunkMs));
  const rtf = present(measured.map((iteration) => iteration.rtf));
  const hasFirstChunk = firstChunkMs.length > 0;

  return {
    meanGenerationMs: mean(generationMs),
    medianGenerationMs: median(generationMs),
    bestGenerationMs: Math.min(...generationMs),
    meanFirstChunkMs: hasFirstChunk ? mean(firstChunkMs) : null,
    medianFirstChunkMs: hasFirstChunk ? median(firstChunkMs) : null,
    bestFirstChunkMs: hasFirstChunk ? Math.min(...firstChunkMs) : null,
    meanCharsPerSec: mean(measured.map((iteration) => iteration.charsPerSec)),
    meanRtf: rtf.length > 0 ? mean(rtf) : null,
  };
}
