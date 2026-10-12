/**
 * Look-ahead true-peak limiter for mono audio.
 *
 * For every sample the detector supplies the 4x-oversampled peak of its
 * period, and the gain needed to keep it under the ceiling. The gain curve is
 * the running minimum of that requirement over the look-ahead window, released
 * exponentially, then smoothed by a moving average as long as the window.
 * Because every value averaged at sample n is a minimum over a window that
 * contains n, the smoothed gain never exceeds what sample n needs, so peaks
 * stay under the ceiling while the gain only ever moves gradually.
 *
 * That argument holds for whatever the detector reports, and a 4x estimate
 * (BS.1770's) can sit below the real continuous peak for wideband material:
 * white noise at twice full scale measured +0.63 dBTP against a -1 dB ceiling.
 * So `TruePeakLimiter` runs a second, 8x stage on the first stage's output
 * as a safety pass. It only trims the small remainder (and is skipped where
 * the signal provably stays under the ceiling), which keeps the measured true
 * peak at the ceiling even for noise-like input.
 *
 * Output is aligned with input (no added delay in the result) and streamed:
 * `process()` returns whatever is final so far and `flush()` returns the rest.
 */
import { TruePeakDetector, dbToGain } from "./loudness";
import type { PolyphaseFilterOptions } from "./resample";

export interface LimiterOptions {
  /** Maximum true peak in dBTP. */
  ceilingDb: number;
  lookaheadMs?: number;
  releaseMs?: number;
}

interface StageOptions extends LimiterOptions {
  /** Interpolation factor of the peak detector (4 by default). */
  oversampling?: number;
  filter?: PolyphaseFilterOptions;
  /** Most extra trim, below the ceiling, applied to a peak that exceeds it. */
  marginDb?: number;
}

/** The safety stage looks for peaks this much finer than the first stage... */
const SAFETY_OVERSAMPLING = 8;
/**
 * ...through a long, flat interpolator, so content near Nyquist is
 * reconstructed about as an ideal sinc would, and trims to this margin below
 * the ceiling because no finite filter matches an ideal reconstruction exactly.
 */
const SAFETY_FILTER = { halfWidth: 32, rolloff: 1, beta: 4 } as const;
const SAFETY_MARGIN_DB = 0.3;

const DEFAULT_LOOKAHEAD_MS = 5;
const DEFAULT_RELEASE_MS = 80;

/** Growable FIFO of samples addressed by absolute index. */
class SampleQueue {
  private buffer = new Float64Array(1024);
  private head = 0;
  private length = 0;
  /** Absolute index of the oldest stored sample. */
  start = 0;

  get end(): number {
    return this.start + this.length;
  }

  push(value: number): void {
    if (this.head + this.length === this.buffer.length) {
      const capacity = this.length * 2 > this.buffer.length ? this.buffer.length * 2 : this.buffer.length;
      const next = new Float64Array(capacity);
      next.set(this.buffer.subarray(this.head, this.head + this.length));
      this.buffer = next;
      this.head = 0;
    }
    this.buffer[this.head + this.length] = value;
    this.length += 1;
  }

  at(index: number): number {
    return this.buffer[this.head + index - this.start];
  }

  /** Forgets samples before `index`. */
  dropBefore(index: number): void {
    const count = Math.min(this.length, Math.max(0, index - this.start));
    this.head += count;
    this.length -= count;
    this.start += count;
  }
}

class LimiterStage {
  private readonly ceiling: number;
  private readonly marginDb: number;
  private readonly window: number;
  private readonly releaseCoefficient: number;
  private readonly detector: TruePeakDetector;
  /** Input samples not yet output, by real index. */
  private readonly input = new SampleQueue();
  /** Required gain by virtual index (real index + window). */
  private readonly required = new SampleQueue();
  /**
   * Virtual indices whose required gains increase from front to back: the
   * classic sliding-window minimum, stored as a ring of `window + 1` slots.
   */
  private readonly minimumIndices: Int32Array;
  private minimumHead = 0;
  private minimumLength = 0;
  /** Released gains of the last `window` virtual indices, for the moving average. */
  private readonly released: Float64Array;
  private releasedSum: number;
  private lastReleased = 1;
  /** Next virtual index whose window minimum is computed. */
  private nextMinimum = 0;
  private finished = false;
  private reduction = 1;
  private lastOutput = 0;

  constructor(sampleRate: number, options: StageOptions) {
    this.ceiling = dbToGain(options.ceilingDb);
    this.marginDb = options.marginDb ?? 0;
    this.window = Math.max(1, Math.round((sampleRate * (options.lookaheadMs ?? DEFAULT_LOOKAHEAD_MS)) / 1000));
    this.releaseCoefficient = 1 - Math.exp(-1000 / (sampleRate * (options.releaseMs ?? DEFAULT_RELEASE_MS)));
    this.detector = new TruePeakDetector(
      sampleRate,
      { oversampling: options.oversampling, filter: options.filter, ignoreBelow: this.ceiling },
    );
    this.minimumIndices = new Int32Array(this.window + 1);
    this.released = new Float64Array(this.window).fill(1);
    this.releasedSum = this.window;
    // Virtual silence before the signal lets the gain fall ahead of an opening peak.
    for (let index = 0; index < this.window; index += 1) this.pushRequired(1);
  }

  /** Lowest gain applied so far (1 = never limited). */
  get maxReductionDb(): number {
    return Math.max(0, -20 * Math.log10(this.reduction));
  }

  process(samples: Float32Array): Float32Array {
    if (this.finished) throw new Error("TruePeakLimiter cannot accept more input after flush().");
    for (let index = 0; index < samples.length; index += 1) this.input.push(samples[index]);
    return this.consume(this.detector.process(samples));
  }

  flush(): Float32Array {
    if (this.finished) throw new Error("TruePeakLimiter was already flushed.");
    this.finished = true;
    // Virtual silence after the end completes the last windows.
    const peaks = this.detector.flush();
    const required = new Float32Array(peaks.length + this.window).fill(1);
    for (let index = 0; index < peaks.length; index += 1) required[index] = this.requiredGain(peaks[index]);
    return this.emitAll(required);
  }

  private requiredGain(peak: number): number {
    if (peak <= this.ceiling) return 1;
    // Extra trim grows with the overshoot (twice its size, up to the margin), so
    // a rounding-sized excess is barely touched and a real one gets headroom.
    const extraDb = Math.min(this.marginDb, 2 * 20 * Math.log10(peak / this.ceiling));
    return (this.ceiling / peak) * dbToGain(-extraDb);
  }

  private consume(peaks: Float32Array): Float32Array {
    return this.emitAll(peaks.map((peak) => this.requiredGain(peak)));
  }

  private emitAll(required: Float32Array): Float32Array {
    const output = new Float32Array(required.length);
    let length = 0;
    for (let index = 0; index < required.length; index += 1) {
      if (this.pushRequired(required[index])) {
        output[length] = this.lastOutput;
        length += 1;
      }
    }
    return output.subarray(0, length);
  }

  /**
   * Adds the next required gain; returns true when that completes a real
   * sample, which is then in `lastOutput`.
   */
  private pushRequired(gain: number): boolean {
    const index = this.required.end;
    this.required.push(gain);
    const minimum = this.minimumIndices;
    const slots = minimum.length;
    while (this.minimumLength > 0) {
      const back = minimum[(this.minimumHead + this.minimumLength - 1) % slots];
      if (this.required.at(back) < gain) break;
      this.minimumLength -= 1;
    }
    minimum[(this.minimumHead + this.minimumLength) % slots] = index;
    this.minimumLength += 1;
    if (index - this.nextMinimum + 1 < this.window) return false;

    // Window minimum for virtual index `nextMinimum` covers [nextMinimum, nextMinimum + window).
    const virtual = this.nextMinimum;
    if (minimum[this.minimumHead] < virtual) {
      this.minimumHead = (this.minimumHead + 1) % slots;
      this.minimumLength -= 1;
    }
    const windowMinimum = this.required.at(minimum[this.minimumHead]);
    const releasedGain = Math.min(windowMinimum, this.lastReleased + (1 - this.lastReleased) * this.releaseCoefficient);
    this.lastReleased = releasedGain;
    const slot = virtual % this.window;
    this.releasedSum += releasedGain - this.released[slot];
    this.released[slot] = releasedGain;
    this.nextMinimum += 1;

    const real = virtual - this.window;
    // Keep `virtual` itself: the running minimum may still point at it.
    this.required.dropBefore(virtual);
    if (real < 0 || real >= this.input.end) return false;
    // Guard against rounding in the running sum: never exceed this sample's requirement.
    const appliedGain = Math.min(this.releasedSum / this.window, this.required.at(virtual));
    this.reduction = Math.min(this.reduction, appliedGain);
    this.lastOutput = this.input.at(real) * appliedGain;
    this.input.dropBefore(real + 1);
    return true;
  }
}

/**
 * Two limiter stages in series: the BS.1770 4x estimate, then a 16x safety
 * pass. Each stage is aligned with its input, so the pair is too.
 */
export class TruePeakLimiter {
  private readonly stages: readonly LimiterStage[];

  constructor(sampleRate: number, options: LimiterOptions) {
    this.stages = [
      new LimiterStage(sampleRate, options),
      new LimiterStage(sampleRate, {
        ...options,
        oversampling: SAFETY_OVERSAMPLING,
        filter: SAFETY_FILTER,
        marginDb: SAFETY_MARGIN_DB,
      }),
    ];
  }

  /** Lowest gain applied so far, combining both stages (0 = never limited). */
  get maxReductionDb(): number {
    return this.stages.reduce((total, stage) => total + stage.maxReductionDb, 0);
  }

  process(samples: Float32Array): Float32Array {
    return this.stages[1].process(this.stages[0].process(samples));
  }

  flush(): Float32Array {
    const first = this.stages[0].flush();
    const head = this.stages[1].process(first);
    const tail = this.stages[1].flush();
    const output = new Float32Array(head.length + tail.length);
    output.set(head);
    output.set(tail, head.length);
    return output;
  }
}

/** Limits a whole signal at once. */
export function limitTruePeak(audio: Float32Array, sampleRate: number, options: LimiterOptions): Float32Array {
  const limiter = new TruePeakLimiter(sampleRate, options);
  const head = limiter.process(audio);
  const tail = limiter.flush();
  const output = new Float32Array(head.length + tail.length);
  output.set(head);
  output.set(tail, head.length);
  return output;
}
