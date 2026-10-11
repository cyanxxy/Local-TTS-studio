import { describe, expect, it } from "vitest";
import { concatSamples, downmixToMono, resampleAudio } from "./pcmTransforms";

function sine(frequency: number, sampleRate: number, seconds: number, amplitude = 0.5): Float32Array {
  const output = new Float32Array(Math.round(sampleRate * seconds));
  for (let index = 0; index < output.length; index += 1) {
    output[index] = amplitude * Math.sin((2 * Math.PI * frequency * index) / sampleRate);
  }
  return output;
}

function rms(samples: Float32Array, start = 0, end = samples.length): number {
  let sum = 0;
  for (let index = start; index < end; index += 1) sum += samples[index] * samples[index];
  return Math.sqrt(sum / Math.max(1, end - start));
}

describe("resampleAudio", () => {
  it("returns the input when rates match or there is no audio", () => {
    const samples = new Float32Array([0.1, 0.2]);
    expect(resampleAudio(samples, 24000, 24000)).toBe(samples);
    const empty = new Float32Array(0);
    expect(resampleAudio(empty, 24000, 48000)).toBe(empty);
  });

  it("rejects invalid rates", () => {
    expect(() => resampleAudio(new Float32Array(4), 0, 24000)).toThrow(/Source sample rate/);
    expect(() => resampleAudio(new Float32Array(4), 24000, Number.NaN)).toThrow(/Target sample rate/);
  });

  it("keeps the duration and level of an in-band tone", () => {
    const input = sine(440, 44100, 0.5);
    const output = resampleAudio(input, 44100, 24000);
    expect(output.length).toBe(12000);
    // Ignore the edges, where clamping slightly changes the shape.
    expect(rms(output, 500, 11500)).toBeCloseTo(rms(input, 1000, 21000), 2);

    const up = resampleAudio(input, 44100, 48000);
    expect(up.length).toBe(24000);
    expect(rms(up, 500, 23500)).toBeCloseTo(rms(input, 1000, 21000), 2);
  });

  it("attenuates content above the new Nyquist rate when downsampling", () => {
    const input = sine(15000, 48000, 0.25);
    const output = resampleAudio(input, 48000, 16000);
    expect(rms(output, 200, output.length - 200)).toBeLessThan(0.05);
  });

  it("produces at least one sample for very short inputs", () => {
    expect(resampleAudio(new Float32Array([0.5]), 48000, 8000)).toHaveLength(1);
  });
});

describe("downmixToMono", () => {
  it("averages channels and truncates to the shortest", () => {
    const mono = downmixToMono([new Float32Array([1, 0.5, 0.25]), new Float32Array([0, 0.5])]);
    expect(Array.from(mono)).toEqual([0.5, 0.5]);
  });

  it("passes a single channel through and handles no channels", () => {
    const channel = new Float32Array([0.1]);
    expect(downmixToMono([channel])).toBe(channel);
    expect(downmixToMono([])).toHaveLength(0);
  });
});

describe("concatSamples", () => {
  it("joins buffers in order", () => {
    expect(Array.from(concatSamples([new Float32Array([1]), new Float32Array(0), new Float32Array([2, 3])])))
      .toEqual([1, 2, 3]);
  });
});
