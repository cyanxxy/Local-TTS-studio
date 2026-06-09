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
