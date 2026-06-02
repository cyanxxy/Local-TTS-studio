import { describe, expect, it } from "vitest";
import {
  float32ChunksToWavBytes,
  getNeuttsReferenceGuidance,
  inspectAudioFile,
  isLikelyWavBuffer,
} from "./utils";

function makeWavHeader(): ArrayBuffer {
  const bytes = new Uint8Array(12);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x41, 0x56, 0x45], 8);
  return bytes.buffer;
}

describe("localRuntime utils", () => {
  it("detects RIFF/WAVE headers", () => {
    expect(isLikelyWavBuffer(makeWavHeader())).toBe(true);
    expect(isLikelyWavBuffer(new Uint8Array([1, 2, 3, 4]).buffer)).toBe(false);
  });

  it("marks a doc-aligned NeuTTS reference clip as success", () => {
    const guidance = getNeuttsReferenceGuidance({
      channelCount: 1,
      sampleRate: 24_000,
      durationSec: 5.5,
    });

    expect(guidance.tone).toBe("success");
    expect(guidance.text).toContain("Reference WAV looks good");
  });

  it("warns when the reference clip falls outside NeuTTS guidance", () => {
    const guidance = getNeuttsReferenceGuidance({
      channelCount: 2,
      sampleRate: 48_000,
      durationSec: 1.2,
    });

    expect(guidance.tone).toBe("info");
    expect(guidance.text).toContain("Best results use mono audio, 16-44 kHz, and a 3-15 second clip.");
  });

  it("inspects WAV metadata directly from the header", async () => {
    const bytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x28, 0x00, 0x00, 0x00,
      0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
      0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x02, 0x00,
      0x80, 0xbb, 0x00, 0x00, 0x00, 0xee, 0x02, 0x00,
      0x04, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61,
      0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);

    await expect(inspectAudioFile(bytes.buffer)).resolves.toEqual({
      channelCount: 2,
      sampleRate: 48_000,
      durationSec: 1 / 48_000,
    });
  });

  it("assembles streamed Float32 chunks into a WAV with inserted silence", () => {
    const first = new Float32Array([0.5, -0.5]).buffer;
    const second = new Float32Array([1]).buffer;
    const wav = float32ChunksToWavBytes([
      { audio: first, sampleCount: 2, silenceAfterSamples: 1 },
      { audio: second, sampleCount: 1, silenceAfterSamples: 0 },
    ], 24_000);
    const view = new DataView(wav.buffer);

    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe("WAVE");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint32(40, true)).toBe(8);
    expect(view.getInt16(44, true)).toBe(16384);
    expect(view.getInt16(46, true)).toBe(-16383);
    expect(view.getInt16(48, true)).toBe(0);
    expect(view.getInt16(50, true)).toBe(32767);
  });

  it("encodes a single NeuTTS/Kani chunk with no trailing silence", () => {
    // NeuTTS and Kani stream their whole-text waveform as one binary chunk:
    // index 0, total 1, silenceAfterSamples 0.
    const audio = new Float32Array([0, 0.5, -0.5, 1]).buffer;
    const wav = float32ChunksToWavBytes([
      { audio, sampleCount: 4, silenceAfterSamples: 0 },
    ], 24_000);
    const view = new DataView(wav.buffer);

    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe("WAVE");
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint32(40, true)).toBe(8);
    expect(wav.byteLength).toBe(44 + 4 * 2);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(16384);
    expect(view.getInt16(48, true)).toBe(-16383);
    expect(view.getInt16(50, true)).toBe(32767);
  });

  it("peak-normalizes a single chunk whose samples exceed unity", () => {
    // Mirrors array_to_wav_base64: when peak > 1, scale by the peak before int16
    // conversion so NeuTTS/Kani binary output matches the legacy base64 WAV.
    const audio = new Float32Array([2, -2]).buffer;
    const wav = float32ChunksToWavBytes([
      { audio, sampleCount: 2, silenceAfterSamples: 0 },
    ], 22_050);
    const view = new DataView(wav.buffer);

    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32767);
  });
});
