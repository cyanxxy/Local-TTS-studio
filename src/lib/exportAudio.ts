import type { AudioExportOptions } from "../types";
import { concatFloat32Arrays, createWavBlob } from "./audio";

export interface ExportChunk {
  audio: Float32Array;
  samplingRate: number;
}

export interface ExportResult {
  blob: Blob;
  extension: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getRmsDb(audio: Float32Array): number {
  if (audio.length === 0) return -Infinity;
  let sumSquares = 0;
  for (let i = 0; i < audio.length; i += 1) {
    const sample = audio[i];
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / audio.length);
  if (rms <= 0) return -Infinity;
  return 20 * Math.log10(rms);
}

function applyMastering(audio: Float32Array, options: AudioExportOptions["mastering"]): Float32Array {
  if (!options.enabled || audio.length === 0) {
    return audio;
  }

  const mastered = new Float32Array(audio);
  const rmsDb = getRmsDb(mastered);
  if (Number.isFinite(rmsDb)) {
    const targetGainDb = options.targetLufs - rmsDb;
    const gain = 10 ** (targetGainDb / 20);
    for (let i = 0; i < mastered.length; i += 1) {
      mastered[i] *= gain;
    }
  }

  let peak = 0;
  for (let i = 0; i < mastered.length; i += 1) {
    const abs = Math.abs(mastered[i]);
    if (abs > peak) peak = abs;
  }

  const peakLimit = 10 ** (options.truePeakDb / 20);
  if (peak > peakLimit && peak > 0) {
    const limiterGain = peakLimit / peak;
    for (let i = 0; i < mastered.length; i += 1) {
      mastered[i] *= limiterGain;
    }
  }

  for (let i = 0; i < mastered.length; i += 1) {
    mastered[i] = clamp(mastered[i], -1, 1);
  }

  return mastered;
}

function resampleLinear(audio: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || audio.length === 0) return audio;
  if (fromRate <= 0 || toRate <= 0) return audio;

  const ratio = toRate / fromRate;
  const targetLength = Math.max(1, Math.round(audio.length * ratio));
  const output = new Float32Array(targetLength);

  for (let i = 0; i < targetLength; i += 1) {
    const srcIndex = i / ratio;
    const left = Math.floor(srcIndex);
    const right = Math.min(audio.length - 1, left + 1);
    const frac = srcIndex - left;
    output[i] = audio[left] + (audio[right] - audio[left]) * frac;
  }

  return output;
}

function floatToInt16Pcm(audio: Float32Array): Int16Array {
  const pcm = new Int16Array(audio.length);
  for (let i = 0; i < audio.length; i += 1) {
    const clamped = clamp(audio[i], -1, 1);
    pcm[i] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
  }
  return pcm;
}

async function encodeMp3(audio: Float32Array, sampleRate: number, bitrateKbps: number): Promise<Blob> {
  const lamejsModule = await import("@breezystack/lamejs");
  const encoder = new lamejsModule.default.Mp3Encoder(1, sampleRate, Math.round(clamp(bitrateKbps, 96, 320)));
  const pcm = floatToInt16Pcm(audio);
  const blockSize = 1152;
  const chunks: ArrayBuffer[] = [];

  for (let i = 0; i < pcm.length; i += blockSize) {
    const block = pcm.subarray(i, i + blockSize);
    const encoded = encoder.encodeBuffer(block);
    if (encoded.length > 0) {
      const buffer = new Uint8Array(encoded.length);
      buffer.set(encoded);
      chunks.push(buffer.buffer);
    }
  }

  const final = encoder.flush();
  if (final.length > 0) {
    const buffer = new Uint8Array(final.length);
    buffer.set(final);
    chunks.push(buffer.buffer);
  }

  return new Blob(chunks, { type: "audio/mpeg" });
}


export async function buildExportAudio(
  chunks: ExportChunk[],
  options: AudioExportOptions,
): Promise<ExportResult> {
  if (chunks.length === 0) {
    throw new Error("No audio is available to export.");
  }

  const sourceRate = chunks[0].samplingRate;
  const targetRate = options.sampleRate === "source" ? sourceRate : options.sampleRate;
  const normalizedChunks = chunks.map((chunk) => (
    chunk.samplingRate === targetRate
      ? chunk.audio
      : resampleLinear(chunk.audio, chunk.samplingRate, targetRate)
  ));

  const merged = concatFloat32Arrays(normalizedChunks);
  const mastered = applyMastering(merged, options.mastering);

  switch (options.format) {
    case "wav-f32":
      return {
        blob: createWavBlob([mastered], targetRate, { encoding: "float32" }),
        extension: "wav",
      };
    case "wav-pcm24":
      return {
        blob: createWavBlob([mastered], targetRate, { encoding: "pcm24" }),
        extension: "wav",
      };
    case "wav-pcm16":
      return {
        blob: createWavBlob([mastered], targetRate, { encoding: "pcm16" }),
        extension: "wav",
      };
    case "mp3":
      return {
        blob: await encodeMp3(mastered, targetRate, options.bitrateKbps),
        extension: "mp3",
      };
    default:
      throw new Error(`Unsupported export format: ${options.format}`);
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    anchor.remove();
  }, 0);
}
