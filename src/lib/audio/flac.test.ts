import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { floatToPcm16Sample } from "../audio";
import { FlacEncoder, encodeFlac, type FlacBitDepth, type FlacEncodeOptions } from "./flac";

// ---------------------------------------------------------------------------
// Reference decoder: deliberately simple (bit-at-a-time reads, bitwise CRCs)
// and independent of the encoder's tables and helpers.
// ---------------------------------------------------------------------------

type SubframeKind = "constant" | "verbatim" | "fixed";

interface DecodedFrame {
  frameNumber: number;
  blockSize: number;
  blockSizeCode: number;
  sampleRateCode: number;
  byteLength: number;
  kind: SubframeKind;
  order: number;
  method: number;
  partitionOrder: number;
  riceParameters: number[];
}

interface DecodedFlac {
  minBlockSize: number;
  maxBlockSize: number;
  minFrameSize: number;
  maxFrameSize: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  totalSamples: number;
  md5: string;
  samples: Int32Array;
  frames: DecodedFrame[];
}

class BitReader {
  readonly bytes: Uint8Array;
  position = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get bytePosition(): number {
    return this.position / 8;
  }

  read(bits: number): number {
    let value = 0;
    for (let i = 0; i < bits; i += 1) {
      if (this.position >= this.bytes.length * 8) {
        throw new Error("Unexpected end of stream");
      }
      const bit = (this.bytes[this.position >> 3] >> (7 - (this.position & 7))) & 1;
      value = value * 2 + bit;
      this.position += 1;
    }
    return value;
  }

  readSigned(bits: number): number {
    const value = this.read(bits);
    return value >= 2 ** (bits - 1) ? value - 2 ** bits : value;
  }

  readUnary(): number {
    let count = 0;
    while (this.read(1) === 0) {
      count += 1;
    }
    return count;
  }

  readUtf8(): number {
    const first = this.read(8);
    if (first < 0x80) {
      return first;
    }
    let length = 0;
    while ((first << length) & 0x80) {
      length += 1;
    }
    expect(length).toBeGreaterThanOrEqual(2);
    let value = first & (0x7f >> length);
    for (let i = 1; i < length; i += 1) {
      const next = this.read(8);
      expect(next & 0xc0).toBe(0x80);
      value = value * 64 + (next & 0x3f);
    }
    return value;
  }

  alignToByte(): void {
    this.position = Math.ceil(this.position / 8) * 8;
  }
}

function referenceCrc(bytes: Uint8Array, start: number, end: number, polynomial: number, width: number): number {
  const topBit = 1 << (width - 1);
  const mask = (1 << width) - 1;
  let crc = 0;
  for (let i = start; i < end; i += 1) {
    crc ^= bytes[i] << (width - 8);
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & topBit ? ((crc << 1) ^ polynomial) & mask : (crc << 1) & mask;
    }
  }
  return crc;
}

const HEADER_SAMPLE_RATES: Record<number, number> = {
  1: 88200, 2: 176400, 3: 192000, 4: 8000, 5: 16000, 6: 22050,
  7: 24000, 8: 32000, 9: 44100, 10: 48000, 11: 96000,
};
const SAMPLE_SIZES: Record<number, number> = { 4: 16, 6: 24 };
const FIXED_COEFFICIENTS = [[], [1], [2, -1], [3, -3, 1], [4, -6, 4, -1]];

function decodeResidual(reader: BitReader, blockSize: number, order: number, frame: DecodedFrame): number[] {
  frame.method = reader.read(2);
  expect(frame.method).toBeLessThanOrEqual(1);
  frame.partitionOrder = reader.read(4);
  const parameterBits = frame.method === 0 ? 4 : 5;
  const escape = frame.method === 0 ? 15 : 31;
  const partitionSize = blockSize >> frame.partitionOrder;
  expect(partitionSize << frame.partitionOrder).toBe(blockSize);
  const residuals: number[] = [];
  for (let partition = 0; partition < 1 << frame.partitionOrder; partition += 1) {
    const k = reader.read(parameterBits);
    expect(k).not.toBe(escape);
    frame.riceParameters.push(k);
    const count = partition === 0 ? partitionSize - order : partitionSize;
    expect(count).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < count; i += 1) {
      const folded = reader.readUnary() * 2 ** k + reader.read(k);
      residuals.push(folded % 2 === 0 ? folded / 2 : -(folded + 1) / 2);
    }
  }
  return residuals;
}

function decodeFlac(bytes: Uint8Array): DecodedFlac {
  const reader = new BitReader(bytes);
  expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("fLaC");
  reader.position = 32;
  expect(reader.read(1)).toBe(1); // last metadata block
  expect(reader.read(7)).toBe(0); // STREAMINFO
  expect(reader.read(24)).toBe(34);
  const info = {
    minBlockSize: reader.read(16),
    maxBlockSize: reader.read(16),
    minFrameSize: reader.read(24),
    maxFrameSize: reader.read(24),
    sampleRate: reader.read(20),
    channels: reader.read(3) + 1,
    bitsPerSample: reader.read(5) + 1,
    totalSamples: reader.read(36),
    md5: Buffer.from(bytes.subarray(26, 42)).toString("hex"),
  };
  reader.position = 42 * 8;

  const samples: number[] = [];
  const frames: DecodedFrame[] = [];
  while (reader.bytePosition < bytes.length) {
    const start = reader.bytePosition;
    expect(reader.read(14)).toBe(0x3ffe);
    expect(reader.read(1)).toBe(0);
    expect(reader.read(1)).toBe(0); // fixed-blocksize stream
    const blockSizeCode = reader.read(4);
    const sampleRateCode = reader.read(4);
    expect(reader.read(4)).toBe(0); // mono
    const sampleSizeCode = reader.read(3);
    expect(reader.read(1)).toBe(0);
    const frameNumber = reader.readUtf8();

    let blockSize: number;
    if (blockSizeCode === 1) blockSize = 192;
    else if (blockSizeCode >= 2 && blockSizeCode <= 5) blockSize = 576 << (blockSizeCode - 2);
    else if (blockSizeCode === 6) blockSize = reader.read(8) + 1;
    else if (blockSizeCode === 7) blockSize = reader.read(16) + 1;
    else if (blockSizeCode >= 8) blockSize = 256 << (blockSizeCode - 8);
    else throw new Error("Reserved block size code");

    let sampleRate: number;
    if (sampleRateCode === 0) sampleRate = info.sampleRate;
    else if (sampleRateCode <= 11) sampleRate = HEADER_SAMPLE_RATES[sampleRateCode];
    else if (sampleRateCode === 12) sampleRate = reader.read(8) * 1000;
    else if (sampleRateCode === 13) sampleRate = reader.read(16);
    else if (sampleRateCode === 14) sampleRate = reader.read(16) * 10;
    else throw new Error("Invalid sample rate code");
    expect(sampleRate).toBe(info.sampleRate);

    const bps = SAMPLE_SIZES[sampleSizeCode];
    expect(bps).toBe(info.bitsPerSample);

    const headerCrc = referenceCrc(bytes, start, reader.bytePosition, 0x07, 8);
    expect(reader.read(8)).toBe(headerCrc);

    expect(reader.read(1)).toBe(0);
    const type = reader.read(6);
    expect(reader.read(1)).toBe(0); // no wasted bits
    const frame: DecodedFrame = {
      frameNumber, blockSize, blockSizeCode, sampleRateCode, byteLength: 0,
      kind: "constant", order: 0, method: -1, partitionOrder: -1, riceParameters: [],
    };
    const block: number[] = [];
    if (type === 0) {
      const value = reader.readSigned(bps);
      for (let i = 0; i < blockSize; i += 1) block.push(value);
    } else if (type === 1) {
      frame.kind = "verbatim";
      for (let i = 0; i < blockSize; i += 1) block.push(reader.readSigned(bps));
    } else if (type >= 8 && type <= 12) {
      frame.kind = "fixed";
      frame.order = type - 8;
      for (let i = 0; i < frame.order; i += 1) block.push(reader.readSigned(bps));
      const residuals = decodeResidual(reader, blockSize, frame.order, frame);
      const coefficients = FIXED_COEFFICIENTS[frame.order];
      for (const residual of residuals) {
        let prediction = 0;
        for (let j = 0; j < coefficients.length; j += 1) {
          prediction += coefficients[j] * block[block.length - 1 - j];
        }
        block.push(prediction + residual);
      }
    } else {
      throw new Error(`Unsupported subframe type ${type}`);
    }
    expect(block).toHaveLength(blockSize);
    samples.push(...block);

    reader.alignToByte();
    const frameCrc = referenceCrc(bytes, start, reader.bytePosition, 0x8005, 16);
    expect(reader.read(16)).toBe(frameCrc);
    frame.byteLength = reader.bytePosition - start;
    frames.push(frame);
  }
  return { ...info, samples: Int32Array.from(samples), frames };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mirrors floatToPcm16Sample / floatToPcm24 in ../audio.ts. */
function toPcm(samples: Float32Array, bits: FlacBitDepth): Int32Array {
  const negative = 2 ** (bits - 1);
  return Int32Array.from(samples, (value) => {
    const clamped = Math.max(-1, Math.min(1, value));
    return (clamped < 0 ? Math.round(clamped * negative) : Math.round(clamped * (negative - 1))) | 0;
  });
}

function pcmBytes(pcm: Int32Array, bits: FlacBitDepth): Uint8Array {
  const bytesPerSample = bits / 8;
  const bytes = new Uint8Array(pcm.length * bytesPerSample);
  pcm.forEach((sample, i) => {
    for (let b = 0; b < bytesPerSample; b += 1) {
      bytes[i * bytesPerSample + b] = (sample >> (8 * b)) & 0xff;
    }
  });
  return bytes;
}

function md5Hex(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("hex");
}

function sine(length: number, frequency: number, sampleRate: number, amplitude = 0.5): Float32Array {
  return Float32Array.from({ length }, (_, i) => amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate));
}

function seededNoise(length: number, seed: number, amplitude = 1): Float32Array {
  let state = seed >>> 0;
  return Float32Array.from({ length }, () => {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const unit = ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
    return amplitude * (unit * 2 - 1);
  });
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

/** Encodes, decodes and asserts a bit-exact round trip plus consistent STREAMINFO. */
function roundTrip(samples: Float32Array, options: FlacEncodeOptions): DecodedFlac {
  const bits = options.bitsPerSample ?? 16;
  const blockSize = options.blockSize ?? 4096;
  const encoded = encodeFlac(samples, options);
  const decoded = decodeFlac(encoded);
  const expected = toPcm(samples, bits);
  expect(decoded.samples).toEqual(expected);
  expect(decoded.sampleRate).toBe(options.sampleRate);
  expect(decoded.channels).toBe(1);
  expect(decoded.bitsPerSample).toBe(bits);
  expect(decoded.minBlockSize).toBe(blockSize);
  expect(decoded.maxBlockSize).toBe(blockSize);
  expect(decoded.totalSamples).toBe(samples.length);
  expect(decoded.md5).toBe(md5Hex(pcmBytes(expected, bits)));
  expect(decoded.frames.map((frame) => frame.frameNumber)).toEqual(decoded.frames.map((_, i) => i));
  if (decoded.frames.length > 0) {
    const sizes = decoded.frames.map((frame) => frame.byteLength);
    expect(decoded.minFrameSize).toBe(Math.min(...sizes));
    expect(decoded.maxFrameSize).toBe(Math.max(...sizes));
  }
  return decoded;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("encodeFlac", () => {
  it("round-trips a 440 Hz sine at 24 kHz / 16-bit with real compression", () => {
    const samples = sine(48000, 440, 24000);
    const decoded = roundTrip(samples, { sampleRate: 24000 });
    expect(decoded.frames.every((frame) => frame.kind === "fixed")).toBe(true);
    expect(decoded.frames[0].sampleRateCode).toBe(7);
    expect(decoded.frames[0].blockSizeCode).toBe(12);
    // The conversion matches the WAV writer's PCM16 path sample for sample.
    expect(Array.from(decoded.samples.subarray(0, 64))).toEqual(
      Array.from(samples.subarray(0, 64), floatToPcm16Sample),
    );
    const encoded = encodeFlac(samples, { sampleRate: 24000 });
    expect(encoded.length).toBeLessThan(samples.length * 2 * 0.4);
  });

  it("round-trips seeded white noise at 48 kHz / 24-bit using verbatim and method 1", () => {
    const loud = roundTrip(seededNoise(9000, 1), { sampleRate: 48000, bitsPerSample: 24 });
    expect(loud.frames.some((frame) => frame.kind === "verbatim")).toBe(true);

    const quiet = roundTrip(seededNoise(9000, 2, 0.05), { sampleRate: 48000, bitsPerSample: 24 });
    const method1 = quiet.frames.filter((frame) => frame.kind === "fixed" && frame.method === 1);
    expect(method1.length).toBeGreaterThan(0);
    expect(Math.max(...method1.flatMap((frame) => frame.riceParameters))).toBeGreaterThan(14);
  });

  it("round-trips a 24-bit high-frequency square wave with long Rice codes", () => {
    // Full-scale alternation drives order-4 residuals near 2^27.
    const samples = Float32Array.from({ length: 2048 }, (_, i) => (i % 2 === 0 ? 1 : -1) * (i % 7 === 0 ? 0.3 : 1));
    roundTrip(samples, { sampleRate: 96000, bitsPerSample: 24, blockSize: 1024 });
  });

  it("codes silence with CONSTANT subframes", () => {
    const samples = new Float32Array(20000);
    const decoded = roundTrip(samples, { sampleRate: 44100 });
    expect(decoded.frames.every((frame) => frame.kind === "constant")).toBe(true);
    expect(encodeFlac(samples, { sampleRate: 44100 }).length).toBeLessThan(200);
  });

  it("round-trips a step signal", () => {
    const samples = Float32Array.from({ length: 12000 }, (_, i) => (Math.floor(i / 1500) % 3) * 0.4 - 0.4);
    const decoded = roundTrip(samples, { sampleRate: 16000, blockSize: 1000 });
    expect(decoded.frames.some((frame) => frame.kind === "constant")).toBe(true);
    expect(decoded.frames.some((frame) => frame.kind === "fixed")).toBe(true);
    expect(decoded.frames[0].blockSizeCode).toBe(7);
  });

  it("encodes a final partial block when the length is not a multiple of the block size", () => {
    const decoded = roundTrip(sine(10000, 300, 22050), { sampleRate: 22050 });
    expect(decoded.frames.map((frame) => frame.blockSize)).toEqual([4096, 4096, 1808]);
  });

  it("handles tiny inputs", () => {
    const one = roundTrip(Float32Array.of(0.25), { sampleRate: 8000 });
    expect(one.frames).toHaveLength(1);
    expect(one.frames[0]).toMatchObject({ blockSize: 1, kind: "constant", blockSizeCode: 6 });

    const fifteen = roundTrip(sine(15, 1000, 8000, 0.9), { sampleRate: 8000 });
    expect(fifteen.frames).toHaveLength(1);
    expect(fifteen.frames[0]).toMatchObject({ blockSize: 15, blockSizeCode: 6 });

    roundTrip(Float32Array.of(0.1, -0.1), { sampleRate: 8000 });
  });

  it("returns a valid header-only stream for empty input", () => {
    const encoded = encodeFlac(new Float32Array(0), { sampleRate: 24000 });
    expect(encoded).toHaveLength(42);
    const decoded = roundTrip(new Float32Array(0), { sampleRate: 24000 });
    expect(decoded.frames).toHaveLength(0);
    expect(decoded.totalSamples).toBe(0);
    expect(decoded.minFrameSize).toBe(0);
    expect(decoded.maxFrameSize).toBe(0);
  });

  it.each([
    [22050, 6],
    [11025, 13],
    [16000, 5],
    [8000, 4],
    [37800, 13],
    [12000, 12],
    [100000, 12],
    [256000, 14],
    [655350, 14],
    [100001, 0],
    [44100, 9],
    [48000, 10],
    [32000, 8],
    [88200, 1],
    [96000, 11],
    [176400, 2],
    [192000, 3],
    [1, 13],
  ])("round-trips at %i Hz (frame header rate code %i)", (sampleRate, code) => {
    const decoded = roundTrip(sine(700, 50, 8000, 0.7), { sampleRate, blockSize: 256 });
    expect(decoded.frames.every((frame) => frame.sampleRateCode === code)).toBe(true);
  });

  it.each([
    [192, 1],
    [576, 2],
    [1152, 3],
    [2304, 4],
    [4608, 5],
    [100, 6],
    [256, 8],
    [512, 9],
    [2048, 11],
    [4096, 12],
    [8192, 13],
    [16384, 14],
    [32768, 15],
    [65535, 7],
    [16, 6],
  ])("uses block size %i with frame header code %i", (blockSize, code) => {
    const decoded = roundTrip(sine(blockSize * 2 + 3, 440, 48000), { sampleRate: 48000, blockSize });
    expect(decoded.frames[0].blockSizeCode).toBe(code);
    expect(decoded.frames[0].blockSize).toBe(blockSize);
  });

  it("codes frame numbers with multi-byte UTF-8", () => {
    const decoded = roundTrip(sine(16 * 2100, 440, 48000), { sampleRate: 48000, blockSize: 16 });
    expect(decoded.frames).toHaveLength(2100);
    expect(decoded.frames[2099].frameNumber).toBe(2099);
  });

  it("clips out-of-range floats like the WAV writer and maps NaN to zero", () => {
    const samples = Float32Array.of(2, -3, 1, -1, 1.5, -1.0001, Number.NaN, 0.5);
    const decoded16 = roundTrip(samples, { sampleRate: 24000 });
    expect(Array.from(decoded16.samples)).toEqual([32767, -32768, 32767, -32768, 32767, -32768, 0, 16384]);
    const decoded24 = roundTrip(samples, { sampleRate: 24000, bitsPerSample: 24 });
    expect(Array.from(decoded24.samples.subarray(0, 7))).toEqual([
      8388607, -8388608, 8388607, -8388608, 8388607, -8388608, 0,
    ]);
  });

  it("stores the MD5 of the signed little-endian PCM bytes", () => {
    // Covers every MD5 tail length (byte count mod 64) and multi-block input.
    for (const bits of [16, 24] as const) {
      for (let length = 0; length <= 45; length += 1) {
        const samples = seededNoise(length, length + bits, 0.8);
        const encoded = encodeFlac(samples, { sampleRate: 16000, bitsPerSample: bits, blockSize: 16 });
        const md5 = Buffer.from(encoded.subarray(26, 42)).toString("hex");
        expect(md5).toBe(md5Hex(pcmBytes(toPcm(samples, bits), bits)));
      }
    }
    const long = seededNoise(70000, 9, 0.3);
    const encoded = encodeFlac(long, { sampleRate: 48000, bitsPerSample: 24 });
    expect(Buffer.from(encoded.subarray(26, 42)).toString("hex")).toBe(md5Hex(pcmBytes(toPcm(long, 24), 24)));
  });
});

describe("FlacEncoder", () => {
  it("streams irregular chunks into bytes identical to encodeFlac", () => {
    const samples = sine(30000, 523.25, 24000, 0.6);
    const options: FlacEncodeOptions = { sampleRate: 24000, blockSize: 1152 };
    const encoder = new FlacEncoder(options);
    const chunks: Uint8Array[] = [];
    const sizes = [0, 1, 7, 1151, 1, 4000, 333, 2304, 9000];
    let offset = 0;
    let call = 0;
    while (offset < samples.length) {
      const size = sizes[call % sizes.length];
      chunks.push(...encoder.encode(samples.subarray(offset, offset + size)));
      offset += size;
      call += 1;
    }
    chunks.push(...encoder.finish());

    const streamed = concat(chunks);
    const header = decodeFlac(streamed);
    expect(header.totalSamples).toBe(0);
    expect(header.md5).toBe("0".repeat(32));
    expect(header.samples).toEqual(toPcm(samples, 16));

    const info = encoder.streamInfo();
    expect(info).toHaveLength(38);
    expect(FlacEncoder.STREAMINFO_OFFSET).toBe(4);
    streamed.set(info, FlacEncoder.STREAMINFO_OFFSET);
    expect(streamed).toEqual(encodeFlac(samples, options));
  });

  it("emits the header on the first encode() call even without full blocks", () => {
    const encoder = new FlacEncoder({ sampleRate: 48000 });
    const first = encoder.encode(new Float32Array(10));
    expect(first).toHaveLength(1);
    expect(first[0]).toHaveLength(42);
    expect(encoder.encode(new Float32Array(10))).toEqual([]);
    const rest = encoder.finish();
    expect(rest).toHaveLength(1);
    expect(decodeFlac(concat([...first, ...rest])).samples).toHaveLength(20);
  });

  it("returns the header from finish() when encode() was never called", () => {
    const encoder = new FlacEncoder({ sampleRate: 48000 });
    const chunks = encoder.finish();
    expect(chunks).toHaveLength(1);
    const stream = chunks[0];
    stream.set(encoder.streamInfo(), FlacEncoder.STREAMINFO_OFFSET);
    expect(stream).toEqual(encodeFlac(new Float32Array(0), { sampleRate: 48000 }));
  });

  it("reports STREAMINFO progress before finish()", () => {
    const encoder = new FlacEncoder({ sampleRate: 24000, blockSize: 16 });
    encoder.encode(new Float32Array(40));
    const decoded = decodeFlac(concat([new Uint8Array([0x66, 0x4c, 0x61, 0x43]), encoder.streamInfo()]));
    expect(decoded.totalSamples).toBe(32);
    expect(decoded.md5).toBe(md5Hex(new Uint8Array(64)));
  });

  it("rejects input after finish()", () => {
    const encoder = new FlacEncoder({ sampleRate: 24000 });
    encoder.finish();
    expect(() => encoder.encode(new Float32Array(1))).toThrow(/after finish/);
    expect(() => encoder.finish()).toThrow(/after finish/);
  });

  it("validates options", () => {
    expect(() => new FlacEncoder({ sampleRate: 655351 })).toThrow(/sample rate/);
    expect(() => new FlacEncoder({ sampleRate: 0 })).toThrow(/sample rate/);
    expect(() => new FlacEncoder({ sampleRate: 44100.5 })).toThrow(/sample rate/);
    expect(() => encodeFlac(new Float32Array(1), { sampleRate: Number.NaN })).toThrow(/sample rate/);
    expect(() => new FlacEncoder({ sampleRate: 24000, bitsPerSample: 32 as FlacBitDepth })).toThrow(/16 or 24/);
    expect(() => new FlacEncoder({ sampleRate: 24000, bitsPerSample: 8 as FlacBitDepth })).toThrow(/16 or 24/);
    expect(() => new FlacEncoder({ sampleRate: 24000, blockSize: 15 })).toThrow(/block size/);
    expect(() => new FlacEncoder({ sampleRate: 24000, blockSize: 65536 })).toThrow(/block size/);
    expect(() => new FlacEncoder({ sampleRate: 24000, blockSize: 100.5 })).toThrow(/block size/);
    expect(() => new FlacEncoder({ sampleRate: 655350, bitsPerSample: 24, blockSize: 65535 })).not.toThrow();
  });
});
