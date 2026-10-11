import { describe, expect, it } from "vitest";
import { createWavBlob } from "./audio";
import { decodeWav, encodeWavPcm16, toStandaloneArrayBuffer } from "./wavCodec";

interface RawWavOptions {
  formatCode?: number;
  channels?: number;
  sampleRate?: number;
  bitsPerSample?: number;
  blockAlign?: number;
  data: Uint8Array;
  declaredDataSize?: number;
  extraChunk?: boolean;
  extensibleSubformat?: number;
  fmtSize?: number;
}

function ascii(target: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) target[offset + index] = text.charCodeAt(index);
}

function rawWav(options: RawWavOptions): Uint8Array {
  const channels = options.channels ?? 1;
  const bits = options.bitsPerSample ?? 16;
  const extensible = options.extensibleSubformat !== undefined;
  const fmtSize = options.fmtSize ?? (extensible ? 40 : 16);
  const extra = options.extraChunk ? 8 + 3 + 1 : 0;
  const total = 12 + 8 + fmtSize + extra + 8 + options.data.byteLength;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  ascii(bytes, 0, "RIFF");
  view.setUint32(4, total - 8, true);
  ascii(bytes, 8, "WAVE");
  let offset = 12;
  if (options.extraChunk) {
    ascii(bytes, offset, "LIST");
    view.setUint32(offset + 4, 3, true);
    offset += 8 + 4; // three bytes plus one pad byte
  }
  ascii(bytes, offset, "fmt ");
  view.setUint32(offset + 4, fmtSize, true);
  view.setUint16(offset + 8, extensible ? 0xfffe : options.formatCode ?? 1, true);
  view.setUint16(offset + 10, channels, true);
  view.setUint32(offset + 12, options.sampleRate ?? 16000, true);
  view.setUint32(offset + 16, (options.sampleRate ?? 16000) * channels * (bits / 8), true);
  view.setUint16(offset + 20, options.blockAlign ?? channels * (bits / 8), true);
  view.setUint16(offset + 22, bits, true);
  if (extensible && fmtSize >= 40) view.setUint16(offset + 32, options.extensibleSubformat!, true);
  offset += 8 + fmtSize;
  ascii(bytes, offset, "data");
  view.setUint32(offset + 4, options.declaredDataSize ?? options.data.byteLength, true);
  bytes.set(options.data, offset + 8);
  return bytes;
}

describe("decodeWav", () => {
  it("round-trips 16-bit mono PCM written by encodeWavPcm16", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const decoded = decodeWav(encodeWavPcm16(samples, 24000));
    expect(decoded.sampleRate).toBe(24000);
    expect(decoded.bitsPerSample).toBe(16);
    expect(decoded.formatCode).toBe(1);
    expect(decoded.channels).toHaveLength(1);
    const [mono] = decoded.channels;
    samples.forEach((value, index) => expect(mono[index]).toBeCloseTo(value, 3));
  });

  it("decodes float32 stereo files from createWavBlob", async () => {
    const blob = createWavBlob([new Float32Array([0.25, -0.25, 0.75, -0.75])], 44100, { channelCount: 2 });
    const decoded = decodeWav(await blob.arrayBuffer());
    expect(decoded.formatCode).toBe(3);
    expect(Array.from(decoded.channels[0])).toEqual([0.25, 0.75]);
    expect(Array.from(decoded.channels[1])).toEqual([-0.25, -0.75]);
  });

  it("decodes 8, 24 and 32-bit integer and 64-bit float samples", () => {
    expect(decodeWav(rawWav({ bitsPerSample: 8, data: new Uint8Array([128, 255, 0]) })).channels[0][2]).toBe(-1);

    const pcm24 = new Uint8Array([0x00, 0x00, 0x40, 0x00, 0x00, 0xc0]);
    const decoded24 = decodeWav(rawWav({ bitsPerSample: 24, data: pcm24 })).channels[0];
    expect(decoded24[0]).toBeCloseTo(0.5, 5);
    expect(decoded24[1]).toBeCloseTo(-0.5, 5);

    const pcm32 = new Uint8Array(4);
    new DataView(pcm32.buffer).setInt32(0, -0x40000000, true);
    expect(decodeWav(rawWav({ bitsPerSample: 32, data: pcm32 })).channels[0][0]).toBeCloseTo(-0.5, 6);

    const float64 = new Uint8Array(16);
    new DataView(float64.buffer).setFloat64(0, 2, true);
    new DataView(float64.buffer).setFloat64(8, Number.NaN, true);
    const decoded64 = decodeWav(rawWav({ formatCode: 3, bitsPerSample: 64, data: float64 })).channels[0];
    expect(Array.from(decoded64)).toEqual([1, 0]);
  });

  it("reads extensible headers, skips unknown chunks and tolerates truncated data", () => {
    const data = new Uint8Array(4);
    new DataView(data.buffer).setInt16(0, 0x4000, true);
    new DataView(data.buffer).setInt16(2, -0x4000, true);
    const decoded = decodeWav(rawWav({ extensibleSubformat: 1, extraChunk: true, data, declaredDataSize: 1000 }));
    expect(Array.from(decoded.channels[0])).toEqual([0.5, -0.5]);
    // A Uint8Array view with an offset decodes the same bytes.
    const padded = new Uint8Array(10 + data.byteLength + 64);
    const wav = rawWav({ data });
    padded.set(wav, 10);
    expect(decodeWav(padded.subarray(10, 10 + wav.byteLength)).channels[0][0]).toBe(0.5);
  });

  it("rejects malformed and unsupported files", () => {
    expect(() => decodeWav(new Uint8Array(8))).toThrow(/not a RIFF/);
    expect(() => decodeWav(rawWav({ formatCode: 2, data: new Uint8Array(2) }))).toThrow(/Only PCM/);
    expect(() => decodeWav(rawWav({ channels: 0, blockAlign: 0, data: new Uint8Array(2) }))).toThrow(/channel count/);
    expect(() => decodeWav(rawWav({ sampleRate: 0, data: new Uint8Array(2) }))).toThrow(/sample rate/);
    expect(() => decodeWav(rawWav({ bitsPerSample: 12, blockAlign: 2, data: new Uint8Array(2) }))).toThrow(/12-bit/);
    expect(() => decodeWav(rawWav({ formatCode: 3, bitsPerSample: 16, data: new Uint8Array(2) }))).toThrow(/16-bit/);
    expect(() => decodeWav(rawWav({ blockAlign: 3, data: new Uint8Array(2) }))).toThrow(/block alignment/);
    expect(() => decodeWav(rawWav({ fmtSize: 14, data: new Uint8Array(2) }))).toThrow(/too short/);
    expect(() => decodeWav(rawWav({ extensibleSubformat: 1, fmtSize: 18, data: new Uint8Array(2) }))).toThrow(/extensible/);

    const noData = rawWav({ data: new Uint8Array(0) });
    expect(() => decodeWav(noData.subarray(0, noData.byteLength - 8))).toThrow(/no audio data/);

    const truncatedFmt = rawWav({ data: new Uint8Array(0) }).subarray(0, 30);
    expect(() => decodeWav(truncatedFmt)).toThrow(/fmt chunk is truncated/);

    const dataFirst = new Uint8Array(20);
    ascii(dataFirst, 0, "RIFF");
    ascii(dataFirst, 8, "WAVE");
    ascii(dataFirst, 12, "data");
    expect(() => decodeWav(dataFirst)).toThrow(/before its fmt/);
  });
});

describe("encodeWavPcm16", () => {
  it("clamps and zeroes non-finite samples", () => {
    const decoded = decodeWav(encodeWavPcm16(new Float32Array([2, Number.NaN, -3]), 8000)).channels[0];
    expect(decoded[0]).toBeCloseTo(1, 3);
    expect(decoded[1]).toBe(0);
    expect(decoded[2]).toBe(-1);
  });

  it("copies bytes into a standalone buffer", () => {
    const source = new Uint8Array([1, 2, 3, 4]).subarray(1, 3);
    const copy = toStandaloneArrayBuffer(source);
    expect(copy.byteLength).toBe(2);
    expect(Array.from(new Uint8Array(copy))).toEqual([2, 3]);
  });
});
