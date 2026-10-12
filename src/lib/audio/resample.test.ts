import { describe, expect, it } from "vitest";
import { PolyphaseResampler, besselI0, designPolyphaseFilter, resampleAudio } from "./resample";

function sine(frequency: number, sampleRate: number, seconds: number, amplitude = 0.5): Float32Array {
  const output = new Float32Array(Math.round(sampleRate * seconds));
  for (let i = 0; i < output.length; i += 1) output[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  return output;
}

/** Amplitude of `frequency` in the middle half of the signal (Goertzel-style projection). */
function toneAmplitude(audio: Float32Array, frequency: number, sampleRate: number): number {
  const start = Math.floor(audio.length / 4);
  const end = Math.floor((audio.length * 3) / 4);
  let re = 0;
  let im = 0;
  for (let i = start; i < end; i += 1) {
    const angle = (2 * Math.PI * frequency * i) / sampleRate;
    re += audio[i] * Math.cos(angle);
    im += audio[i] * Math.sin(angle);
  }
  return (2 * Math.hypot(re, im)) / (end - start);
}

function db(ratio: number): number {
  return 20 * Math.log10(ratio);
}

describe("besselI0", () => {
  it("matches reference values", () => {
    expect(besselI0(0)).toBe(1);
    expect(besselI0(1)).toBeCloseTo(1.2660658777520082, 12);
    expect(besselI0(3)).toBeCloseTo(4.880792585865024, 12);
    expect(besselI0(8.6)).toBeCloseTo(750.4611595631661, 9);
  });
});

describe("designPolyphaseFilter", () => {
  it("normalizes every phase to unity gain at DC", () => {
    const filter = designPolyphaseFilter(147, 80);
    expect(filter.coefficients.length).toBe(147 * filter.taps);
    for (let phase = 0; phase < filter.up; phase += 1) {
      let sum = 0;
      for (let tap = 0; tap < filter.taps; tap += 1) sum += filter.coefficients[phase * filter.taps + tap];
      expect(sum).toBeCloseTo(1, 5);
    }
  });
});

describe("PolyphaseResampler", () => {
  it.each([
    [24000, 48000],
    [24000, 44100],
    [44100, 48000],
    [48000, 24000],
    [48000, 44100],
    [22050, 16000],
  ])("produces round(n * to / from) samples for %i -> %i Hz", (fromRate, toRate) => {
    for (const length of [0, 1, 7, 1000, 12345]) {
      expect(resampleAudio(new Float32Array(length), fromRate, toRate).length).toBe(Math.round((length * toRate) / fromRate));
    }
  });

  it("returns a copy when the rates match", () => {
    const input = new Float32Array([0.1, -0.2, 0.3]);
    const resampler = new PolyphaseResampler(24000, 24000);
    const output = resampler.process(input);
    expect(output).toEqual(input);
    expect(output).not.toBe(input);
    expect(resampler.flush()).toEqual(new Float32Array(0));
    expect(resampleAudio(input, 24000, 24000)).toEqual(input);
  });

  it.each([
    [24000, 48000],
    [24000, 44100],
    [44100, 48000],
    [48000, 44100],
    [48000, 24000],
  ])("keeps a 1 kHz tone within 0.01 dB for %i -> %i Hz", (fromRate, toRate) => {
    const output = resampleAudio(sine(1000, fromRate, 0.5), fromRate, toRate);
    expect(Math.abs(db(toneAmplitude(output, 1000, toRate) / 0.5))).toBeLessThan(0.01);
  });

  it("rejects the upsampling image by more than 70 dB", () => {
    const output = resampleAudio(sine(9000, 24000, 0.5), 24000, 48000);
    expect(db(toneAmplitude(output, 15000, 48000) / 0.5)).toBeLessThan(-70);
    expect(Math.abs(db(toneAmplitude(output, 9000, 48000) / 0.5))).toBeLessThan(0.1);
  });

  it("removes content above the new Nyquist frequency when downsampling", () => {
    const output = resampleAudio(sine(18000, 48000, 0.5), 48000, 24000);
    let energy = 0;
    for (let i = output.length / 4; i < (output.length * 3) / 4; i += 1) energy += output[i] * output[i];
    const rms = Math.sqrt(energy / (output.length / 2));
    expect(db(rms / (0.5 / Math.SQRT2))).toBeLessThan(-70);
  });

  it("gives identical output for any chunking", () => {
    const input = sine(440, 24000, 0.3);
    for (let i = 0; i < input.length; i += 97) input[i] += 0.2;
    const sizes = [1, 5, 300, 2048, 3, 777];
    for (const [fromRate, toRate] of [[24000, 44100], [24000, 48000], [48000, 24000]]) {
      const resampler = new PolyphaseResampler(fromRate, toRate);
      const parts: Float32Array[] = [];
      let offset = 0;
      for (let index = 0; offset < input.length; index += 1) {
        const size = sizes[index % sizes.length];
        parts.push(resampler.process(input.subarray(offset, offset + size)));
        offset += size;
      }
      parts.push(resampler.flush());
      const joined = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
      let cursor = 0;
      for (const part of parts) {
        joined.set(part, cursor);
        cursor += part.length;
      }
      expect(joined).toEqual(resampleAudio(input, fromRate, toRate));
    }
  });

  it("validates rates and lifecycle", () => {
    expect(() => new PolyphaseResampler(0, 48000)).toThrow(/Source sample rate/);
    expect(() => new PolyphaseResampler(24000, 44100.5)).toThrow(/Target sample rate/);
    const resampler = new PolyphaseResampler(24000, 48000);
    resampler.flush();
    expect(() => resampler.process(new Float32Array(1))).toThrow(/after flush/);
    expect(() => resampler.flush()).toThrow(/already flushed/);
  });

  it("resamples a minute of speech-rate audio with a bounded filter", () => {
    const input = sine(220, 24000, 60, 0.3);
    const output = resampleAudio(input, 24000, 48000);
    expect(output.length).toBe(input.length * 2);
    // Each output sample is one short dot product, so cost is bounded by construction.
    expect(designPolyphaseFilter(2, 1).taps).toBeLessThanOrEqual(49);
  });
});
