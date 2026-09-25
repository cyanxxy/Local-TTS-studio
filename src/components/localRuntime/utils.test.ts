import { describe, expect, it } from "vitest";
import { float32ChunksToWavBytes, wavDurationSeconds } from "./utils";

describe("localRuntime utils", () => {
  it("reads a WAV duration past extra chunks and ignores non-WAV input", () => {
    const wav = float32ChunksToWavBytes([
      { audio: new Float32Array(48_000).buffer, sampleCount: 48_000, silenceAfterSamples: 24_000 },
    ], 24_000);
    const plain = new ArrayBuffer(wav.byteLength);
    new Uint8Array(plain).set(wav);
    expect(wavDurationSeconds(plain)).toBe(3);

    // Insert an odd-sized LIST chunk (padded to even) between fmt and data.
    const list = new Uint8Array([
      ..."LIST".split("").map((character) => character.charCodeAt(0)),
      3, 0, 0, 0, 1, 2, 3, 0,
    ]);
    const withList = new Uint8Array(wav.byteLength + list.byteLength);
    withList.set(wav.subarray(0, 36));
    withList.set(list, 36);
    withList.set(wav.subarray(36), 36 + list.byteLength);
    expect(wavDurationSeconds(withList.buffer)).toBe(3);

    // A header that declares more data than the file holds reports what is there.
    expect(wavDurationSeconds(plain.slice(0, 44 + 24_000))).toBe(0.5);
    expect(wavDurationSeconds(new TextEncoder().encode("not a wav file").buffer)).toBeNull();
    expect(wavDurationSeconds(new ArrayBuffer(4))).toBeNull();
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

  it("rejects oversized WAV output before allocating the destination buffer", () => {
    expect(() => float32ChunksToWavBytes([
      { audio: new ArrayBuffer(0), sampleCount: 0, silenceAfterSamples: 0x80000000 },
    ], 24_000)).toThrow(/too large/i);
  });

  it("rejects sample rates that would overflow RIFF byte-rate fields", () => {
    expect(() => float32ChunksToWavBytes([
      { audio: new Float32Array([0]).buffer, sampleCount: 1, silenceAfterSamples: 0 },
    ], 0xFFFFFFFF)).toThrow(/byte rate/i);
  });
});
