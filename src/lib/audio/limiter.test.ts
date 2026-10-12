import { describe, expect, it } from "vitest";
import { TruePeakLimiter, limitTruePeak } from "./limiter";
import { dbToGain, measureLoudness } from "./loudness";

function sine(frequency: number, sampleRate: number, seconds: number, amplitude: number): Float32Array {
  const output = new Float32Array(Math.round(sampleRate * seconds));
  for (let i = 0; i < output.length; i += 1) output[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  return output;
}

/** Peak of the signal reconstructed at 16x with a long windowed sinc, ignoring the edges. */
function referenceTruePeak(samples: Float32Array): number {
  const factor = 16;
  const half = 48;
  const margin = Math.floor(samples.length / 10);
  let peak = 0;
  for (let index = margin; index < samples.length - margin; index += 1) {
    for (let phase = 0; phase < factor; phase += 1) {
      const fraction = phase / factor;
      let sum = 0;
      for (let tap = -half + 1; tap <= half; tap += 1) {
        const distance = tap - fraction;
        const window = 0.5 + 0.5 * Math.cos((Math.PI * distance) / (half + 1));
        const sinc = distance === 0 ? 1 : Math.sin(Math.PI * distance) / (Math.PI * distance);
        sum += samples[index + tap] * sinc * window;
      }
      peak = Math.max(peak, Math.abs(sum));
    }
  }
  return peak;
}

describe("TruePeakLimiter", () => {
  it("keeps wideband noise under the ceiling at fine oversampling", () => {
    // A 4x estimate alone left white noise at twice full scale about 0.6 dB over a -1 dB ceiling.
    let seed = 12345;
    const input = new Float32Array(12000);
    for (let i = 0; i < input.length; i += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      input[i] = (seed / 2 ** 32 - 0.5) * 4;
    }
    const output = limitTruePeak(input, 48000, { ceilingDb: -1 });
    expect(output).toHaveLength(input.length);
    expect(20 * Math.log10(referenceTruePeak(output))).toBeLessThanOrEqual(-1 + 0.01);
  });

  it("passes audio under the ceiling unchanged", () => {
    const input = sine(440, 24000, 0.5, 0.5);
    const limiter = new TruePeakLimiter(24000, { ceilingDb: -1 });
    const output = limitTruePeak(input, 24000, { ceilingDb: -1 });
    expect(output).toEqual(input);
    limiter.process(input);
    limiter.flush();
    expect(limiter.maxReductionDb).toBe(0);
  });

  it("keeps sample and true peaks under the ceiling", () => {
    const input = sine(1000, 48000, 1, 2);
    const output = limitTruePeak(input, 48000, { ceilingDb: -1 });
    expect(output).toHaveLength(input.length);
    const ceiling = dbToGain(-1);
    expect(Math.max(...output.map(Math.abs))).toBeLessThanOrEqual(ceiling + 1e-6);
    expect(measureLoudness(output, 48000).truePeakDbtp).toBeLessThanOrEqual(-1 + 0.1);
  });

  it("catches inter-sample peaks that sample peaks miss", () => {
    // A quarter-rate sine 45 degrees off its crests: samples at 0.707, true peak 1.0.
    const input = new Float32Array(24000);
    for (let i = 0; i < input.length; i += 1) input[i] = Math.sin((Math.PI / 2) * i + Math.PI / 4);
    const output = limitTruePeak(input, 48000, { ceilingDb: -1 });
    expect(measureLoudness(output, 48000).truePeakDbtp).toBeLessThanOrEqual(-1 + 0.1);
  });

  it("ramps gain smoothly around a sudden peak and releases afterwards", () => {
    const rate = 48000;
    // A slow wave on a DC offset never crosses zero, so output / input is the gain at every sample.
    const input = sine(200, rate, 1, 0.1).map((sample) => sample + 0.3);
    for (let i = 24000; i < 24010; i += 1) input[i] = 1;
    const output = limitTruePeak(input, rate, { ceilingDb: -6, lookaheadMs: 5, releaseMs: 50 });
    const gains = Array.from(input, (sample, i) => output[i] / sample);
    const steps = gains.slice(1).map((gain, index) => Math.abs(gain - gains[index]));
    // The gain moves gradually: at most one look-ahead window's share per sample.
    expect(Math.max(...steps)).toBeLessThan(1 / 240 + 1e-6);
    expect(Math.max(...output.slice(24000, 24010).map(Math.abs))).toBeLessThanOrEqual(dbToGain(-6) + 1e-6);
    // The gain falls before the peak arrives and is back near unity 0.4 s later.
    expect(output[23990] / input[23990]).toBeLessThan(1);
    expect(output[44000] / input[44000]).toBeGreaterThan(0.999);
  });

  it("gives identical output for any chunking", () => {
    const input = sine(700, 24000, 0.6, 1.5);
    const whole = limitTruePeak(input, 24000, { ceilingDb: -2 });
    const limiter = new TruePeakLimiter(24000, { ceilingDb: -2 });
    const parts: number[] = [];
    for (let offset = 0; offset < input.length; offset += 333) {
      parts.push(...limiter.process(input.subarray(offset, offset + 333)));
    }
    parts.push(...limiter.flush());
    expect(Float32Array.from(parts)).toEqual(whole);
    expect(limiter.maxReductionDb).toBeGreaterThan(5);
  });

  it("handles empty input and enforces its lifecycle", () => {
    expect(limitTruePeak(new Float32Array(0), 24000, { ceilingDb: -1 })).toEqual(new Float32Array(0));
    const limiter = new TruePeakLimiter(24000, { ceilingDb: -1 });
    limiter.flush();
    expect(() => limiter.process(new Float32Array(1))).toThrow(/after flush/);
    expect(() => limiter.flush()).toThrow(/already flushed/);
  });

  it("limits a long input to its length and ceiling", () => {
    const input = sine(300, 24000, 30, 1.2);
    const output = limitTruePeak(input, 24000, { ceilingDb: -1 });
    expect(output).toHaveLength(input.length);
  });
});
