import type { AudioExportOptions } from "../types";
import { concatFloat32Arrays, createWavBlob, floatToPcm16Array } from "./audio";

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

interface BiquadCoefficients {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

const LUFS_OFFSET_DB = -0.691;
const LUFS_ABSOLUTE_GATE_DB = -70;
const LUFS_RELATIVE_GATE_DB = -10;
const LUFS_BLOCK_DURATION_SEC = 0.4;
const LUFS_BLOCK_HOP_SEC = 0.1;
const SINC_UPSAMPLE_RADIUS = 12;
const SINC_DOWNSAMPLE_RADIUS = 24;
const MIN_MP3_BITRATE_KBPS = 128;
const MAX_MP3_BITRATE_KBPS = 320;

function highShelfCoefficients(sampleRate: number, frequency: number, gainDb: number, q: number): BiquadCoefficients {
  const a = 10 ** (gainDb / 40);
  const omega = (2 * Math.PI * frequency) / sampleRate;
  const sin = Math.sin(omega);
  const cos = Math.cos(omega);
  const alpha = sin / (2 * q);
  const sqrtA = Math.sqrt(a);
  const a0 = (a + 1) - ((a - 1) * cos) + (2 * sqrtA * alpha);

  return {
    b0: (a * ((a + 1) + ((a - 1) * cos) + (2 * sqrtA * alpha))) / a0,
    b1: (-2 * a * ((a - 1) + ((a + 1) * cos))) / a0,
    b2: (a * ((a + 1) + ((a - 1) * cos) - (2 * sqrtA * alpha))) / a0,
    a1: (2 * ((a - 1) - ((a + 1) * cos))) / a0,
    a2: ((a + 1) - ((a - 1) * cos) - (2 * sqrtA * alpha)) / a0,
  };
}

function highPassCoefficients(sampleRate: number, frequency: number, q: number): BiquadCoefficients {
  const omega = (2 * Math.PI * frequency) / sampleRate;
  const sin = Math.sin(omega);
  const cos = Math.cos(omega);
  const alpha = sin / (2 * q);
  const a0 = 1 + alpha;

  return {
    b0: ((1 + cos) / 2) / a0,
    b1: (-(1 + cos)) / a0,
    b2: ((1 + cos) / 2) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

function applyBiquad(audio: Float32Array, coefficients: BiquadCoefficients): Float32Array {
  const output = new Float32Array(audio.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;

  for (let i = 0; i < audio.length; i += 1) {
    const x0 = audio[i];
    const y0 = (coefficients.b0 * x0)
      + (coefficients.b1 * x1)
      + (coefficients.b2 * x2)
      - (coefficients.a1 * y1)
      - (coefficients.a2 * y2);

    output[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }

  return output;
}

function applyKWeighting(audio: Float32Array, sampleRate: number): Float32Array {
  if (sampleRate <= 0 || audio.length === 0) return audio;

  const shelf = highShelfCoefficients(sampleRate, 1500, 4, Math.SQRT1_2);
  const highPass = highPassCoefficients(sampleRate, 38, 0.5);
  return applyBiquad(applyBiquad(audio, shelf), highPass);
}

function meanSquare(audio: Float32Array, start: number = 0, length: number = audio.length): number {
  if (length <= 0) return 0;
  let sumSquares = 0;
  for (let i = start; i < start + length; i += 1) {
    const sample = audio[i];
    sumSquares += sample * sample;
  }
  return sumSquares / length;
}

function loudnessFromMeanSquare(energy: number): number {
  return energy > 0 ? LUFS_OFFSET_DB + (10 * Math.log10(energy)) : -Infinity;
}

function integratedLoudnessFromEnergies(energies: number[]): number {
  if (energies.length === 0) return -Infinity;
  const energy = energies.reduce((sum, value) => sum + value, 0) / energies.length;
  return loudnessFromMeanSquare(energy);
}

function measureIntegratedLufs(audio: Float32Array, sampleRate: number): number {
  if (audio.length === 0 || sampleRate <= 0) return -Infinity;

  const weighted = applyKWeighting(audio, sampleRate);
  const blockSize = Math.max(1, Math.round(sampleRate * LUFS_BLOCK_DURATION_SEC));
  const hopSize = Math.max(1, Math.round(sampleRate * LUFS_BLOCK_HOP_SEC));
  const energies: number[] = [];

  if (weighted.length <= blockSize) {
    energies.push(meanSquare(weighted));
  } else {
    for (let start = 0; start + blockSize <= weighted.length; start += hopSize) {
      energies.push(meanSquare(weighted, start, blockSize));
    }
  }

  const absoluteGated = energies.filter((energy) => (
    loudnessFromMeanSquare(energy) > LUFS_ABSOLUTE_GATE_DB
  ));
  if (absoluteGated.length === 0) return -Infinity;

  const preliminaryLoudness = integratedLoudnessFromEnergies(absoluteGated);
  const relativeGate = Math.max(LUFS_ABSOLUTE_GATE_DB, preliminaryLoudness + LUFS_RELATIVE_GATE_DB);
  const gated = absoluteGated.filter((energy) => loudnessFromMeanSquare(energy) > relativeGate);

  return integratedLoudnessFromEnergies(gated);
}

function applyMastering(
  audio: Float32Array,
  sampleRate: number,
  options: AudioExportOptions["mastering"],
): Float32Array {
  if (!options.enabled || audio.length === 0) {
    return audio;
  }

  const mastered = new Float32Array(audio);
  const integratedLufs = measureIntegratedLufs(mastered, sampleRate);
  if (Number.isFinite(integratedLufs)) {
    const targetGainDb = options.targetLufs - integratedLufs;
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

function sinc(value: number): number {
  if (Math.abs(value) < 1e-8) return 1;
  const x = Math.PI * value;
  return Math.sin(x) / x;
}

function blackmanWindow(distance: number, radius: number): number {
  const normalized = Math.abs(distance) / radius;
  if (normalized >= 1) return 0;
  return 0.42 + (0.5 * Math.cos(Math.PI * normalized)) + (0.08 * Math.cos(2 * Math.PI * normalized));
}

function resampleWindowedSinc(audio: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || audio.length === 0) return audio;
  if (fromRate <= 0 || toRate <= 0) return audio;

  const ratio = toRate / fromRate;
  const targetLength = Math.max(1, Math.round(audio.length * ratio));
  const output = new Float32Array(targetLength);
  const filterScale = Math.min(1, ratio);
  const radius = ratio < 1 ? SINC_DOWNSAMPLE_RADIUS : SINC_UPSAMPLE_RADIUS;

  for (let i = 0; i < targetLength; i += 1) {
    const center = i / ratio;
    const left = Math.ceil(center - radius);
    const right = Math.floor(center + radius);
    let weightedSum = 0;
    let weightTotal = 0;

    for (let sampleIndex = left; sampleIndex <= right; sampleIndex += 1) {
      const clampedIndex = clamp(sampleIndex, 0, audio.length - 1);
      const distance = center - sampleIndex;
      const weight = filterScale * sinc(distance * filterScale) * blackmanWindow(distance, radius);
      weightedSum += audio[clampedIndex] * weight;
      weightTotal += weight;
    }

    output[i] = weightTotal === 0 ? 0 : weightedSum / weightTotal;
  }

  return output;
}

async function encodeMp3(audio: Float32Array, sampleRate: number, bitrateKbps: number): Promise<Blob> {
  const lamejsModule = await import("@breezystack/lamejs");
  const encoder = new lamejsModule.default.Mp3Encoder(
    1,
    sampleRate,
    Math.round(clamp(bitrateKbps, MIN_MP3_BITRATE_KBPS, MAX_MP3_BITRATE_KBPS)),
  );
  const pcm = floatToPcm16Array(audio);
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
      : resampleWindowedSinc(chunk.audio, chunk.samplingRate, targetRate)
  ));

  const merged = concatFloat32Arrays(normalizedChunks);
  const mastered = applyMastering(merged, targetRate, options.mastering);

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
