import type { RawAudio } from "@huggingface/transformers";
import { describe, expect, it } from "vitest";
import { normalizeRawAudioOutput } from "./audioOutput";

function raw(audio: unknown, samplingRate: unknown): RawAudio {
  return { audio, sampling_rate: samplingRate } as RawAudio;
}

describe("audioOutput", () => {
  it("returns Float32Array audio unchanged with a valid sampling rate", () => {
    const audio = new Float32Array([0.1, -0.2]);

    expect(normalizeRawAudioOutput(raw(audio, 24000))).toEqual({
      audio,
      samplingRate: 24000,
    });
  });

  it("converts numeric arrays and typed arrays into Float32Array", () => {
    expect(Array.from(normalizeRawAudioOutput(raw([0, "0.5"], "16000")).audio)).toEqual([0, 0.5]);
    expect(Array.from(normalizeRawAudioOutput(raw(new Int16Array([1, -2]), 8000)).audio)).toEqual([1, -2]);
  });

  it("uses RawAudio data when available", () => {
    const output = {
      audio: [999],
      data: new Float32Array([0.125, -0.25]),
      sampling_rate: 24000,
    } as unknown as RawAudio;

    expect(Array.from(normalizeRawAudioOutput(output).audio)).toEqual([0.125, -0.25]);
  });

  it("rejects invalid sampling rates and unsupported audio payloads", () => {
    expect(() => normalizeRawAudioOutput(raw([0], 0))).toThrow("invalid sampling rate");
    expect(() => normalizeRawAudioOutput(raw([Number.NaN], 16000))).toThrow("non-finite");
    expect(() => normalizeRawAudioOutput(raw(new Float32Array([Number.NaN]), 16000))).toThrow("non-finite");
    expect(() => normalizeRawAudioOutput(raw(new Float64Array([Number.POSITIVE_INFINITY]), 16000))).toThrow("non-finite");
    expect(() => normalizeRawAudioOutput(raw(new DataView(new ArrayBuffer(4)), 16000))).toThrow("DataView");
    expect(() => normalizeRawAudioOutput(raw({ audio: [0] }, 16000))).toThrow("Unsupported raw audio");
    expect(() => normalizeRawAudioOutput(raw([], 16000))).toThrow("empty audio");
  });
});
