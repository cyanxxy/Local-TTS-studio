export type StatusTone = "success" | "error" | "info";

export interface DecodedAudioFileInfo {
  channelCount: number;
  sampleRate: number;
  durationSec: number;
}

export function statusClass(tone: StatusTone): string {
  if (tone === "success") return "text-success";
  if (tone === "error") return "text-danger";
  return "text-text-secondary";
}

function asciiChunk(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

export function isLikelyWavBuffer(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 12) return false;

  const header = new Uint8Array(buffer, 0, 12);
  return asciiChunk(header, 0, 4) === "RIFF" && asciiChunk(header, 8, 4) === "WAVE";
}

function inspectWavHeader(buffer: ArrayBuffer): DecodedAudioFileInfo | null {
  if (!isLikelyWavBuffer(buffer) || buffer.byteLength < 44) return null;

  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let offset = 12;
  let channelCount: number | null = null;
  let sampleRate: number | null = null;
  let blockAlign: number | null = null;
  let dataSize: number | null = null;

  while (offset + 8 <= bytes.byteLength) {
    const chunkId = asciiChunk(bytes, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataOffset = offset + 8;
    if (chunkDataOffset + chunkSize > bytes.byteLength) break;

    if (chunkId === "fmt " && chunkSize >= 16) {
      channelCount = view.getUint16(chunkDataOffset + 2, true);
      sampleRate = view.getUint32(chunkDataOffset + 4, true);
      blockAlign = view.getUint16(chunkDataOffset + 12, true);
    } else if (chunkId === "data") {
      dataSize = chunkSize;
    }

    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  if (!channelCount || !sampleRate || !blockAlign || dataSize === null) return null;

  return {
    channelCount,
    sampleRate,
    durationSec: dataSize > 0 ? dataSize / blockAlign / sampleRate : 0,
  };
}

export async function inspectAudioFile(buffer: ArrayBuffer): Promise<DecodedAudioFileInfo> {
  const wavInfo = inspectWavHeader(buffer);
  if (wavInfo) return wavInfo;

  const audioContext = new AudioContext();

  try {
    const decoded = await audioContext.decodeAudioData(buffer.slice(0));
    return {
      channelCount: decoded.numberOfChannels,
      sampleRate: decoded.sampleRate,
      durationSec: decoded.duration,
    };
  } finally {
    void audioContext.close().catch(() => undefined);
  }
}

export function getNeuttsReferenceGuidance(info: DecodedAudioFileInfo): { tone: StatusTone; text: string } {
  const summary = `${info.durationSec.toFixed(1)}s, ${info.channelCount === 1 ? "mono" : `${info.channelCount} channels`}, ${(info.sampleRate / 1000).toFixed(1)} kHz`;
  const bestPracticeIssues: string[] = [];

  if (info.channelCount !== 1) {
    bestPracticeIssues.push("mono audio");
  }
  if (info.sampleRate < 16_000 || info.sampleRate > 44_000) {
    bestPracticeIssues.push("a 16-44 kHz sample rate");
  }
  if (info.durationSec < 3 || info.durationSec > 15) {
    bestPracticeIssues.push("a 3-15 second clip");
  }

  if (bestPracticeIssues.length === 0) {
    return {
      tone: "success",
      text: `Reference WAV looks good (${summary}). Enter the exact transcript of this clip before generating.`,
    };
  }

  return {
    tone: "info",
    text: `Reference WAV loaded (${summary}). Best results use mono audio, 16-44 kHz, and a 3-15 second clip. Enter the exact transcript of this clip before generating.`,
  };
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

export function float32ChunksToWavUrl(chunks: Float32AudioChunk[], sampleRate: number): string {
  const wavBytes = float32ChunksToWavBytes(chunks, sampleRate);
  const wavBuffer = new ArrayBuffer(wavBytes.byteLength);
  new Uint8Array(wavBuffer).set(wavBytes);
  return URL.createObjectURL(new Blob([wavBuffer], { type: "audio/wav" }));
}

export function float32ChunksToWavBytes(chunks: Float32AudioChunk[], sampleRate: number): Uint8Array {
  const totalSamples = chunks.reduce((sum, chunk) => (
    sum + chunk.sampleCount + chunk.silenceAfterSamples
  ), 0);
  const dataBytes = totalSamples * 2;
  const wav = new Uint8Array(44 + dataBytes);
  const view = new DataView(wav.buffer);
  writeAscii(wav, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(wav, 8, "WAVE");
  writeAscii(wav, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
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
      outputOffset += 2;
    }
    outputOffset += chunk.silenceAfterSamples * 2;
  }

  return wav;
}

function writeAscii(bytes: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    bytes[offset + index] = text.charCodeAt(index);
  }
}
