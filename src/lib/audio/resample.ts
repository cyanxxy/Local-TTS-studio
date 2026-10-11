/**
 * Rational-ratio polyphase resampler.
 *
 * The rate ratio is reduced to L/M (24 kHz -> 48 kHz is 2/1, 24 kHz -> 44.1
 * kHz is 147/80). One Kaiser-windowed sinc lowpass is designed at the
 * upsampled rate and split into L phases once, so each output sample costs a
 * single dot product of `taps` coefficients. The filter is centered (zero
 * phase) and its state carries across `process()` calls, so streaming chunks
 * gives exactly the same samples as resampling the whole signal at once.
 * Samples before the start and after the end are treated as silence.
 */

/** Filter half-length in samples of the lower of the two rates. */
const ZERO_CROSSINGS = 24;
/** Passband edge as a fraction of the lower Nyquist frequency. */
const ROLLOFF = 0.9;
/** Kaiser beta for about 85 dB of stopband attenuation. */
const KAISER_BETA = 8.6;

function gcd(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) {
    [x, y] = [y, x % y];
  }
  return x;
}

/** Zeroth-order modified Bessel function of the first kind (series expansion). */
export function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const quarterSquare = (x * x) / 4;
  for (let k = 1; k < 64; k += 1) {
    term *= quarterSquare / (k * k);
    sum += term;
    if (term < sum * 1e-16) break;
  }
  return sum;
}

function sinc(x: number): number {
  if (x === 0) return 1;
  const value = Math.PI * x;
  return Math.sin(value) / value;
}

export interface PolyphaseFilter {
  /** Upsampling factor L. */
  up: number;
  /** Downsampling factor M. */
  down: number;
  /** Coefficients per phase. */
  taps: number;
  /** `up * taps` coefficients, phase by phase; each phase sums to 1. */
  coefficients: Float32Array;
  /** Per phase: how many input samples before the anchor its first tap reads. */
  offsets: Int32Array;
  /** Input samples past the anchor any phase reads. */
  lookahead: number;
}

/**
 * Designs the polyphase lowpass for `up/down` (already reduced). `halfWidth`
 * is the filter half-length in samples of the lower rate.
 */
export function designPolyphaseFilter(up: number, down: number, options: PolyphaseFilterOptions = {}): PolyphaseFilter {
  const halfWidth = options.halfWidth ?? ZERO_CROSSINGS;
  const rolloff = options.rolloff ?? ROLLOFF;
  const beta = options.beta ?? KAISER_BETA;
  // Everything below is measured in samples of the upsampled rate.
  const span = halfWidth * Math.max(up, down);
  const cutoff = (rolloff * 0.5) / Math.max(up, down);
  const windowNorm = besselI0(beta);
  const impulse = (distance: number): number => {
    if (Math.abs(distance) > span) return 0;
    const ratio = distance / span;
    return 2 * cutoff * sinc(2 * cutoff * distance) * (besselI0(beta * Math.sqrt(1 - ratio * ratio)) / windowNorm);
  };

  const reach = Math.ceil(span / up);
  const taps = 2 * reach + 1;
  const coefficients = new Float32Array(up * taps);
  const offsets = new Int32Array(up);
  for (let phase = 0; phase < up; phase += 1) {
    const offset = Math.floor((span - phase) / up);
    offsets[phase] = offset;
    let sum = 0;
    const row = new Float64Array(taps);
    for (let tap = 0; tap < taps; tap += 1) {
      row[tap] = impulse(phase + (offset - tap) * up);
      sum += row[tap];
    }
    for (let tap = 0; tap < taps; tap += 1) coefficients[phase * taps + tap] = row[tap] / sum;
  }
  // Tap k of phase p reads input (anchor - offset + k); the furthest reaches taps - 1 - offset.
  let lookahead = 0;
  for (let phase = 0; phase < up; phase += 1) lookahead = Math.max(lookahead, taps - 1 - offsets[phase]);
  return { up, down, taps, coefficients, offsets, lookahead };
}

export interface PolyphaseFilterOptions {
  halfWidth?: number;
  rolloff?: number;
  beta?: number;
}

const filterCache = new Map<string, PolyphaseFilter>();

function cachedFilter(up: number, down: number, options: PolyphaseFilterOptions): PolyphaseFilter {
  const key = `${up}/${down}/${options.halfWidth}/${options.rolloff}/${options.beta}`;
  let filter = filterCache.get(key);
  if (!filter) {
    filter = designPolyphaseFilter(up, down, options);
    filterCache.set(key, filter);
  }
  return filter;
}

function assertRate(rate: number, label: string): void {
  if (!Number.isInteger(rate) || rate <= 0 || rate > 1_000_000) {
    throw new RangeError(`${label} sample rate must be a positive integer up to 1 MHz; got ${rate}.`);
  }
}

/** Streaming resampler: feed chunks to `process()`, then call `flush()` once. */
export class PolyphaseResampler {
  readonly fromRate: number;
  readonly toRate: number;
  private readonly filter: PolyphaseFilter | null;
  /** Unconsumed input; `history[0]` is input sample `historyStart`. */
  private history = new Float32Array(0);
  private historyStart = 0;
  private inputCount = 0;
  private outputCount = 0;
  private flushed = false;

  /** `filter` trades quality for speed; the defaults suit export. */
  constructor(fromRate: number, toRate: number, filter: PolyphaseFilterOptions = {}) {
    assertRate(fromRate, "Source");
    assertRate(toRate, "Target");
    this.fromRate = fromRate;
    this.toRate = toRate;
    const divisor = gcd(fromRate, toRate);
    this.filter = fromRate === toRate ? null : cachedFilter(toRate / divisor, fromRate / divisor, filter);
  }

  /** Output length for `inputLength` samples: round(inputLength * toRate / fromRate). */
  outputLength(inputLength: number): number {
    return Math.round((inputLength * this.toRate) / this.fromRate);
  }

  process(input: Float32Array): Float32Array {
    if (this.flushed) throw new Error("PolyphaseResampler cannot accept more input after flush().");
    if (!this.filter) {
      this.inputCount += input.length;
      this.outputCount += input.length;
      return input.slice();
    }
    const combined = new Float32Array(this.history.length + input.length);
    combined.set(this.history);
    combined.set(input, this.history.length);
    this.history = combined;
    this.inputCount += input.length;
    return this.produce(this.inputCount);
  }

  flush(): Float32Array {
    if (this.flushed) throw new Error("PolyphaseResampler was already flushed.");
    this.flushed = true;
    if (!this.filter) return new Float32Array(0);
    return this.produce(Number.POSITIVE_INFINITY);
  }

  /** Emits every output whose filter window ends before `available` input samples. */
  private produce(available: number): Float32Array {
    const { up, down, taps, coefficients, offsets, lookahead } = this.filter as PolyphaseFilter;
    const total = this.outputLength(this.inputCount);
    let end = this.outputCount;
    // Output n is anchored at input floor(n * down / up) and needs `lookahead` more samples.
    while (end < total && Math.floor((end * down) / up) + lookahead < available) end += 1;

    const output = new Float32Array(end - this.outputCount);
    const history = this.history;
    const historyStart = this.historyStart;
    const historyEnd = historyStart + history.length;
    for (let n = this.outputCount; n < end; n += 1) {
      const position = n * down;
      const anchor = Math.floor(position / up);
      const phase = position - anchor * up;
      const first = anchor - offsets[phase];
      const base = phase * taps;
      let sum = 0;
      if (first >= historyStart && first + taps <= historyEnd) {
        const start = first - historyStart;
        for (let tap = 0; tap < taps; tap += 1) sum += history[start + tap] * coefficients[base + tap];
      } else {
        for (let tap = 0; tap < taps; tap += 1) {
          const index = first + tap;
          if (index >= historyStart && index < historyEnd) sum += history[index - historyStart] * coefficients[base + tap];
        }
      }
      output[n - this.outputCount] = sum;
    }
    this.outputCount = end;

    // Drop input no future output can read.
    const nextAnchor = Math.floor((end * down) / up);
    let keepFrom = nextAnchor;
    for (let phase = 0; phase < up; phase += 1) keepFrom = Math.min(keepFrom, nextAnchor - offsets[phase]);
    const drop = Math.max(0, Math.min(history.length, keepFrom - historyStart));
    if (drop > 0) {
      this.history = history.slice(drop);
      this.historyStart += drop;
    }
    return output;
  }
}

/** One-shot resampling of a whole signal. */
export function resampleAudio(audio: Float32Array, fromRate: number, toRate: number): Float32Array {
  const resampler = new PolyphaseResampler(fromRate, toRate);
  const head = resampler.process(audio);
  const tail = resampler.flush();
  if (tail.length === 0) return head;
  const output = new Float32Array(head.length + tail.length);
  output.set(head);
  output.set(tail, head.length);
  return output;
}
