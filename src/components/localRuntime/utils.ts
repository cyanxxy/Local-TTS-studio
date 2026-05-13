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

export async function inspectAudioFile(buffer: ArrayBuffer): Promise<DecodedAudioFileInfo> {
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
  const summary = `${info.durationSec.toFixed(1)}s, ${info.channelCount === 1 ? "mono" : `${info.channelCount} channels`}, ${(info.sampleRate / 1000).toFixed(1)} kHz.`;
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
      text: `Reference WAV looks good (${summary}) Enter the exact transcript of this clip before generating.`,
    };
  }

  return {
    tone: "info",
    text: `Reference WAV loaded (${summary}) Best results use mono audio, 16-44 kHz, and a 3-15 second clip. Enter the exact transcript of this clip before generating.`,
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

export function wavBase64ToUrl(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
}
