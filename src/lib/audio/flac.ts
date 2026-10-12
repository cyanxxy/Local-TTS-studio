/**
 * Dependency-free FLAC encoder for mono audio (RFC 9639 subset).
 *
 * Each block is coded with the cheapest of CONSTANT, FIXED (orders 0-4) and
 * VERBATIM subframes. FIXED residuals use partitioned Rice coding with the
 * partition order and per-partition parameters chosen by exact bit cost.
 */

export type FlacBitDepth = 16 | 24;

export interface FlacEncodeOptions {
  sampleRate: number;
  bitsPerSample?: FlacBitDepth;
  blockSize?: number;
}

const DEFAULT_BITS_PER_SAMPLE: FlacBitDepth = 16;
const DEFAULT_BLOCK_SIZE = 4096;
const MIN_BLOCK_SIZE = 16;
const MAX_BLOCK_SIZE = 65535;
const MAX_SAMPLE_RATE = 655350;
const MAX_FIXED_ORDER = 4;
const MAX_PARTITION_ORDER = 8;
// Rice parameters above 14 need residual coding method 1 (5-bit parameters);
// 15 is the method 0 escape code.
const MAX_METHOD0_RICE_PARAMETER = 14;
const STREAMINFO_BLOCK_LENGTH = 38;
const FLAC_MARKER = [0x66, 0x4c, 0x61, 0x43]; // "fLaC"
const ZERO_MD5 = new Uint8Array(16);

// Frame header block size codes that need no trailing size field.
const STANDARD_BLOCK_SIZES = new Map<number, number>([
  [192, 1],
  [576, 2],
  [1152, 3],
  [2304, 4],
  [4608, 5],
  [256, 8],
  [512, 9],
  [1024, 10],
  [2048, 11],
  [4096, 12],
  [8192, 13],
  [16384, 14],
  [32768, 15],
]);

const STANDARD_SAMPLE_RATES = new Map<number, number>([
  [88200, 1],
  [176400, 2],
  [192000, 3],
  [8000, 4],
  [16000, 5],
  [22050, 6],
  [24000, 7],
  [32000, 8],
  [44100, 9],
  [48000, 10],
  [96000, 11],
]);

interface SampleRateHeader {
  code: number;
  /** Width of the trailing end-of-header sample rate field (0 = none). */
  bits: number;
  value: number;
}

function sampleRateHeader(sampleRate: number): SampleRateHeader {
  const standard = STANDARD_SAMPLE_RATES.get(sampleRate);
  if (standard !== undefined) {
    return { code: standard, bits: 0, value: 0 };
  }
  if (sampleRate % 1000 === 0 && sampleRate <= 255000) {
    return { code: 12, bits: 8, value: sampleRate / 1000 };
  }
  if (sampleRate <= 65535) {
    return { code: 13, bits: 16, value: sampleRate };
  }
  if (sampleRate % 10 === 0) {
    // sampleRate <= 655350, so the tens-of-Hz value always fits 16 bits.
    return { code: 14, bits: 16, value: sampleRate / 10 };
  }
  // Not representable in the frame header: decoders read it from STREAMINFO.
  return { code: 0, bits: 0, value: 0 };
}

function blockSizeCode(blockSize: number): number {
  const standard = STANDARD_BLOCK_SIZES.get(blockSize);
  if (standard !== undefined) {
    return standard;
  }
  // 6: 8-bit (blockSize - 1) after the frame number; 7: 16-bit.
  return blockSize <= 256 ? 6 : 7;
}

function buildCrcTable(polynomial: number, width: 8 | 16): Uint16Array {
  const table = new Uint16Array(256);
  const topBit = 1 << (width - 1);
  const mask = (1 << width) - 1;
  for (let i = 0; i < 256; i += 1) {
    let crc = i << (width - 8);
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & topBit ? ((crc << 1) ^ polynomial) & mask : (crc << 1) & mask;
    }
    table[i] = crc;
  }
  return table;
}

const CRC8_TABLE = buildCrcTable(0x07, 8);
const CRC16_TABLE = buildCrcTable(0x8005, 16);

function crc8(bytes: Uint8Array, end: number): number {
  let crc = 0;
  for (let i = 0; i < end; i += 1) {
    crc = CRC8_TABLE[crc ^ bytes[i]];
  }
  return crc;
}

function crc16(bytes: Uint8Array, end: number): number {
  let crc = 0;
  for (let i = 0; i < end; i += 1) {
    crc = ((crc << 8) & 0xffff) ^ CRC16_TABLE[(crc >> 8) ^ bytes[i]];
  }
  return crc;
}

/** MSB-first bit writer over a fixed buffer sized for the worst-case frame. */
class BitWriter {
  readonly bytes: Uint8Array;
  position = 0;
  private accumulator = 0;
  private accumulatorBits = 0;

  constructor(capacity: number) {
    this.bytes = new Uint8Array(capacity);
  }

  reset(): void {
    this.position = 0;
    this.accumulator = 0;
    this.accumulatorBits = 0;
  }

  /** Writes the low `bits` bits of a non-negative `value` (bits <= 32). */
  write(value: number, bits: number): void {
    if (bits > 24) {
      // Keep the accumulator below 2^31 so 32-bit shifts stay exact.
      this.write(Math.floor(value / 65536), bits - 16);
      this.write(value % 65536, 16);
      return;
    }
    const accumulator = (this.accumulator << bits) | value;
    let accumulatorBits = this.accumulatorBits + bits;
    while (accumulatorBits >= 8) {
      accumulatorBits -= 8;
      // Uint8Array stores the value modulo 256.
      this.bytes[this.position] = accumulator >>> accumulatorBits;
      this.position += 1;
    }
    this.accumulator = accumulator & ((1 << accumulatorBits) - 1);
    this.accumulatorBits = accumulatorBits;
  }

  writeZeros(count: number): void {
    let remaining = count;
    while (remaining > 24) {
      this.write(0, 24);
      remaining -= 24;
    }
    this.write(0, remaining);
  }

  alignToByte(): void {
    this.write(0, (8 - this.accumulatorBits) & 7);
  }
}

/** FLAC "UTF-8" coding of the frame number (extended to 36 bits by the spec). */
function writeUtf8Number(writer: BitWriter, value: number): void {
  if (value < 0x80) {
    writer.write(value, 8);
    return;
  }
  let byteCount = 2;
  while (value >= 2 ** (5 * byteCount + 1)) {
    byteCount += 1;
  }
  const leadingBits = (0xff00 >> byteCount) & 0xff;
  writer.write(leadingBits | Math.floor(value / 2 ** (6 * (byteCount - 1))), 8);
  for (let i = byteCount - 2; i >= 0; i -= 1) {
    writer.write(0x80 | (Math.floor(value / 2 ** (6 * i)) & 0x3f), 8);
  }
}

const MD5_SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_CONSTANTS = Int32Array.from(
  { length: 64 },
  (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32),
);

function md5Block(state: Int32Array, block: Uint8Array, words: Int32Array): void {
  for (let i = 0; i < 16; i += 1) {
    const offset = i * 4;
    words[i] = block[offset]
      | (block[offset + 1] << 8)
      | (block[offset + 2] << 16)
      | (block[offset + 3] << 24);
  }
  let a = state[0];
  let b = state[1];
  let c = state[2];
  let d = state[3];
  for (let i = 0; i < 64; i += 1) {
    let f: number;
    let g: number;
    if (i < 16) {
      f = (b & c) | (~b & d);
      g = i;
    } else if (i < 32) {
      f = (d & b) | (~d & c);
      g = (5 * i + 1) & 15;
    } else if (i < 48) {
      f = b ^ c ^ d;
      g = (3 * i + 5) & 15;
    } else {
      f = c ^ (b | ~d);
      g = (7 * i) & 15;
    }
    const next = d;
    d = c;
    c = b;
    const sum = (a + f + MD5_CONSTANTS[i] + words[g]) | 0;
    const shift = MD5_SHIFTS[(i >> 4) * 4 + (i & 3)];
    b = (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0;
    a = next;
  }
  state[0] = (state[0] + a) | 0;
  state[1] = (state[1] + b) | 0;
  state[2] = (state[2] + c) | 0;
  state[3] = (state[3] + d) | 0;
}

/** Incremental MD5 (RFC 1321) whose digest() does not end the stream. */
class Md5 {
  private readonly state = Int32Array.of(0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476);
  private readonly buffer = new Uint8Array(64);
  private readonly words = new Int32Array(16);
  private bufferLength = 0;
  private byteCount = 0;

  update(data: Uint8Array, length: number): void {
    for (let i = 0; i < length; i += 1) {
      this.buffer[this.bufferLength] = data[i];
      this.bufferLength += 1;
      if (this.bufferLength === 64) {
        md5Block(this.state, this.buffer, this.words);
        this.bufferLength = 0;
      }
    }
    this.byteCount += length;
  }

  digest(): Uint8Array {
    const state = this.state.slice();
    const block = new Uint8Array(64);
    block.set(this.buffer.subarray(0, this.bufferLength));
    block[this.bufferLength] = 0x80;
    if (this.bufferLength >= 56) {
      md5Block(state, block, this.words);
      block.fill(0);
    }
    const bitLength = this.byteCount * 8;
    const view = new DataView(block.buffer);
    view.setUint32(56, bitLength % 2 ** 32, true);
    view.setUint32(60, Math.floor(bitLength / 2 ** 32), true);
    md5Block(state, block, this.words);
    const digest = new Uint8Array(16);
    const digestView = new DataView(digest.buffer);
    for (let i = 0; i < 4; i += 1) {
      digestView.setInt32(i * 4, state[i], true);
    }
    return digest;
  }
}

/** Exact Rice cost of residuals [start, end) with parameter k. */
function riceBits(residuals: Uint32Array, start: number, end: number, k: number): number {
  let bits = (end - start) * (k + 1);
  for (let i = start; i < end; i += 1) {
    bits += residuals[i] >>> k;
  }
  return bits;
}

/**
 * Stores the cheapest Rice parameter for residuals [start, end) in
 * parameters[index] and returns its exact bit cost.
 *
 * With cost(k) = sum(u >> k) + n(k + 1), cost(k) - cost(k + 1) is
 * non-increasing in k (the cost is convex) and exceeds sum / 2^(k+1) - 1.5n.
 * The first loop finds a starting k that is no larger than the optimum; the
 * second ascends until the cost stops falling. Residuals are below 2^29, so k
 * never exceeds 28 and always fits method 1's 5-bit parameter.
 */
function optimalRiceParameter(
  residuals: Uint32Array,
  start: number,
  end: number,
  sum: number,
  parameters: Int32Array,
  index: number,
): number {
  const count = end - start;
  let k = 0;
  while (3 * count * 2 ** k < sum) {
    k += 1;
  }
  let bits = riceBits(residuals, start, end, k);
  for (;;) {
    const next = riceBits(residuals, start, end, k + 1);
    if (next >= bits) {
      break;
    }
    k += 1;
    bits = next;
  }
  parameters[index] = k;
  return bits;
}

/** Streaming encoder: push Float32 samples in any chunk sizes, get FLAC byte chunks back. */
export class FlacEncoder {
  /** Byte offset of the STREAMINFO block header in the stream (always 4). */
  static readonly STREAMINFO_OFFSET = 4 as const;

  private readonly sampleRate: number;
  private readonly bitsPerSample: FlacBitDepth;
  private readonly blockSize: number;
  private readonly bytesPerSample: number;
  private readonly sampleMask: number;
  private readonly positiveScale: number;
  private readonly negativeScale: number;
  private readonly sampleSizeCode: number;
  private readonly rateHeader: SampleRateHeader;

  private readonly pending: Int32Array;
  private pendingLength = 0;
  private readonly writer: BitWriter;
  private readonly md5 = new Md5();
  private readonly md5Bytes: Uint8Array;

  private readonly differences: Int32Array;
  private readonly residuals: Uint32Array[] = [];
  private readonly prefixSums: Float64Array;
  private readonly trialParameters = new Int32Array(1 << MAX_PARTITION_ORDER);
  private readonly candidateParameters = new Int32Array(1 << MAX_PARTITION_ORDER);
  private readonly bestParameters = new Int32Array(1 << MAX_PARTITION_ORDER);
  private candidatePartitionOrder = 0;
  private candidateMethod = 0;

  private totalSamples = 0;
  private frameNumber = 0;
  private minFrameSize = 0;
  private maxFrameSize = 0;
  private headerEmitted = false;
  private finished = false;

  constructor(options: FlacEncodeOptions) {
    const { sampleRate } = options;
    const bitsPerSample = options.bitsPerSample ?? DEFAULT_BITS_PER_SAMPLE;
    const blockSize = options.blockSize ?? DEFAULT_BLOCK_SIZE;
    if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > MAX_SAMPLE_RATE) {
      throw new Error(
        `FLAC sample rate must be an integer from 1 to ${MAX_SAMPLE_RATE} Hz; got ${sampleRate}.`,
      );
    }
    if (bitsPerSample !== 16 && bitsPerSample !== 24) {
      throw new Error(`FLAC bits per sample must be 16 or 24; got ${String(bitsPerSample)}.`);
    }
    if (!Number.isInteger(blockSize) || blockSize < MIN_BLOCK_SIZE || blockSize > MAX_BLOCK_SIZE) {
      throw new Error(
        `FLAC block size must be an integer from ${MIN_BLOCK_SIZE} to ${MAX_BLOCK_SIZE}; got ${blockSize}.`,
      );
    }

    this.sampleRate = sampleRate;
    this.bitsPerSample = bitsPerSample;
    this.blockSize = blockSize;
    this.bytesPerSample = bitsPerSample / 8;
    this.sampleMask = 2 ** bitsPerSample - 1;
    this.negativeScale = 2 ** (bitsPerSample - 1);
    this.positiveScale = this.negativeScale - 1;
    this.sampleSizeCode = bitsPerSample === 16 ? 0b100 : 0b110;
    this.rateHeader = sampleRateHeader(sampleRate);

    this.pending = new Int32Array(blockSize);
    // Header <= 16 bytes, subframe <= 1 + verbatim payload, then padding + CRC-16.
    this.writer = new BitWriter(blockSize * this.bytesPerSample + 32);
    this.md5Bytes = new Uint8Array(blockSize * this.bytesPerSample);
    this.differences = new Int32Array(blockSize);
    for (let order = 0; order <= MAX_FIXED_ORDER; order += 1) {
      this.residuals.push(new Uint32Array(blockSize));
    }
    this.prefixSums = new Float64Array(blockSize + 1);
  }

  /** Encodes as many full blocks as possible; returns zero or more byte arrays (the first call also returns the fLaC marker + STREAMINFO). */
  encode(samples: Float32Array): Uint8Array[] {
    this.assertOpen();
    const output = this.takeHeader();
    const { pending, blockSize, positiveScale, negativeScale } = this;
    let pendingLength = this.pendingLength;
    for (let i = 0; i < samples.length; i += 1) {
      // Same conversion as the WAV writer in ../audio.ts; `| 0` maps NaN to 0
      // exactly like DataView.setInt16 does there.
      const clamped = Math.max(-1, Math.min(1, samples[i]));
      pending[pendingLength] = (clamped < 0
        ? Math.round(clamped * negativeScale)
        : Math.round(clamped * positiveScale)) | 0;
      pendingLength += 1;
      if (pendingLength === blockSize) {
        output.push(this.encodeFrame(blockSize));
        pendingLength = 0;
      }
    }
    this.pendingLength = pendingLength;
    return output;
  }

  /** Encodes the final partial block and returns remaining bytes (including the marker + STREAMINFO if encode() was never called). After finish(), call streamInfo() to get the final STREAMINFO metadata block (with total samples, min/max frame sizes, MD5) so callers can patch the header. */
  finish(): Uint8Array[] {
    this.assertOpen();
    const output = this.takeHeader();
    if (this.pendingLength > 0) {
      output.push(this.encodeFrame(this.pendingLength));
      this.pendingLength = 0;
    }
    this.finished = true;
    return output;
  }

  /** 38 bytes: METADATA_BLOCK_HEADER (last-block flag set, type 0, length 34) + STREAMINFO body, reflecting everything encoded so far. */
  streamInfo(): Uint8Array {
    return this.buildStreamInfo(this.md5.digest());
  }

  private assertOpen(): void {
    if (this.finished) {
      throw new Error("FlacEncoder cannot accept more input after finish().");
    }
  }

  private takeHeader(): Uint8Array[] {
    if (this.headerEmitted) {
      return [];
    }
    this.headerEmitted = true;
    const header = new Uint8Array(FLAC_MARKER.length + STREAMINFO_BLOCK_LENGTH);
    header.set(FLAC_MARKER);
    // Placeholder: zero totals, frame sizes and MD5 all mean "unknown".
    header.set(this.buildStreamInfo(ZERO_MD5), FlacEncoder.STREAMINFO_OFFSET);
    return [header];
  }

  private buildStreamInfo(md5: Uint8Array): Uint8Array {
    const writer = new BitWriter(STREAMINFO_BLOCK_LENGTH);
    writer.write(0x80, 8); // last-metadata-block flag + type 0 (STREAMINFO)
    writer.write(34, 24);
    writer.write(this.blockSize, 16);
    writer.write(this.blockSize, 16);
    writer.write(this.minFrameSize, 24);
    writer.write(this.maxFrameSize, 24);
    writer.write(this.sampleRate, 20);
    writer.write(0, 3); // channels - 1
    writer.write(this.bitsPerSample - 1, 5);
    writer.write(Math.floor(this.totalSamples / 2 ** 32), 4);
    writer.write(this.totalSamples % 2 ** 32, 32);
    writer.bytes.set(md5, writer.position);
    return writer.bytes;
  }

  private encodeFrame(blockSize: number): Uint8Array {
    const { pending, md5Bytes, bytesPerSample, writer } = this;

    // STREAMINFO MD5 covers the signed little-endian sample bytes.
    let byteIndex = 0;
    for (let i = 0; i < blockSize; i += 1) {
      const sample = pending[i];
      for (let shift = 0; shift < bytesPerSample * 8; shift += 8) {
        md5Bytes[byteIndex] = sample >> shift;
        byteIndex += 1;
      }
    }
    this.md5.update(md5Bytes, byteIndex);

    writer.reset();
    // Sync code 0b11111111111110, reserved 0, fixed-blocksize strategy 0.
    writer.write(0xfff8, 16);
    const sizeCode = blockSizeCode(blockSize);
    writer.write(sizeCode, 4);
    writer.write(this.rateHeader.code, 4);
    writer.write(0, 4); // channel assignment: mono
    writer.write(this.sampleSizeCode << 1, 4); // + reserved 0 bit
    writeUtf8Number(writer, this.frameNumber);
    if (sizeCode === 6) {
      writer.write(blockSize - 1, 8);
    } else if (sizeCode === 7) {
      writer.write(blockSize - 1, 16);
    }
    if (this.rateHeader.bits > 0) {
      writer.write(this.rateHeader.value, this.rateHeader.bits);
    }
    writer.write(crc8(writer.bytes, writer.position), 8);

    this.writeSubframe(blockSize);
    writer.alignToByte();
    writer.write(crc16(writer.bytes, writer.position), 16);

    const frame = writer.bytes.slice(0, writer.position);
    this.minFrameSize = this.maxFrameSize === 0
      ? frame.length
      : Math.min(this.minFrameSize, frame.length);
    this.maxFrameSize = Math.max(this.maxFrameSize, frame.length);
    this.totalSamples += blockSize;
    this.frameNumber += 1;
    return frame;
  }

  private writeSubframe(blockSize: number): void {
    const { pending, writer, bitsPerSample, sampleMask } = this;

    let constant = true;
    for (let i = 1; i < blockSize; i += 1) {
      if (pending[i] !== pending[0]) {
        constant = false;
        break;
      }
    }
    if (constant) {
      writer.write(0, 8); // pad 0, type 000000 (CONSTANT), wasted-bits flag 0
      writer.write(pending[0] & sampleMask, bitsPerSample);
      return;
    }

    // Costs exclude the shared 8-bit subframe header.
    let bestBits = blockSize * bitsPerSample;
    let bestOrder = -1;
    let bestMethod = 0;
    let bestPartitionOrder = 0;
    const differences = this.differences;
    differences.set(pending.subarray(0, blockSize));
    const maxOrder = Math.min(MAX_FIXED_ORDER, blockSize - 1);
    for (let order = 0; order <= maxOrder; order += 1) {
      // differences[i] (i >= order) is the order-th difference, i.e. the FIXED
      // predictor residual. Bounded by 16 * 2^23 = 2^27 for 24-bit input.
      const residuals = this.residuals[order];
      for (let i = order; i < blockSize; i += 1) {
        const residual = differences[i];
        residuals[i] = residual < 0 ? -2 * residual - 1 : 2 * residual;
      }
      const bits = order * bitsPerSample + this.searchPartitions(residuals, order, blockSize);
      if (bits < bestBits) {
        bestBits = bits;
        bestOrder = order;
        bestMethod = this.candidateMethod;
        bestPartitionOrder = this.candidatePartitionOrder;
        this.bestParameters.set(this.candidateParameters.subarray(0, 1 << bestPartitionOrder));
      }
      for (let i = blockSize - 1; i > order; i -= 1) {
        differences[i] -= differences[i - 1];
      }
    }

    if (bestOrder < 0) {
      writer.write(0b10, 8); // pad 0, type 000001 (VERBATIM), wasted-bits flag 0
      for (let i = 0; i < blockSize; i += 1) {
        writer.write(pending[i] & sampleMask, bitsPerSample);
      }
      return;
    }

    writer.write((0b1000 | bestOrder) << 1, 8); // pad 0, type 001xxx (FIXED), wasted 0
    for (let i = 0; i < bestOrder; i += 1) {
      writer.write(pending[i] & sampleMask, bitsPerSample);
    }
    writer.write(bestMethod, 2);
    writer.write(bestPartitionOrder, 4);
    const residuals = this.residuals[bestOrder];
    const parameterBits = 4 + bestMethod;
    const partitionSize = blockSize >> bestPartitionOrder;
    const partitionCount = 1 << bestPartitionOrder;
    for (let partition = 0; partition < partitionCount; partition += 1) {
      const k = this.bestParameters[partition];
      writer.write(k, parameterBits);
      const end = (partition + 1) * partitionSize;
      for (let i = Math.max(bestOrder, partition * partitionSize); i < end; i += 1) {
        const value = residuals[i];
        const quotient = value >>> k;
        const remainder = value & ((1 << k) - 1);
        const length = quotient + 1 + k;
        if (length <= 24) {
          writer.write((1 << k) | remainder, length);
        } else {
          writer.writeZeros(quotient);
          writer.write(2 ** k + remainder, k + 1);
        }
      }
    }
  }

  /**
   * Returns the exact residual size (method, partition order, parameters and
   * Rice codes) for the best partition order, leaving its parameters in
   * candidateParameters.
   */
  private searchPartitions(residuals: Uint32Array, order: number, blockSize: number): number {
    const prefixSums = this.prefixSums;
    prefixSums[order] = 0;
    for (let i = order; i < blockSize; i += 1) {
      prefixSums[i + 1] = prefixSums[i] + residuals[i];
    }

    // Partitions must evenly divide the block, and the first one (which skips
    // the warm-up samples) must keep at least one residual.
    let maxPartitionOrder = 0;
    while (
      maxPartitionOrder < MAX_PARTITION_ORDER
      && blockSize % (2 << maxPartitionOrder) === 0
      && blockSize >> (maxPartitionOrder + 1) > order
    ) {
      maxPartitionOrder += 1;
    }

    let bestBits = Infinity;
    for (let partitionOrder = 0; partitionOrder <= maxPartitionOrder; partitionOrder += 1) {
      const partitionCount = 1 << partitionOrder;
      const partitionSize = blockSize >> partitionOrder;
      let bits = 6; // 2-bit coding method + 4-bit partition order
      let maxParameter = 0;
      for (let partition = 0; partition < partitionCount; partition += 1) {
        const start = Math.max(order, partition * partitionSize);
        const end = (partition + 1) * partitionSize;
        bits += optimalRiceParameter(
          residuals,
          start,
          end,
          prefixSums[end] - prefixSums[start],
          this.trialParameters,
          partition,
        );
        maxParameter = Math.max(maxParameter, this.trialParameters[partition]);
      }
      const method = maxParameter > MAX_METHOD0_RICE_PARAMETER ? 1 : 0;
      bits += partitionCount * (4 + method);
      if (bits < bestBits) {
        bestBits = bits;
        this.candidatePartitionOrder = partitionOrder;
        this.candidateMethod = method;
        this.candidateParameters.set(this.trialParameters.subarray(0, partitionCount));
      }
    }
    return bestBits;
  }
}

/** One-shot convenience: returns a complete FLAC file with the final STREAMINFO already in place. */
export function encodeFlac(samples: Float32Array, options: FlacEncodeOptions): Uint8Array {
  const encoder = new FlacEncoder(options);
  const chunks = encoder.encode(samples);
  chunks.push(...encoder.finish());
  let length = 0;
  for (const chunk of chunks) {
    length += chunk.length;
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  output.set(encoder.streamInfo(), FlacEncoder.STREAMINFO_OFFSET);
  return output;
}
