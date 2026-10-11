/**
 * Streaming loudness measurement for mono audio: ITU-R BS.1770-4 integrated
 * loudness (LUFS), EBU Tech 3342 loudness range (LU), 4x-oversampled true
 * peak (dBTP), sample peak and RMS (dBFS).
 *
 * Feed chunks of any size to `LoudnessMeter.process()`; filter state carries
 * across calls, so the result equals measuring the whole signal at once.
 */
import { PolyphaseResampler } from "./resample";

/** Mono gain offset of BS.1770: a full-scale 997 Hz sine reads -3.01 LUFS. */
const LOUDNESS_OFFSET_DB = -0.691;
const ABSOLUTE_GATE_LUFS = -70;
const INTEGRATED_RELATIVE_GATE_LU = -10;
const RANGE_RELATIVE_GATE_LU = -20;
const SUB_BLOCK_SEC = 0.1;
/** Momentary blocks are 400 ms (4 sub-blocks, 75% overlap); short-term blocks are 3 s. */
const MOMENTARY_SUB_BLOCKS = 4;
const SHORT_TERM_SUB_BLOCKS = 30;
const TRUE_PEAK_OVERSAMPLING = 4;
/** Short interpolation filter for peak detection (12 taps per phase, as BS.1770 Annex 2 suggests). */
export const TRUE_PEAK_FILTER = { halfWidth: 6, rolloff: 0.9, beta: 6 } as const;

export function gainToDb(gain: number): number {
  return gain > 0 ? 20 * Math.log10(gain) : Number.NEGATIVE_INFINITY;
}

export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

function energyToLufs(energy: number): number {
  return energy > 0 ? LOUDNESS_OFFSET_DB + 10 * Math.log10(energy) : Number.NEGATIVE_INFINITY;
}

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * BS.1770 K-weighting at any sample rate: the analog prototypes of the
 * standard's 48 kHz filters (as derived for libebur128), discretized with the
 * bilinear transform. At 48 kHz this reproduces the published coefficients.
 */
export function kWeightingCoefficients(sampleRate: number): [Biquad, Biquad] {
  const shelfK = Math.tan((Math.PI * 1681.974450955533) / sampleRate);
  const shelfQ = 0.7071752369554196;
  const highGain = 10 ** (3.999843853973347 / 20);
  const bandGain = highGain ** 0.4996667741545416;
  const shelfA0 = 1 + shelfK / shelfQ + shelfK * shelfK;
  const shelf: Biquad = {
    b0: (highGain + (bandGain * shelfK) / shelfQ + shelfK * shelfK) / shelfA0,
    b1: (2 * (shelfK * shelfK - highGain)) / shelfA0,
    b2: (highGain - (bandGain * shelfK) / shelfQ + shelfK * shelfK) / shelfA0,
    a1: (2 * (shelfK * shelfK - 1)) / shelfA0,
    a2: (1 - shelfK / shelfQ + shelfK * shelfK) / shelfA0,
  };
  const passK = Math.tan((Math.PI * 38.13547087602444) / sampleRate);
  const passQ = 0.5003270373238773;
  const passA0 = 1 + passK / passQ + passK * passK;
  const highPass: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (passK * passK - 1)) / passA0,
    a2: (1 - passK / passQ + passK * passK) / passA0,
  };
  return [shelf, highPass];
}

/** Oversampled peak of each input sample period, streamed. */
export class TruePeakDetector {
  private readonly oversampler: PolyphaseResampler;
  /** Absolute input samples whose oversampled values have not all arrived yet. */
  private pendingInput = new Float32Array(0);
  private partialPeak = 0;
  private partialCount = 0;

  constructor(sampleRate: number) {
    this.oversampler = new PolyphaseResampler(sampleRate, sampleRate * TRUE_PEAK_OVERSAMPLING, TRUE_PEAK_FILTER);
  }

  /** Returns the peaks of the input samples that are now complete, in order. */
  process(input: Float32Array): Float32Array {
    const pending = new Float32Array(this.pendingInput.length + input.length);
    pending.set(this.pendingInput);
    for (let index = 0; index < input.length; index += 1) pending[this.pendingInput.length + index] = Math.abs(input[index]);
    this.pendingInput = pending;
    return this.collect(this.oversampler.process(input));
  }

  flush(): Float32Array {
    return this.collect(this.oversampler.flush());
  }

  private collect(oversampled: Float32Array): Float32Array {
    const peaks = new Float32Array(Math.floor((this.partialCount + oversampled.length) / TRUE_PEAK_OVERSAMPLING));
    let count = 0;
    for (let index = 0; index < oversampled.length; index += 1) {
      this.partialPeak = Math.max(this.partialPeak, Math.abs(oversampled[index]));
      this.partialCount += 1;
      if (this.partialCount === TRUE_PEAK_OVERSAMPLING) {
        peaks[count] = Math.max(this.partialPeak, this.pendingInput[count]);
        count += 1;
        this.partialPeak = 0;
        this.partialCount = 0;
      }
    }
    this.pendingInput = this.pendingInput.subarray(count);
    return peaks;
  }
}

export interface LoudnessReport {
  /** Gated integrated loudness, or -Infinity for silence. */
  integratedLufs: number;
  /** Loudness range in LU (0 when there is too little audio to measure it). */
  loudnessRangeLu: number;
  truePeakDbtp: number;
  samplePeakDbfs: number;
  /** Unweighted RMS level of the whole signal. */
  rmsDbfs: number;
  durationSec: number;
}

function percentile(sorted: readonly number[], fraction: number): number {
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export class LoudnessMeter {
  readonly sampleRate: number;
  private readonly filters: [Biquad, Biquad];
  /** Biquad state: [x1, x2, y1, y2] per stage. */
  private readonly state = new Float64Array(8);
  private readonly subBlockSize: number;
  private readonly subBlockEnergies: number[] = [];
  private subBlockSum = 0;
  private subBlockFill = 0;
  /** K-weighted energy of everything, for signals shorter than one block. */
  private totalWeightedSum = 0;
  private squareSum = 0;
  private samplePeak = 0;
  private truePeak = 0;
  private sampleCount = 0;
  private readonly peakDetector: TruePeakDetector;
  private finished = false;

  constructor(sampleRate: number) {
    if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
      throw new RangeError(`Sample rate must be a positive integer; got ${sampleRate}.`);
    }
    this.sampleRate = sampleRate;
    this.filters = kWeightingCoefficients(sampleRate);
    this.subBlockSize = Math.max(1, Math.round(sampleRate * SUB_BLOCK_SEC));
    this.peakDetector = new TruePeakDetector(sampleRate);
  }

  process(input: Float32Array): void {
    if (this.finished) throw new Error("LoudnessMeter cannot accept more input after result().");
    const [shelf, highPass] = this.filters;
    const state = this.state;
    let [sx1, sx2, sy1, sy2, hx1, hx2, hy1, hy2] = state;
    for (let index = 0; index < input.length; index += 1) {
      const x = input[index];
      const shelfOut = shelf.b0 * x + shelf.b1 * sx1 + shelf.b2 * sx2 - shelf.a1 * sy1 - shelf.a2 * sy2;
      sx2 = sx1;
      sx1 = x;
      sy2 = sy1;
      sy1 = shelfOut;
      const weighted = highPass.b0 * shelfOut + highPass.b1 * hx1 + highPass.b2 * hx2 - highPass.a1 * hy1 - highPass.a2 * hy2;
      hx2 = hx1;
      hx1 = shelfOut;
      hy2 = hy1;
      hy1 = weighted;

      const weightedSquare = weighted * weighted;
      this.subBlockSum += weightedSquare;
      this.totalWeightedSum += weightedSquare;
      this.subBlockFill += 1;
      if (this.subBlockFill === this.subBlockSize) {
        this.subBlockEnergies.push(this.subBlockSum / this.subBlockSize);
        this.subBlockSum = 0;
        this.subBlockFill = 0;
      }
      this.squareSum += x * x;
      const magnitude = Math.abs(x);
      if (magnitude > this.samplePeak) this.samplePeak = magnitude;
    }
    state.set([sx1, sx2, sy1, sy2, hx1, hx2, hy1, hy2]);
    this.sampleCount += input.length;
    this.trackTruePeak(this.peakDetector.process(input));
  }

  /** Finishes the measurement; the meter cannot take more input afterwards. */
  result(): LoudnessReport {
    if (!this.finished) {
      this.finished = true;
      this.trackTruePeak(this.peakDetector.flush());
    }
    return {
      integratedLufs: this.integratedLoudness(),
      loudnessRangeLu: this.loudnessRange(),
      truePeakDbtp: gainToDb(this.truePeak),
      samplePeakDbfs: gainToDb(this.samplePeak),
      rmsDbfs: this.sampleCount > 0 ? 10 * Math.log10(this.squareSum / this.sampleCount) : Number.NEGATIVE_INFINITY,
      durationSec: this.sampleCount / this.sampleRate,
    };
  }

  private trackTruePeak(peaks: Float32Array): void {
    for (let index = 0; index < peaks.length; index += 1) {
      if (peaks[index] > this.truePeak) this.truePeak = peaks[index];
    }
  }

  /** Mean energy of each window of `length` sub-blocks, one window per sub-block. */
  private windowEnergies(length: number): number[] {
    const energies: number[] = [];
    let sum = 0;
    for (let index = 0; index < this.subBlockEnergies.length; index += 1) {
      sum += this.subBlockEnergies[index];
      if (index >= length) sum -= this.subBlockEnergies[index - length];
      if (index >= length - 1) energies.push(Math.max(0, sum) / length);
    }
    return energies;
  }

  private integratedLoudness(): number {
    const blocks = this.windowEnergies(MOMENTARY_SUB_BLOCKS);
    // Shorter than one 400 ms block: measure it as a single block.
    if (blocks.length === 0 && this.sampleCount > 0) blocks.push(this.totalWeightedSum / this.sampleCount);
    const absolute = blocks.filter((energy) => energyToLufs(energy) > ABSOLUTE_GATE_LUFS);
    if (absolute.length === 0) return Number.NEGATIVE_INFINITY;
    const relativeGate = energyToLufs(absolute.reduce((sum, energy) => sum + energy, 0) / absolute.length)
      + INTEGRATED_RELATIVE_GATE_LU;
    const gated = absolute.filter((energy) => energyToLufs(energy) > relativeGate);
    return energyToLufs(gated.reduce((sum, energy) => sum + energy, 0) / gated.length);
  }

  private loudnessRange(): number {
    const absolute = this.windowEnergies(SHORT_TERM_SUB_BLOCKS).filter((energy) => energyToLufs(energy) > ABSOLUTE_GATE_LUFS);
    if (absolute.length < 2) return 0;
    const relativeGate = energyToLufs(absolute.reduce((sum, energy) => sum + energy, 0) / absolute.length)
      + RANGE_RELATIVE_GATE_LU;
    const levels = absolute.map(energyToLufs).filter((level) => level > relativeGate).sort((a, b) => a - b);
    return percentile(levels, 0.95) - percentile(levels, 0.1);
  }
}

/** Measures a whole signal at once. */
export function measureLoudness(audio: Float32Array, sampleRate: number): LoudnessReport {
  const meter = new LoudnessMeter(sampleRate);
  meter.process(audio);
  return meter.result();
}
