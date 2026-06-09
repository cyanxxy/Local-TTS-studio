import { describe, expect, it } from "vitest";
import { float32ChunksToWavBytes } from "./utils";

describe("localRuntime utils", () => {
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

  it("encodes a single local-runtime chunk with no trailing silence", () => {
    // NeuTTS streams its whole-text waveform as one binary chunk:
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
    // When peak > 1, scale by the peak before int16 conversion so streamed
    // local-runtime Float32 output is preserved without clipping.
    const audio = new Float32Array([2, -2]).buffer;
    const wav = float32ChunksToWavBytes([
      { audio, sampleCount: 2, silenceAfterSamples: 0 },
    ], 22_050);
    const view = new DataView(wav.buffer);

    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32767);
  });
});
