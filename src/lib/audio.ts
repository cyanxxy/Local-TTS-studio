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

function floatToPcm16(value: number): number {
  const clamped = clampSample(value);
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

function floatToPcm24(value: number): number {
  const clamped = clampSample(value);
  return clamped < 0 ? Math.round(clamped * 0x800000) : Math.round(clamped * 0x7fffff);
}

/**
 * Build a 44-byte WAV header for IEEE Float 32-bit PCM mono audio.
 * Exported for testability.
 */
export function buildWavHeader(
  totalSamples: number,
  samplingRate: number,
  encoding: WavEncoding = "float32",
): ArrayBuffer {
  const details = getEncodingDetails(encoding);
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  const dataSize = totalSamples * details.bytesPerSample;

  // RIFF chunk descriptor
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");

  // fmt sub-chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, details.formatCode, true);
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, samplingRate, true);
  view.setUint32(28, samplingRate * details.bytesPerSample, true);
  view.setUint16(32, details.bytesPerSample, true);
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
  options?: { encoding?: WavEncoding },
): Blob {
  const encoding = options?.encoding ?? "float32";
  const merged = concatFloat32Arrays(chunks);
  const header = buildWavHeader(merged.length, samplingRate, encoding);
  const details = getEncodingDetails(encoding);
  const dataBuffer = new ArrayBuffer(merged.length * details.bytesPerSample);

  if (encoding === "float32") {
    new Float32Array(dataBuffer).set(merged);
  } else if (encoding === "pcm16") {
    const view = new DataView(dataBuffer);
    for (let i = 0; i < merged.length; i += 1) {
      view.setInt16(i * 2, floatToPcm16(merged[i]), true);
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
  const totalLength = arrays.reduce((acc, arr) => acc + arr.length, 0);
  const result = new Float32Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
