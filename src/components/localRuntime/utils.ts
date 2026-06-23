export type StatusTone = "success" | "error" | "info";

export function statusClass(tone: StatusTone): string {
  if (tone === "success") return "text-success";
  if (tone === "error") return "text-danger";
  return "text-text-secondary";
}

export function formatBytes(sizeBytes: number): string {
  if (sizeBytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = sizeBytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  const parts: string[] = [];

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    let binaryChunk = "";
    for (let j = 0; j < chunk.length; j += 1) {
      binaryChunk += String.fromCharCode(chunk[j]);
    }
    parts.push(binaryChunk);
  }

  return btoa(parts.join(""));
}

export interface Float32AudioChunk {
  audio: ArrayBuffer;
  sampleCount: number;
  silenceAfterSamples: number;
}

const PCM16_BYTES_PER_SAMPLE = 2;
const FLOAT32_BYTES_PER_SAMPLE = 4;
const WAV_HEADER_BYTES = 44;
const RIFF_SIZE_FIELD_MAX = 0xFFFFFFFF;
const RIFF_DATA_SIZE_MAX = RIFF_SIZE_FIELD_MAX - 36;
const MAX_RENDERER_WAV_BYTES = 0x7FFFFFFF;

export function float32ChunksToWavUrl(chunks: Float32AudioChunk[], sampleRate: number): string {
  const wavBytes = float32ChunksToWavBytes(chunks, sampleRate);
  const wavBuffer = new ArrayBuffer(wavBytes.byteLength);
  new Uint8Array(wavBuffer).set(wavBytes);
  return URL.createObjectURL(new Blob([wavBuffer], { type: "audio/wav" }));
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
    throw new Error(`${field} must be a safe non-negative integer.`);
  }
}

function assertValidSampleRate(sampleRate: number): void {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0 || sampleRate > RIFF_SIZE_FIELD_MAX) {
    throw new Error("WAV sample rate must be a positive integer.");
  }
}

function assertUint32Field(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > RIFF_SIZE_FIELD_MAX) {
    throw new Error(`${label} exceeds WAV 32-bit field limits.`);
  }
}

export function float32ChunksToWavBytes(chunks: Float32AudioChunk[], sampleRate: number): Uint8Array {
  assertValidSampleRate(sampleRate);
  const byteRate = sampleRate * PCM16_BYTES_PER_SAMPLE;
  assertUint32Field(byteRate, "WAV byte rate");
  const totalSamples = chunks.reduce((sum, chunk) => {
    assertNonNegativeInteger(chunk.sampleCount, "Audio chunk sample count");
    assertNonNegativeInteger(chunk.silenceAfterSamples, "Audio chunk silence sample count");
    const requiredBytes = chunk.sampleCount * FLOAT32_BYTES_PER_SAMPLE;
    if (!Number.isSafeInteger(requiredBytes) || requiredBytes > chunk.audio.byteLength) {
      throw new Error("Audio chunk sample count exceeds its Float32 payload.");
    }
    const next = sum + chunk.sampleCount + chunk.silenceAfterSamples;
    if (!Number.isSafeInteger(next)) {
      throw new Error("Local-runtime WAV output is too large.");
    }
    return next;
  }, 0);
  const dataBytes = totalSamples * PCM16_BYTES_PER_SAMPLE;
  if (
    !Number.isSafeInteger(dataBytes)
    || dataBytes > RIFF_DATA_SIZE_MAX
    || WAV_HEADER_BYTES + dataBytes > MAX_RENDERER_WAV_BYTES
  ) {
    throw new Error("Local-runtime WAV output is too large.");
  }

  const wav = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(wav.buffer);
  writeAscii(wav, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(wav, 8, "WAVE");
  writeAscii(wav, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(wav, 36, "data");
  view.setUint32(40, dataBytes, true);

  let peak = 0;
  for (const chunk of chunks) {
    const samples = new Float32Array(chunk.audio, 0, chunk.sampleCount);
    for (let index = 0; index < samples.length; index += 1) {
      const value = Number.isFinite(samples[index]) ? Math.abs(samples[index]) : 0;
      if (value > peak) peak = value;
    }
  }
  const scale = peak > 1 ? peak : 1;

  let outputOffset = 44;
  for (const chunk of chunks) {
    const samples = new Float32Array(chunk.audio, 0, chunk.sampleCount);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, (Number.isFinite(samples[index]) ? samples[index] : 0) / scale));
      view.setInt16(outputOffset, Math.round(sample * 32767), true);
      outputOffset += PCM16_BYTES_PER_SAMPLE;
    }
    outputOffset += chunk.silenceAfterSamples * PCM16_BYTES_PER_SAMPLE;
  }

  return wav;
}

function writeAscii(bytes: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    bytes[offset + index] = text.charCodeAt(index);
  }
}
