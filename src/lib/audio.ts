/**
 * Audio utilities for WAV encoding and Float32Array manipulation.
 * Sample rate is NEVER hardcoded — always pass from model output.
 * Kokoro = 24000 Hz, Supertonic = 44100 Hz.
 */

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

export type WavEncoding = "float32" | "pcm16" | "pcm24";

interface WavEncodingDetails {
  formatCode: number;
  bitsPerSample: number;
  bytesPerSample: number;
}

const WAV_HEADER_BYTES = 44;
const RIFF_SIZE_FIELD_MAX = 0xFFFFFFFF;
const RIFF_DATA_SIZE_MAX = RIFF_SIZE_FIELD_MAX - 36;

function getEncodingDetails(encoding: WavEncoding): WavEncodingDetails {
  switch (encoding) {
    case "pcm16":
      return { formatCode: 1, bitsPerSample: 16, bytesPerSample: 2 };
    case "pcm24":
      return { formatCode: 1, bitsPerSample: 24, bytesPerSample: 3 };
    case "float32":
    default:
      return { formatCode: 3, bitsPerSample: 32, bytesPerSample: 4 };
  }
}

function clampSample(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

export function floatToPcm16Sample(value: number): number {
  const clamped = clampSample(value);
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

export function floatToPcm16Array(audio: Float32Array): Int16Array {
  const pcm = new Int16Array(audio.length);
  for (let i = 0; i < audio.length; i += 1) {
    pcm[i] = floatToPcm16Sample(audio[i]);
  }
  return pcm;
}

function floatToPcm24(value: number): number {
  const clamped = clampSample(value);
  return clamped < 0 ? Math.round(clamped * 0x800000) : Math.round(clamped * 0x7fffff);
}

function assertValidChannelCount(channelCount: number): void {
  if (!Number.isInteger(channelCount) || channelCount < 1 || channelCount > 32) {
    throw new Error("WAV channel count must be an integer between 1 and 32.");
  }
}

function assertValidSampleRate(samplingRate: number): void {
  if (!Number.isInteger(samplingRate) || samplingRate <= 0 || samplingRate > RIFF_SIZE_FIELD_MAX) {
    throw new Error("WAV sample rate must be a positive integer.");
  }
}

function assertValidFrameCount(totalFrames: number): void {
  if (!Number.isInteger(totalFrames) || totalFrames < 0 || !Number.isSafeInteger(totalFrames)) {
    throw new Error("WAV frame count must be a safe non-negative integer.");
  }
}

function checkedProduct(values: number[], label: string): number {
  const result = values.reduce((acc, value) => acc * value, 1);
  if (!Number.isSafeInteger(result)) {
    throw new Error(`${label} exceeds JavaScript safe integer limits.`);
  }
  return result;
}

function assertUint32Field(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > RIFF_SIZE_FIELD_MAX) {
    throw new Error(`${label} exceeds WAV 32-bit field limits.`);
  }
}

/**
 * Build a 44-byte WAV header. `totalFrames` is the per-channel frame count;
 * interleaved sample data must contain `totalFrames * channelCount` samples.
 * Exported for testability.
 */
export function buildWavHeader(
  totalFrames: number,
  samplingRate: number,
  encoding: WavEncoding = "float32",
  channelCount: number = 1,
): ArrayBuffer {
  assertValidChannelCount(channelCount);
  assertValidSampleRate(samplingRate);
  assertValidFrameCount(totalFrames);
  const details = getEncodingDetails(encoding);
  const dataSize = checkedProduct([totalFrames, channelCount, details.bytesPerSample], "WAV data size");
  if (dataSize > RIFF_DATA_SIZE_MAX) {
    throw new Error("WAV data is too large for standard RIFF output.");
  }
  const byteRate = checkedProduct([samplingRate, channelCount, details.bytesPerSample], "WAV byte rate");
  const blockAlign = checkedProduct([channelCount, details.bytesPerSample], "WAV block align");
  assertUint32Field(byteRate, "WAV byte rate");
  assertUint32Field(blockAlign, "WAV block align");

  const buffer = new ArrayBuffer(WAV_HEADER_BYTES);
  const view = new DataView(buffer);

  // RIFF chunk descriptor
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");

  // fmt sub-chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, details.formatCode, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, samplingRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, details.bitsPerSample, true);

  // data sub-chunk
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  return buffer;
}

/**
 * Encode Float32Array audio chunks into a WAV blob.
 * Uses IEEE Float 32-bit PCM (AudioFormat = 3).
 */
export function createWavBlob(
  chunks: Float32Array[],
  samplingRate: number,
  options?: { encoding?: WavEncoding; channelCount?: number },
): Blob {
  const encoding = options?.encoding ?? "float32";
  const channelCount = options?.channelCount ?? 1;
  assertValidChannelCount(channelCount);
  const merged = concatFloat32Arrays(chunks);
  if (merged.length % channelCount !== 0) {
    throw new Error("Interleaved WAV sample count must be divisible by channel count.");
  }

  const frameCount = merged.length / channelCount;
  const header = buildWavHeader(frameCount, samplingRate, encoding, channelCount);
  const details = getEncodingDetails(encoding);
  const dataBuffer = new ArrayBuffer(merged.length * details.bytesPerSample);

  if (encoding === "float32") {
    new Float32Array(dataBuffer).set(merged);
  } else if (encoding === "pcm16") {
    const view = new DataView(dataBuffer);
    for (let i = 0; i < merged.length; i += 1) {
      view.setInt16(i * 2, floatToPcm16Sample(merged[i]), true);
    }
  } else {
    const view = new DataView(dataBuffer);
    for (let i = 0; i < merged.length; i += 1) {
      const sample = floatToPcm24(merged[i]);
      const offset = i * 3;
      view.setUint8(offset, sample & 0xff);
      view.setUint8(offset + 1, (sample >> 8) & 0xff);
      view.setUint8(offset + 2, (sample >> 16) & 0xff);
    }
  }

  return new Blob([header, dataBuffer], { type: "audio/wav" });
}

/**
 * Create silence as a Float32Array of the given duration and sample rate.
 */
export function createSilence(durationSec: number, samplingRate: number): Float32Array {
  return new Float32Array(Math.round(durationSec * samplingRate));
}

/**
 * Concatenate multiple Float32Arrays into one.
 */
export function concatFloat32Arrays(arrays: Float32Array[]): Float32Array {
  const totalLength = arrays.reduce((acc, arr) => {
    const next = acc + arr.length;
    if (!Number.isSafeInteger(next)) {
      throw new Error("Audio sample count exceeds JavaScript safe integer limits.");
    }
    return next;
  }, 0);
  const result = new Float32Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
