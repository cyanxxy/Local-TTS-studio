/**
 * Speed, pause, and AUDIO_CHUNK helpers shared by the browser TTS workers.
 *
 * Pauses are rendered into the PCM as trailing silence and `pauseAfterSec` is
 * metadata only; export, Reader caching, and highlighting all rely on that.
 */
import { SPEED_DEFAULT, SPEED_MAX, SPEED_MIN } from "../../constants";
import { resolvePauseSeconds } from "../../lib/textTuning";
import type { ChunkPauseKind } from "../../types";
import { generationMeta, type WorkerPort } from "./protocol";

export const MAX_FINAL_PAUSE_SEC = 5;

/** Keeps synthesis inside the voice-stable speed range. */
export function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return SPEED_DEFAULT;
  return Math.max(SPEED_MIN, Math.min(SPEED_MAX, speed));
}

/** The caller-supplied pause after the last chunk, clamped to 0-5 s. */
export function normalizeFinalPauseSec(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_FINAL_PAUSE_SEC, value));
}

export interface ChunkPauseOptions {
  /** Whether another chunk of this generation follows. */
  hasFollowing: boolean;
  pauseKind: ChunkPauseKind;
  /** The chunker's default pause for this boundary. */
  pauseAfterSec: number;
  pauseOverridesSec?: Partial<Record<ChunkPauseKind, number>>;
  finalPauseSec?: number;
}

/** Silence after a chunk: the boundary pause between chunks, the final pause after the last. */
export function resolveChunkPauseSec({
  hasFollowing,
  pauseKind,
  pauseAfterSec,
  pauseOverridesSec,
  finalPauseSec,
}: ChunkPauseOptions): number {
  return hasFollowing
    ? resolvePauseSeconds(pauseKind, pauseAfterSec, pauseOverridesSec)
    : normalizeFinalPauseSec(finalPauseSec);
}

/** Returns `audio` followed by `pauseSec` of silence, in one new buffer. */
export function appendSilence(audio: Float32Array, pauseSec: number, samplingRate: number): Float32Array {
  const silenceSamples = Math.round(pauseSec * samplingRate);
  if (!(silenceSamples > 0)) return audio;
  const output = new Float32Array(audio.length + silenceSamples);
  output.set(audio);
  return output;
}

export interface AudioChunkEmission {
  generationId: string | undefined;
  /** Speech only; the pause is appended here. */
  audio: Float32Array;
  samplingRate: number;
  text: string;
  /** 1-based position of this chunk. */
  index: number;
  /** Chunk count, or 0 once retries made the count dynamic. */
  total: number;
  textStart?: number;
  textEnd?: number;
  pauseKind: ChunkPauseKind;
  /** Resolved pause rendered as trailing silence and reported as pauseAfterSec. */
  pauseSec: number;
}

export function emitAudioChunk(port: WorkerPort, chunk: AudioChunkEmission): void {
  port.post({
    type: "AUDIO_CHUNK",
    ...generationMeta(chunk.generationId),
    audio: appendSilence(chunk.audio, chunk.pauseSec, chunk.samplingRate),
    samplingRate: chunk.samplingRate,
    text: chunk.text,
    index: chunk.index,
    total: chunk.total,
    textStart: chunk.textStart,
    textEnd: chunk.textEnd,
    pauseAfterSec: chunk.pauseSec,
    pauseKind: chunk.pauseKind,
  });
}
