import { describe, it, expect } from "vitest";
import { buildWavHeader, createWavBlob, createSilence, concatFloat32Arrays } from "./audio";

describe("buildWavHeader", () => {
  it("creates a 44-byte ArrayBuffer", () => {
    const header = buildWavHeader(100, 44100);
    expect(header.byteLength).toBe(44);
  });

  it("starts with RIFF magic bytes", () => {
    const view = new DataView(buildWavHeader(10, 24000));
    const magic = String.fromCharCode(
      view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3),
    );
    expect(magic).toBe("RIFF");
  });

  it("contains WAVE format identifier", () => {
    const view = new DataView(buildWavHeader(10, 24000));
    const format = String.fromCharCode(
      view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11),
    );
    expect(format).toBe("WAVE");
  });

  it("sets AudioFormat to 3 (IEEE Float)", () => {
    const view = new DataView(buildWavHeader(10, 44100));
    expect(view.getUint16(20, true)).toBe(3);
  });

  it("sets NumChannels to 1 (Mono)", () => {
    const view = new DataView(buildWavHeader(10, 44100));
    expect(view.getUint16(22, true)).toBe(1);
  });

  it("uses provided sample rate, not hardcoded", () => {
    const view24k = new DataView(buildWavHeader(10, 24000));
    const view44k = new DataView(buildWavHeader(10, 44100));
    expect(view24k.getUint32(24, true)).toBe(24000);
    expect(view44k.getUint32(24, true)).toBe(44100);
  });

  it("sets BitsPerSample to 32", () => {
    const view = new DataView(buildWavHeader(10, 24000));
    expect(view.getUint16(34, true)).toBe(32);
  });

  it("supports PCM16 header encoding", () => {
    const view = new DataView(buildWavHeader(10, 24000, "pcm16"));
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(20);
  });

  it("supports PCM24 header encoding", () => {
    const view = new DataView(buildWavHeader(10, 24000, "pcm24"));
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(34, true)).toBe(24);
    expect(view.getUint32(40, true)).toBe(30);
  });

  it("calculates correct data sub-chunk size", () => {
    const view = new DataView(buildWavHeader(5, 24000));
    // 5 samples * 4 bytes = 20
    expect(view.getUint32(40, true)).toBe(20);
  });

  it("calculates correct RIFF chunk size", () => {
    const view = new DataView(buildWavHeader(5, 24000));
    // 36 + (5 * 4) = 56
    expect(view.getUint32(4, true)).toBe(56);
  });

  it("calculates byte rate and block align with channel count", () => {
    const view = new DataView(buildWavHeader(5, 24000, "pcm16", 2));
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(28, true)).toBe(24000 * 2 * 2);
    expect(view.getUint16(32, true)).toBe(4);
    expect(view.getUint32(40, true)).toBe(5 * 2 * 2);
  });

  it("rejects invalid WAV channel counts", () => {
    expect(() => buildWavHeader(5, 24000, "float32", 0)).toThrow("channel count");
    expect(() => buildWavHeader(5, 24000, "float32", 1.5)).toThrow("channel count");
  });
});

describe("createWavBlob", () => {
  it("creates a blob with audio/wav MIME type", () => {
    const blob = createWavBlob([new Float32Array([0.5, -0.5])], 24000);
    expect(blob.type).toBe("audio/wav");
  });

  it("creates blob with correct total size (header + data)", () => {
    const chunk1 = new Float32Array([0.1, 0.2]);
    const chunk2 = new Float32Array([0.3, 0.4, 0.5]);
    const blob = createWavBlob([chunk1, chunk2], 24000);
    // 44 bytes header + 5 samples * 4 bytes = 64
    expect(blob.size).toBe(64);
  });

  it("creates PCM16 blob with expected byte size", () => {
    const chunk = new Float32Array([0.25, -0.25, 0]);
    const blob = createWavBlob([chunk], 24000, { encoding: "pcm16" });
    expect(blob.size).toBe(44 + (3 * 2));
  });

  it("creates PCM24 blob with expected byte size", () => {
    const chunk = new Float32Array([0.25, -0.25, 0]);
    const blob = createWavBlob([chunk], 24000, { encoding: "pcm24" });
    expect(blob.size).toBe(44 + (3 * 3));
  });

  it("creates stereo WAV blobs from interleaved samples", () => {
    const chunk = new Float32Array([0.25, -0.25, 0.5, -0.5]);
    const blob = createWavBlob([chunk], 24000, { encoding: "pcm16", channelCount: 2 });
    expect(blob.size).toBe(44 + (4 * 2));
  });

  it("rejects interleaved sample data that does not fit the channel count", () => {
    const chunk = new Float32Array([0.25, -0.25, 0.5]);
    expect(() => createWavBlob([chunk], 24000, { channelCount: 2 })).toThrow("divisible");
  });
});

describe("createSilence", () => {
  it("creates a zero-filled Float32Array of correct length", () => {
    const silence = createSilence(0.5, 24000);
    expect(silence.length).toBe(12000);
    expect(silence.every((v) => v === 0)).toBe(true);
  });

  it("handles different sample rates", () => {
    const silence = createSilence(1.0, 44100);
    expect(silence.length).toBe(44100);
  });

  it("returns zero-length for zero duration", () => {
    const silence = createSilence(0, 24000);
    expect(silence.length).toBe(0);
  });
});

describe("concatFloat32Arrays", () => {
  it("concatenates multiple arrays into one", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([4, 5]);
    const c = new Float32Array([6]);
    const result = concatFloat32Arrays([a, b, c]);
    expect(result).toEqual(new Float32Array([1, 2, 3, 4, 5, 6]));
  });

  it("handles empty input", () => {
    const result = concatFloat32Arrays([]);
    expect(result.length).toBe(0);
  });

  it("handles single array", () => {
    const a = new Float32Array([1, 2, 3]);
    const result = concatFloat32Arrays([a]);
    expect(result).toEqual(a);
  });

  it("preserves Float32 precision", () => {
    const a = new Float32Array([0.1]);
    const b = new Float32Array([0.2]);
    const result = concatFloat32Arrays([a, b]);
    expect(result[0]).toBeCloseTo(0.1, 5);
    expect(result[1]).toBeCloseTo(0.2, 5);
  });
});
