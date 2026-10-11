import { describe, expect, it } from "vitest";
import { LoudnessMeter, TruePeakDetector, dbToGain, gainToDb, kWeightingCoefficients, measureLoudness } from "./loudness";

function sine(frequency: number, sampleRate: number, seconds: number, amplitude: number, phase = 0): Float32Array {
  const output = new Float32Array(Math.round(sampleRate * seconds));
  for (let i = 0; i < output.length; i += 1) {
    output[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate + phase);
  }
  return output;
}

function concat(...parts: Float32Array[]): Float32Array {
  const output = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

describe("dB helpers", () => {
  it("converts between gain and decibels", () => {
    expect(gainToDb(1)).toBe(0);
    expect(gainToDb(0.1)).toBeCloseTo(-20);
    expect(gainToDb(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(dbToGain(-6.0206)).toBeCloseTo(0.5, 4);
  });
});

describe("kWeightingCoefficients", () => {
  it("reproduces the BS.1770 coefficients at 48 kHz", () => {
    const [shelf, highPass] = kWeightingCoefficients(48000);
    expect(shelf.b0).toBeCloseTo(1.53512485958697, 6);
    expect(shelf.b1).toBeCloseTo(-2.69169618940638, 6);
    expect(shelf.b2).toBeCloseTo(1.19839281085285, 6);
    expect(shelf.a1).toBeCloseTo(-1.69065929318241, 6);
    expect(shelf.a2).toBeCloseTo(0.73248077421585, 6);
    expect(highPass.a1).toBeCloseTo(-1.99004745483398, 6);
    expect(highPass.a2).toBeCloseTo(0.99007225036621, 6);
    expect([highPass.b0, highPass.b1, highPass.b2]).toEqual([1, -2, 1]);
  });
});

describe("LoudnessMeter", () => {
  it.each([48000, 44100, 24000])("reads a -20 dBFS 997 Hz sine as -23.0 LUFS at %i Hz", (rate) => {
    const report = measureLoudness(sine(997, rate, 5, 0.1), rate);
    expect(report.integratedLufs).toBeCloseTo(-23.01, 1);
    expect(report.samplePeakDbfs).toBeCloseTo(-20, 1);
    expect(report.rmsDbfs).toBeCloseTo(-23.01, 2);
    expect(report.durationSec).toBeCloseTo(5);
    expect(report.loudnessRangeLu).toBeCloseTo(0, 1);
  });

  it("gates quiet passages out of the integrated loudness", () => {
    const loudThenQuiet = concat(sine(997, 48000, 5, 0.1), sine(997, 48000, 5, 0.001));
    // The 47 loud blocks pass and the quiet ones are gated; the three blocks
    // straddling the step carry 3/4, 1/2 and 1/4 of the loud energy:
    // 10 * log10(48.5 / 50) = -0.13 LU.
    expect(measureLoudness(loudThenQuiet, 48000).integratedLufs).toBeCloseTo(-23.01 - 0.132, 2);
  });

  it("measures the EBU Tech 3342 loudness range of a 10 LU step", () => {
    const rate = 16000;
    const quiet = sine(997, rate, 20, 0.1 * dbToGain(-10));
    const loud = sine(997, rate, 20, 0.1);
    expect(measureLoudness(concat(quiet, loud), rate).loudnessRangeLu).toBeCloseTo(10, 0);
  });

  it("measures signals shorter than one block as a single block", () => {
    expect(measureLoudness(sine(997, 48000, 0.2, 0.1), 48000).integratedLufs).toBeCloseTo(-23, 0);
  });

  it("reports silence as minus infinity", () => {
    const report = measureLoudness(new Float32Array(48000), 48000);
    expect(report).toEqual({
      integratedLufs: Number.NEGATIVE_INFINITY,
      loudnessRangeLu: 0,
      truePeakDbtp: Number.NEGATIVE_INFINITY,
      samplePeakDbfs: Number.NEGATIVE_INFINITY,
      rmsDbfs: Number.NEGATIVE_INFINITY,
      durationSec: 1,
    });
    expect(measureLoudness(new Float32Array(0), 48000).rmsDbfs).toBe(Number.NEGATIVE_INFINITY);
  });

  it("finds inter-sample peaks", () => {
    // A quarter-rate sine sampled 45 degrees off its crests peaks 3 dB above its samples.
    const report = measureLoudness(sine(12000, 48000, 1, 1, Math.PI / 4), 48000);
    expect(report.samplePeakDbfs).toBeCloseTo(-3.01, 1);
    expect(report.truePeakDbtp).toBeGreaterThan(-0.5);
    expect(report.truePeakDbtp).toBeLessThan(0.5);
  });

  it("can skip the true-peak search", () => {
    const signal = sine(12000, 48000, 1, 1, Math.PI / 4);
    const meter = new LoudnessMeter(48000, { truePeak: false });
    meter.process(signal);
    const report = meter.result();
    expect(report.truePeakDbtp).toBe(report.samplePeakDbfs);
    expect(report.integratedLufs).toBeCloseTo(measureLoudness(signal, 48000).integratedLufs, 9);
  });

  it("gives the same result for any chunking", () => {
    const signal = concat(sine(440, 24000, 2, 0.3), sine(3000, 24000, 1.3, 0.05));
    const whole = measureLoudness(signal, 24000);
    const meter = new LoudnessMeter(24000);
    for (let offset = 0; offset < signal.length; offset += 1777) meter.process(signal.subarray(offset, offset + 1777));
    const chunked = meter.result();
    expect(chunked.integratedLufs).toBeCloseTo(whole.integratedLufs, 9);
    expect(chunked.truePeakDbtp).toBeCloseTo(whole.truePeakDbtp, 9);
    expect(chunked.loudnessRangeLu).toBeCloseTo(whole.loudnessRangeLu, 9);
    expect(meter.result()).toEqual(chunked);
  });

  it("validates input and lifecycle", () => {
    expect(() => new LoudnessMeter(0)).toThrow(/positive integer/);
    const meter = new LoudnessMeter(24000);
    meter.result();
    expect(() => meter.process(new Float32Array(1))).toThrow(/after result/);
  });
});

describe("TruePeakDetector", () => {
  it("returns one peak per input sample, never below the sample itself", () => {
    const detector = new TruePeakDetector(24000);
    const input = sine(1000, 24000, 0.05, 0.8);
    const peaks = [...detector.process(input), ...detector.flush()];
    expect(peaks).toHaveLength(input.length);
    peaks.forEach((peak, index) => expect(peak).toBeGreaterThanOrEqual(Math.abs(input[index])));
  });

  it("rejects invalid sample rates", () => {
    expect(() => new TruePeakDetector(0)).toThrow(/positive integer/);
  });
});
