import type { ChunkPauseKind } from "../types";

export interface AudioChunkData {
  audio: Float32Array;
  samplingRate: number;
  text?: string;
  index?: number;
  total?: number;
  textStart?: number;
  textEnd?: number;
  pauseAfterSec?: number;
  pauseKind?: ChunkPauseKind;
}

export interface StoredAudioChunk extends AudioChunkData {
  startSec: number;
  endSec: number;
  segmentId: string;
  audioBuffer?: AudioBuffer;
}

export interface AudioSegment {
  id: string;
  text: string;
  startSec: number;
  endSec: number;
  index: number;
  total: number;
  textStart?: number;
  textEnd?: number;
  pauseAfterSec?: number;
  pauseKind?: ChunkPauseKind;
}

export interface CaptionSegment {
  startSec: number;
  endSec: number;
  text: string;
}

export function getChunkDuration(chunk: Pick<AudioChunkData, "audio" | "samplingRate">): number {
  return chunk.audio.length / chunk.samplingRate;
}

export function getCaptionEndSec(
  chunk: Pick<StoredAudioChunk, "startSec" | "endSec" | "pauseAfterSec">,
): number {
  const trailingPause = Math.max(0, chunk.pauseAfterSec ?? 0);
  return Math.max(chunk.startSec, chunk.endSec - trailingPause);
}

export function toAudioSegment(
  chunk: StoredAudioChunk,
  index: number,
  totalCount: number,
): AudioSegment {
  const chunkIndex = typeof chunk.index === "number" ? chunk.index : index + 1;
  const chunkTotal = typeof chunk.total === "number" ? chunk.total : totalCount;
  const label = (chunk.text || "").trim() || `Segment ${chunkIndex}`;

  return {
    id: chunk.segmentId,
    text: label,
    startSec: chunk.startSec,
    endSec: chunk.endSec,
    index: chunkIndex,
    total: chunkTotal,
    textStart: chunk.textStart,
    textEnd: chunk.textEnd,
    pauseAfterSec: chunk.pauseAfterSec,
    pauseKind: chunk.pauseKind,
  };
}

export function buildAudioSegments(chunks: readonly StoredAudioChunk[]): AudioSegment[] {
  return chunks.map((chunk, index) => toAudioSegment(chunk, index, chunks.length));
}

export function retimeStoredChunks(chunks: readonly StoredAudioChunk[]): StoredAudioChunk[] {
  let cursor = 0;

  return chunks.map((chunk) => {
    const duration = getChunkDuration(chunk);
    const next = {
      ...chunk,
      startSec: cursor,
      endSec: cursor + duration,
    };
    cursor = next.endSec;
    return next;
  });
}

export function buildCaptionSegments(chunks: readonly StoredAudioChunk[]): CaptionSegment[] {
  return chunks
    .map((chunk, index) => ({
      startSec: chunk.startSec,
      endSec: getCaptionEndSec(chunk),
      text: (chunk.text || `Section ${index + 1}`).trim(),
    }))
    .filter((segment) => segment.text.length > 0);
}
