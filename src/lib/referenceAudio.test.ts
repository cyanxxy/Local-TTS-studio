import { describe, expect, it } from "vitest";
import { createWavBlob } from "./audio";
import {
  MAX_REFERENCE_WAV_BYTES,
  REFERENCE_DURATION_LIMITS,
  analyzeReferenceClip,
  assessReferenceClip,
  findSpeechBounds,
  normalizePeak,
  prepareReferenceClip,
  trimClip,
  type ReferenceCheckId,
  type ReferenceClipAnalysis,
} from "./referenceAudio";
import { decodeWav, encodeWavPcm16 } from "./wavCodec";

const RATE = 16_000;

/** Deterministic noise so level assertions never flake. */
function noise(length: number, amplitude: number, seed = 1): Float32Array {
  let state = seed;
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    output[index] = ((state / 0xffffffff) * 2 - 1) * amplitude;
  }
  return output;
}

/** silence + tone (a stand-in for speech) + silence, with optional room noise. */
function clip(options: {
  leadSec?: number;
  speechSec?: number;
  tailSec?: number;
  amplitude?: number;
  noiseAmplitude?: number;
  rate?: number;
}): Float32Array {
  const rate = options.rate ?? RATE;
  const lead = Math.round((options.leadSec ?? 0.1) * rate);
  const speech = Math.round((options.speechSec ?? 5) * rate);
  const tail = Math.round((options.tailSec ?? 0.1) * rate);
  const output = noise(lead + speech + tail, options.noiseAmplitude ?? 0.0005);
  const amplitude = options.amplitude ?? 0.3;
  for (let index = 0; index < speech; index += 1) {
    output[lead + index] += amplitude * Math.sin((2 * Math.PI * 220 * index) / rate);
  }
  return output;
}

function statusOf(analysis: ReferenceClipAnalysis, id: ReferenceCheckId, transcript?: string, target: "qwen3-base" | "neutts" = "qwen3-base") {
  return assessReferenceClip(analysis, target, { transcript }).checks.find((check) => check.id === id);
}

describe("analyzeReferenceClip", () => {
  it("measures duration, levels, silence and noise of a clean clip", () => {
    const analysis = analyzeReferenceClip(clip({ leadSec: 0.4, speechSec: 5, tailSec: 0.6 }), RATE, { channelCount: 2 });
    expect(analysis.durationSec).toBeCloseTo(6, 3);
    expect(analysis.channelCount).toBe(2);
    expect(analysis.peakDbfs).toBeCloseTo(-10.4, 0);
    expect(analysis.speechRmsDbfs).toBeCloseTo(-13.5, 0);
    expect(analysis.leadingSilenceSec).toBeCloseTo(0.4, 1);
    expect(analysis.trailingSilenceSec).toBeCloseTo(0.6, 1);
    expect(analysis.speechDurationSec).toBeCloseTo(5, 1);
    expect(analysis.speechRatio).toBeGreaterThan(0.8);
    expect(analysis.noiseFloorDbfs).toBeLessThan(-60);
    expect(analysis.snrDb).toBeGreaterThan(40);
    expect(analysis.clippingRatio).toBe(0);
    expect(Math.abs(analysis.dcOffset)).toBeLessThan(0.001);
  });

  it("reports silence-only and empty clips without speech", () => {
    const silent = analyzeReferenceClip(new Float32Array(RATE), RATE);
    expect(silent.speechDurationSec).toBe(0);
    expect(silent.leadingSilenceSec).toBe(1);
    expect(silent.trailingSilenceSec).toBe(1);
    expect(silent.peakDbfs).toBe(-120);
    expect(silent.speechRmsDbfs).toBe(-120);

    const empty = analyzeReferenceClip(new Float32Array(0), RATE);
    expect(empty.durationSec).toBe(0);
    expect(empty.speechRatio).toBe(0);
    expect(empty.noiseFloorDbfs).toBe(-120);
  });

  it("treats a clip without pauses as all speech", () => {
    const analysis = analyzeReferenceClip(clip({ leadSec: 0, tailSec: 0, speechSec: 2 }), RATE);
    expect(analysis.speechRatio).toBe(1);
    expect(analysis.leadingSilenceSec).toBe(0);
    // With no quiet frames the noise floor falls back to the quietest speech.
    expect(analysis.noiseFloorDbfs).toBeCloseTo(analysis.speechRmsDbfs, 0);

    const murmur = analyzeReferenceClip(clip({ leadSec: 0, tailSec: 0, amplitude: 0.001, noiseAmplitude: 0 }), RATE);
    expect(murmur.speechRatio).toBe(0);
  });

  it("counts clipped samples and ignores non-finite ones", () => {
    const samples = clip({ amplitude: 0.3 });
    samples[100] = Number.NaN;
    for (let index = 2000; index < 3000; index += 1) samples[index] = 1;
    const analysis = analyzeReferenceClip(samples, RATE);
    expect(analysis.clippingRatio).toBeCloseTo(1000 / samples.length, 5);
    expect(analysis.peakDbfs).toBe(0);
  });

  it("rejects an invalid sample rate", () => {
    expect(() => analyzeReferenceClip(new Float32Array(10), 0)).toThrow(/sample rate/);
  });
});

describe("assessReferenceClip", () => {
  it("passes a clean 5 s clip with a plausible transcript", () => {
    const analysis = analyzeReferenceClip(clip({}), RATE);
    const transcript = "This is about the right amount of text for five seconds.";
    const assessment = assessReferenceClip(analysis, "qwen3-base", { transcript });
    expect(assessment.status).toBe("pass");
    expect(assessment.checks.map((check) => check.id)).toEqual([
      "duration", "clipping", "loudness", "noise", "edge-silence", "speech-ratio", "sample-rate", "dc-offset", "transcript",
    ]);
    expect(assessment.checks.every((check) => check.fix === undefined)).toBe(true);
  });

  it("applies each runtime's duration rules", () => {
    expect(REFERENCE_DURATION_LIMITS["qwen3-base"].maxSec).toBe(20);
    const long = analyzeReferenceClip(clip({ speechSec: 21 }), RATE);
    expect(statusOf(long, "duration")?.status).toBe("fail");
    expect(statusOf(long, "duration", undefined, "neutts")).toMatchObject({ status: "warn", message: expect.stringMatching(/first 20 s/) });

    const short = analyzeReferenceClip(clip({ speechSec: 2 }), RATE);
    expect(statusOf(short, "duration")?.status).toBe("warn");

    const tiny = analyzeReferenceClip(clip({ speechSec: 0.4 }), RATE);
    expect(statusOf(tiny, "duration", undefined, "neutts")?.status).toBe("fail");
    const halfSecond = analyzeReferenceClip(clip({ speechSec: 0.7 }), RATE);
    expect(statusOf(halfSecond, "duration", undefined, "neutts")?.status).toBe("warn");
    expect(statusOf(halfSecond, "duration")?.status).toBe("fail");
  });

  it("grades clipping, loudness, noise and edge silence", () => {
    const base = analyzeReferenceClip(clip({}), RATE);
    expect(statusOf({ ...base, clippingRatio: 0.005 }, "clipping")?.status).toBe("warn");
    expect(statusOf({ ...base, clippingRatio: 0.02 }, "clipping")?.status).toBe("fail");

    const quiet = analyzeReferenceClip(clip({ amplitude: 0.01, noiseAmplitude: 0 }), RATE);
    expect(statusOf(quiet, "loudness")?.status).toBe("warn");
    expect(statusOf({ ...base, speechRmsDbfs: -3 }, "loudness")?.message).toMatch(/very loud/);

    const noisy = analyzeReferenceClip(clip({ noiseAmplitude: 0.09 }), RATE);
    expect(statusOf(noisy, "noise")?.status).toBe("warn");
    expect(statusOf({ ...base, snrDb: 5 }, "noise")?.status).toBe("fail");

    const padded = analyzeReferenceClip(clip({ leadSec: 1.2 }), RATE);
    expect(statusOf(padded, "edge-silence")).toMatchObject({ status: "warn", fix: expect.stringMatching(/auto-trim/) });
  });

  it("flags sparse speech, low sample rates, DC offset and transcript mismatches", () => {
    const base = analyzeReferenceClip(clip({}), RATE);
    expect(statusOf({ ...base, speechRatio: 0.3 }, "speech-ratio")?.status).toBe("warn");
    expect(statusOf({ ...base, sampleRate: 8000 }, "sample-rate")?.status).toBe("warn");
    expect(statusOf({ ...base, dcOffset: 0.05 }, "dc-offset")?.status).toBe("warn");
    expect(statusOf(base, "transcript", "   ")?.status).toBe("fail");
    expect(statusOf(base, "transcript", "Hi.")?.message).toMatch(/too short/);
    expect(statusOf(base, "transcript", "x".repeat(400))?.message).toMatch(/too long/);
    expect(assessReferenceClip(base, "neutts").checks.some((check) => check.id === "transcript")).toBe(false);
  });

  it("reports the worst status overall", () => {
    const base = analyzeReferenceClip(clip({}), RATE);
    expect(assessReferenceClip({ ...base, dcOffset: 0.05 }, "qwen3-base").status).toBe("warn");
    expect(assessReferenceClip({ ...base, dcOffset: 0.05, clippingRatio: 0.5 }, "qwen3-base").status).toBe("fail");
  });
});

describe("editing helpers", () => {
  it("trims by time and clamps out-of-range bounds", () => {
    const samples = Float32Array.from({ length: 10 }, (_, index) => index);
    expect(Array.from(trimClip(samples, 10, { startSec: 0.2, endSec: 0.5 }))).toEqual([2, 3, 4]);
    expect(trimClip(samples, 10, { startSec: -1, endSec: 99 })).toHaveLength(10);
    expect(trimClip(samples, 10, { startSec: 0.8, endSec: 0.1 })).toHaveLength(0);
    expect(trimClip(samples, 10, {})).toHaveLength(10);
    expect(() => trimClip(samples, -1, {})).toThrow(/sample rate/);
  });

  it("finds padded speech bounds", () => {
    const samples = clip({ leadSec: 1, speechSec: 3, tailSec: 1 });
    const bounds = findSpeechBounds(samples, RATE, { paddingSec: 0.1 });
    expect(bounds.startSec).toBeCloseTo(0.9, 1);
    expect(bounds.endSec).toBeCloseTo(4.1, 1);
    expect(findSpeechBounds(samples, RATE).startSec).toBeCloseTo(0.85, 1);
    expect(findSpeechBounds(new Float32Array(RATE), RATE)).toEqual({ startSec: 0, endSec: 1 });
    expect(findSpeechBounds(clip({ leadSec: 0, tailSec: 0, speechSec: 1 }), RATE, { paddingSec: -5 }))
      .toEqual({ startSec: 0, endSec: 1 });
  });

  it("normalizes the peak without exceeding full scale", () => {
    const normalized = normalizePeak(new Float32Array([0.25, -0.5, Number.NaN]));
    expect(normalized[1]).toBeCloseTo(-0.891, 3);
    expect(normalized[0]).toBeCloseTo(0.4456, 3);
    expect(normalized[2]).toBe(0);
    expect(Math.max(...normalizePeak(new Float32Array([0.5]), 6))).toBeCloseTo(1, 6);
    const silent = new Float32Array(3);
    const copy = normalizePeak(silent);
    expect(copy).not.toBe(silent);
    expect(Array.from(copy)).toEqual([0, 0, 0]);
  });
});

describe("prepareReferenceClip", () => {
  it("downmixes, trims, normalizes, resamples and re-encodes", async () => {
    const left = clip({ leadSec: 1, speechSec: 4, tailSec: 1, rate: 48000 });
    const interleaved = new Float32Array(left.length * 2);
    left.forEach((value, index) => {
      interleaved[index * 2] = value;
      interleaved[index * 2 + 1] = value;
    });
    const wav = await createWavBlob([interleaved], 48000, { channelCount: 2 }).arrayBuffer();

    const prepared = prepareReferenceClip(wav, {
      autoTrim: true,
      // A sine's crest factor is 3 dB, so a -1 dBFS peak would read as
      // overly loud speech; real speech peaks 15-20 dB above its RMS.
      normalizeToDbfs: -10,
      target: "neutts",
      transcript: "A sentence that is long enough for four seconds of talk.",
    });
    expect(prepared.sampleRate).toBe(24000);
    expect(prepared.trimmed).toBe(true);
    expect(prepared.analysis.channelCount).toBe(2);
    expect(prepared.analysis.sampleRate).toBe(48000);
    expect(prepared.analysis.durationSec).toBeCloseTo(4.3, 1);
    expect(prepared.analysis.peakDbfs).toBeCloseTo(-10, 0);
    expect(prepared.assessment.target).toBe("neutts");
    expect(prepared.assessment.status).toBe("pass");
    const decoded = decodeWav(prepared.wav);
    expect(decoded.sampleRate).toBe(24000);
    expect(decoded.channels).toHaveLength(1);
    expect(decoded.channels[0].length).toBe(prepared.samples.length);
  });

  it("applies an explicit trim and keeps untouched clips flagged as untrimmed", () => {
    const wav = encodeWavPcm16(clip({ speechSec: 6 }), RATE);
    const untouched = prepareReferenceClip(wav, { sampleRate: RATE });
    expect(untouched.trimmed).toBe(false);
    expect(untouched.assessment.target).toBe("qwen3-base");
    const cut = prepareReferenceClip(wav, { trim: { startSec: 1, endSec: 4 }, sampleRate: RATE });
    expect(cut.trimmed).toBe(true);
    expect(cut.analysis.durationSec).toBeCloseTo(3, 2);
  });

  it("refuses files over the bridge's reference size limit", () => {
    expect(MAX_REFERENCE_WAV_BYTES).toBe(45_000_000);
    expect(() => prepareReferenceClip(new ArrayBuffer(MAX_REFERENCE_WAV_BYTES + 1))).toThrow(/45,000,000 bytes/);
  });
});
