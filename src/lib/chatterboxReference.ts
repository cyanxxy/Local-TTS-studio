import { downmixToMono, resampleAudio } from "./pcmTransforms";
import { decodeWav } from "./wavCodec";

/** The rate the speech encoder and decoder run at. */
export const CHATTERBOX_SAMPLE_RATE = 24_000;

/** Below this the speaker embedding is unreliable. */
export const CHATTERBOX_REFERENCE_MIN_SECONDS = 3;
/** The speech encoder ignores audio past 10 s (prompt tokens and features stop growing). */
export const CHATTERBOX_REFERENCE_MAX_SECONDS = 10;
/** Upstream recommends 5-10 s of clean speech. */
export const CHATTERBOX_REFERENCE_RECOMMENDED_SECONDS = { min: 5, max: 10 } as const;

const MIN_INPUT_SAMPLE_RATE = 8_000;
const MAX_INPUT_SAMPLE_RATE = 192_000;
const MAX_INPUT_SECONDS = 600;
const FRAME_SECONDS = 0.01;
const EDGE_PADDING_SECONDS = 0.05;
// Frames quieter than this relative to the loudest frame count as silence.
const SILENCE_RELATIVE_DB = -40;
const SILENT_PEAK = 1e-4;
// Upstream normalizes references to -27 LUFS; active-speech RMS is a close
// stand-in that needs no K-weighting filter.
const TARGET_ACTIVE_RMS = 10 ** (-27 / 20);
const MAX_PEAK = 0.95;
const MIN_GAIN = 0.1;
const MAX_GAIN = 20;

export interface PreparedChatterboxReference {
  /** Mono float32 PCM at CHATTERBOX_SAMPLE_RATE, trimmed and level-normalized. */
  audio: Float32Array;
  durationSec: number;
}

export class ChatterboxReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatterboxReferenceError";
  }
}

function frameRms(audio: Float32Array, frameLength: number): Float32Array {
  const frames = new Float32Array(Math.ceil(audio.length / frameLength));
  for (let frame = 0; frame < frames.length; frame += 1) {
    const start = frame * frameLength;
    const end = Math.min(audio.length, start + frameLength);
    let sum = 0;
    for (let i = start; i < end; i += 1) sum += audio[i] * audio[i];
    frames[frame] = Math.sqrt(sum / (end - start));
  }
  return frames;
}

/**
 * Turn an arbitrary mono clip into the speech encoder's input: resample to
 * 24 kHz, trim leading/trailing silence, keep the first 10 s, and bring the
 * speech level to the upstream loudness target. No transcript is needed.
 */
export function prepareChatterboxReference(audio: Float32Array, samplingRate: number): PreparedChatterboxReference {
  if (!(audio instanceof Float32Array) || audio.length === 0) {
    throw new ChatterboxReferenceError("The reference clip is empty.");
  }
  if (!Number.isFinite(samplingRate) || samplingRate < MIN_INPUT_SAMPLE_RATE || samplingRate > MAX_INPUT_SAMPLE_RATE) {
    throw new ChatterboxReferenceError(`Unsupported reference sample rate: ${samplingRate}.`);
  }
  if (audio.length / samplingRate > MAX_INPUT_SECONDS) {
    throw new ChatterboxReferenceError(`The reference clip is longer than ${MAX_INPUT_SECONDS} seconds.`);
  }
  for (let i = 0; i < audio.length; i += 1) {
    if (!Number.isFinite(audio[i])) {
      throw new ChatterboxReferenceError("The reference clip contains invalid samples.");
    }
  }

  // Trim and window at the source rate so only the kept seconds are resampled.
  const frameLength = Math.max(1, Math.round(FRAME_SECONDS * samplingRate));
  const rms = frameRms(audio, frameLength);
  const loudestFrame = rms.reduce((max, value) => Math.max(max, value), 0);
  if (loudestFrame < SILENT_PEAK) {
    throw new ChatterboxReferenceError("The reference clip is silent.");
  }

  const threshold = loudestFrame * (10 ** (SILENCE_RELATIVE_DB / 20));
  const firstActive = rms.findIndex((value) => value >= threshold);
  let lastActive = rms.length - 1;
  while (rms[lastActive] < threshold) lastActive -= 1;
  const padding = Math.round(EDGE_PADDING_SECONDS * samplingRate);
  const start = Math.max(0, (firstActive * frameLength) - padding);
  const trimmedEnd = Math.min(audio.length, ((lastActive + 1) * frameLength) + padding);
  const end = Math.min(trimmedEnd, start + Math.round(CHATTERBOX_REFERENCE_MAX_SECONDS * samplingRate));
  if ((end - start) / samplingRate < CHATTERBOX_REFERENCE_MIN_SECONDS) {
    throw new ChatterboxReferenceError(
      `The reference clip needs at least ${CHATTERBOX_REFERENCE_MIN_SECONDS} seconds of speech.`,
    );
  }

  let activeSum = 0;
  let activeCount = 0;
  for (let frame = Math.floor(start / frameLength); frame < Math.ceil(end / frameLength); frame += 1) {
    if (rms[frame] >= threshold) {
      activeSum += rms[frame] * rms[frame];
      activeCount += 1;
    }
  }

  // slice() so the gain below never writes into the caller's buffer when no resampling is needed.
  const clip = resampleAudio(audio.slice(start, end), samplingRate, CHATTERBOX_SAMPLE_RATE);
  let peak = 0;
  for (const sample of clip) peak = Math.max(peak, Math.abs(sample));
  const activeRms = Math.sqrt(activeSum / activeCount);
  const gain = Math.max(MIN_GAIN, Math.min(MAX_GAIN, TARGET_ACTIVE_RMS / activeRms, MAX_PEAK / Math.max(peak, SILENT_PEAK)));
  for (let i = 0; i < clip.length; i += 1) clip[i] *= gain;

  return { audio: clip, durationSec: clip.length / CHATTERBOX_SAMPLE_RATE };
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

/** Content digest of prepared PCM; identical clips share one conditioning. */
export async function digestChatterboxReference(audio: Float32Array): Promise<string> {
  const bytes = new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength).slice();
  return toHex(await globalThis.crypto.subtle.digest("SHA-256", bytes));
}

/** Decodes a WAV reference (any PCM or float layout wavCodec reads), downmixed to mono. */
export function decodeChatterboxWav(buffer: ArrayBuffer): { audio: Float32Array; samplingRate: number } {
  const decoded = decodeWav(buffer);
  return { audio: downmixToMono(decoded.channels), samplingRate: decoded.sampleRate };
}

export interface ChatterboxReferenceEntry<T> {
  digest: string;
  audio: Float32Array;
  durationSec: number;
  /** Speech-encoder outputs for the loaded model, computed on first use. */
  conditioning: T | undefined;
}

export interface ChatterboxReferenceStore<T> {
  /** Points `referenceId` at prepared audio; identical audio shares one entry. */
  register(referenceId: string, digest: string, prepared: PreparedChatterboxReference): void;
  /** Looks up and marks as recently used; null when unknown or evicted. */
  resolve(referenceId: string): ChatterboxReferenceEntry<T> | null;
  setConditioning(digest: string, conditioning: T): void;
  delete(referenceId: string): void;
  /** Drops encoder outputs (they belong to the old sessions) but keeps the audio. */
  clearConditionings(): void;
}

/**
 * Bounded LRU of prepared reference audio and its encoder outputs, keyed by
 * content digest. Ids pointing at an evicted digest are forgotten with it,
 * and every conditioning that is dropped or replaced goes to `release`.
 */
export function createChatterboxReferenceStore<T>(
  maxEntries: number,
  release: (conditioning: T) => void = () => undefined,
): ChatterboxReferenceStore<T> {
  const ids = new Map<string, string>();
  const entries = new Map<string, ChatterboxReferenceEntry<T>>();

  const releaseConditioning = (entry: ChatterboxReferenceEntry<T>) => {
    const { conditioning } = entry;
    entry.conditioning = undefined;
    if (conditioning !== undefined) release(conditioning);
  };
  const touch = (digest: string, entry: ChatterboxReferenceEntry<T>) => {
    entries.delete(digest);
    entries.set(digest, entry);
  };
  const isReferenced = (digest: string) => [...ids.values()].includes(digest);
  const dropDigest = (digest: string) => {
    const entry = entries.get(digest);
    if (!entry) return;
    entries.delete(digest);
    releaseConditioning(entry);
    for (const [id, target] of ids) {
      if (target === digest) ids.delete(id);
    }
  };

  return {
    register(referenceId, digest, prepared) {
      const previous = ids.get(referenceId);
      ids.set(referenceId, digest);
      if (previous && previous !== digest && !isReferenced(previous)) dropDigest(previous);
      touch(digest, entries.get(digest) ?? {
        digest,
        audio: prepared.audio,
        durationSec: prepared.durationSec,
        conditioning: undefined,
      });
      while (entries.size > maxEntries) {
        const [oldest] = entries.keys();
        dropDigest(oldest);
      }
    },
    resolve(referenceId) {
      const digest = ids.get(referenceId);
      const entry = digest === undefined ? undefined : entries.get(digest);
      if (!digest || !entry) return null;
      touch(digest, entry);
      return entry;
    },
    setConditioning(digest, conditioning) {
      const entry = entries.get(digest);
      if (!entry) {
        release(conditioning);
        return;
      }
      if (entry.conditioning !== conditioning) releaseConditioning(entry);
      entry.conditioning = conditioning;
    },
    delete(referenceId) {
      const digest = ids.get(referenceId);
      ids.delete(referenceId);
      if (digest && !isReferenced(digest)) dropDigest(digest);
    },
    clearConditionings() {
      for (const entry of entries.values()) releaseConditioning(entry);
    },
  };
}
