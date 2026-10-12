/**
 * Sample-rate and channel conversions for mono Float32 PCM. Every engine
 * renders at its own rate (Kokoro 24 kHz, Supertonic 44.1 kHz, Qwen3 24 kHz),
 * so anything that joins or stores audio from several engines resamples here.
 */

// Zero crossings of the windowed sinc on each side of an output sample.
const SINC_LOBES = 8;

function assertRate(rate: number, label: string): void {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`${label} sample rate must be a positive number.`);
  }
}

function sinc(value: number): number {
  if (Math.abs(value) < 1e-8) return 1;
  const x = Math.PI * value;
  return Math.sin(x) / x;
}

function blackmanWindow(distance: number, radius: number): number {
  const normalized = Math.abs(distance) / radius;
  if (normalized >= 1) return 0;
  return 0.42 + 0.5 * Math.cos(Math.PI * normalized) + 0.08 * Math.cos(2 * Math.PI * normalized);
}

/**
 * Band-limited (Blackman-windowed sinc) resampling. Downsampling lowers the
 * filter cutoff to the new Nyquist rate so speech does not alias. Returns the
 * input unchanged when the rates already match.
 */
export function resampleAudio(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  assertRate(fromRate, "Source");
  assertRate(toRate, "Target");
  if (fromRate === toRate || samples.length === 0) return samples;

  const ratio = toRate / fromRate;
  const targetLength = Math.max(1, Math.round(samples.length * ratio));
  const output = new Float32Array(targetLength);
  const filterScale = Math.min(1, ratio);
  const radius = SINC_LOBES / filterScale;
  const lastIndex = samples.length - 1;

  for (let index = 0; index < targetLength; index += 1) {
    const center = index / ratio;
    const left = Math.ceil(center - radius);
    const right = Math.floor(center + radius);
    let weightedSum = 0;
    let weightTotal = 0;
    for (let sampleIndex = left; sampleIndex <= right; sampleIndex += 1) {
      const distance = center - sampleIndex;
      const weight = sinc(distance * filterScale) * blackmanWindow(distance, radius);
      // Clamp at the edges instead of padding with zeros, which would fade
      // the first and last few milliseconds.
      const source = samples[sampleIndex < 0 ? 0 : sampleIndex > lastIndex ? lastIndex : sampleIndex];
      weightedSum += source * weight;
      weightTotal += weight;
    }
    output[index] = weightTotal === 0 ? 0 : weightedSum / weightTotal;
  }
  return output;
}

/** Average every channel into one. A single channel is returned unchanged. */
export function downmixToMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0];
  const length = Math.min(...channels.map((channel) => channel.length));
  const output = new Float32Array(length);
  for (const channel of channels) {
    for (let index = 0; index < length; index += 1) output[index] += channel[index];
  }
  const scale = 1 / channels.length;
  for (let index = 0; index < length; index += 1) output[index] *= scale;
  return output;
}

/** Concatenate mono buffers into one. */
export function concatSamples(parts: readonly Float32Array[]): Float32Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const output = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}
