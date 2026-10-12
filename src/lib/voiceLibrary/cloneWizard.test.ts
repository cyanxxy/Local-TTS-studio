import { describe, expect, it } from "vitest";
import {
  assessSelection,
  autoTrimRange,
  buildClonedVoice,
  clampTrim,
  computePeaks,
  mergeChecks,
  targetsNeedTranscript,
  type ClipSource,
  type CloneSettings,
} from "./cloneWizard";
import { decodeWav } from "../wavCodec";

const RATE = 24_000;

/** A speech-like burst: a few harmonics with a slow envelope, over a quiet noise floor. */
function speech(seconds: number, amplitude = 0.3): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  let state = 7;
  for (let index = 0; index < out.length; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const envelope = 0.6 + 0.4 * Math.sin((index / RATE) * 6);
    const voice = Math.sin(index / 9) + 0.5 * Math.sin(index / 4.1) + 0.25 * Math.sin(index / 2.3);
    out[index] = amplitude * envelope * voice * 0.55 + ((state / 0xffffffff) * 2 - 1) * 0.0005;
  }
  return out;
}

function silence(seconds: number): Float32Array {
  return new Float32Array(Math.round(seconds * RATE));
}

function join(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function source(samples: Float32Array, overrides: Partial<ClipSource> = {}): ClipSource {
  return { samples, sampleRate: RATE, channelCount: 1, origin: "recording", label: "Recording", ...overrides };
}

const full = (samples: Float32Array): { startSec: number; endSec: number } => ({ startSec: 0, endSec: samples.length / RATE });
const settings = (samples: Float32Array, overrides: Partial<CloneSettings> = {}): CloneSettings => ({
  range: full(samples),
  targets: ["qwen3-base"],
  transcript: "the quick brown fox jumps over the lazy dog and keeps on running far away",
  normalize: false,
  ...overrides,
});

describe("trim and waveform helpers", () => {
  it("keeps a trim inside the clip and at least half a second long", () => {
    expect(clampTrim({ startSec: -2, endSec: 99 }, 6)).toEqual({ startSec: 0, endSec: 6 });
    expect(clampTrim({ startSec: 5.9, endSec: 6 }, 6)).toEqual({ startSec: 5.5, endSec: 6 });
    expect(clampTrim({ startSec: 3, endSec: 2 }, 6)).toEqual({ startSec: 3, endSec: 3.5 });
    expect(clampTrim({ startSec: 0, endSec: 0.1 }, 0.3)).toEqual({ startSec: 0, endSec: 0.3 });
  });

  it("scales peaks to the loudest bin and survives empty input", () => {
    const peaks = computePeaks(Float32Array.from([0, 0.1, -0.5, 0.2, 0, 0, 0.25, 0]), 4);
    expect(Array.from(peaks)).toEqual([0.2, 1, 0, 0.5].map((value) => expect.closeTo(value, 5)));
    expect(computePeaks(new Float32Array(0), 3)).toEqual(new Float32Array(3));
    expect(computePeaks(new Float32Array(5), 0)).toHaveLength(1);
  });

  it("finds the speech inside leading and trailing silence", () => {
    const clip = join(silence(1), speech(4), silence(1.5));
    const range = autoTrimRange(clip, RATE);
    expect(range.startSec).toBeGreaterThan(0.7);
    expect(range.startSec).toBeLessThan(1);
    expect(range.endSec).toBeGreaterThan(5);
    expect(range.endSec).toBeLessThan(5.4);
  });
});

describe("assessSelection", () => {
  it("checks the selected part only, per chosen target, worst verdict first", () => {
    const clip = join(speech(5), silence(3));
    const trimmed = assessSelection(source(clip), settings(clip, { range: { startSec: 0, endSec: 5 } }));
    const whole = assessSelection(source(clip), settings(clip));
    expect(trimmed.analysis.durationSec).toBeCloseTo(5, 1);
    expect(whole.analysis.durationSec).toBeCloseTo(8, 1);
    expect(whole.checks.find((check) => check.id === "edge-silence")?.status).not.toBe("pass");
    expect(trimmed.checks.find((check) => check.id === "edge-silence")?.status).toBe("pass");

    const long = join(speech(14));
    const both = assessSelection(source(long), settings(long, { targets: ["qwen3-base", "chatterbox"] }));
    // 14 s is fine for Qwen3 Base (20 s) but over Chatterbox's 10 s window.
    expect(both.checks.find((check) => check.id === "duration")).toMatchObject({ status: "fail" });
    expect(both.status).toBe("fail");
  });

  it("only checks the transcript when asked, and never for Chatterbox alone", () => {
    const clip = speech(6);
    expect(assessSelection(source(clip), settings(clip, { transcript: "" })).checks.some((check) => check.id === "transcript")).toBe(false);
    expect(assessSelection(source(clip), settings(clip, { transcript: "" }), true).checks.find((check) => check.id === "transcript")?.status).toBe("fail");
    expect(assessSelection(source(clip), settings(clip, { transcript: "", targets: ["chatterbox"] }), true).checks.some((check) => check.id === "transcript")).toBe(false);
  });

  it("normalizes before measuring when asked", () => {
    const quiet = speech(6, 0.02);
    const before = assessSelection(source(quiet), settings(quiet));
    const after = assessSelection(source(quiet), settings(quiet, { normalize: true }));
    expect(after.analysis.peakDbfs).toBeGreaterThan(before.analysis.peakDbfs + 10);
  });

  it("merges checks by id keeping the worst", () => {
    expect(mergeChecks([
      [{ id: "duration", status: "pass", message: "ok" }, { id: "noise", status: "warn", message: "n" }],
      [{ id: "duration", status: "fail", message: "bad", fix: "trim" }],
    ])).toEqual([
      { id: "duration", status: "fail", message: "bad", fix: "trim" },
      { id: "noise", status: "warn", message: "n" },
    ]);
    expect(targetsNeedTranscript(["chatterbox"])).toBe(false);
    expect(targetsNeedTranscript(["chatterbox", "neutts"])).toBe(true);
  });
});

describe("buildClonedVoice", () => {
  it("returns the trimmed 24 kHz reference with the transcript and targets", () => {
    const clip = join(silence(1), speech(6), silence(1));
    const built = buildClonedVoice(
      source(clip, { origin: "upload" }),
      settings(clip, { range: { startSec: 0.8, endSec: 7.2 }, targets: ["qwen3-base", "neutts"], transcript: "  words here  " }),
      { name: "Me", language: "English" },
    );
    expect(built.voice).toMatchObject({ kind: "cloned", name: "Me", transcript: "words here", targets: ["qwen3-base", "neutts"], source: "upload", language: "English" });
    const decoded = decodeWav(built.voice.referenceWav);
    expect(decoded.sampleRate).toBe(24_000);
    expect(decoded.channels[0].length / 24_000).toBeCloseTo(6.4, 1);
  });

  it("allows an empty transcript for Chatterbox only", () => {
    const clip = speech(6);
    expect(buildClonedVoice(source(clip), settings(clip, { targets: ["chatterbox"], transcript: "" }), { name: "CB", language: "English" }).voice.transcript).toBe("");
    expect(() => buildClonedVoice(source(clip), settings(clip, { transcript: "" }), { name: "Q", language: "English" })).toThrow(/exactly what is said/);
  });

  it("refuses clips the target engines reject, with the fix to apply", () => {
    const long = speech(14);
    expect(() => buildClonedVoice(source(long), settings(long, { targets: ["chatterbox"], transcript: "" }), { name: "x", language: "English" }))
      .toThrow(/Chatterbox Turbo rejects references longer than 10 s/);
    expect(() => buildClonedVoice(source(speech(6)), settings(speech(6), { targets: [] }), { name: "x", language: "English" }))
      .toThrow(/at least one engine/);
    const tiny = speech(0.4);
    expect(() => buildClonedVoice(source(tiny), settings(tiny), { name: "x", language: "English" })).toThrow(/needs at least/);
  });

  it("passes warnings through for a short but usable clip", () => {
    const clip = speech(4);
    const built = buildClonedVoice(source(clip), settings(clip, { transcript: "a short line spoken in four seconds" }), { name: "x", language: "English" });
    expect(Array.isArray(built.warnings)).toBe(true);
  });
});
