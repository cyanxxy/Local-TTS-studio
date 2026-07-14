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
  const chunkTotal = typeof chunk.total === "number" && chunk.total > 0 ? chunk.total : totalCount;
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
  const groups = groupSemanticChunks(chunks);
  return groups.map((group, index) => {
    const first = group[0];
    const last = group[group.length - 1];
    return toAudioSegment({
      ...first,
      endSec: last.endSec,
      pauseAfterSec: last.pauseAfterSec,
      pauseKind: last.pauseKind,
    }, index, groups.length);
  });
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
  return groupSemanticChunks(chunks)
    .map((group, index) => {
      const first = group[0];
      const last = group[group.length - 1];
      return {
        startSec: first.startSec,
        endSec: getCaptionEndSec(last),
        text: (first.text || `Section ${index + 1}`).trim(),
      };
    })
    .filter((segment) => segment.text.length > 0);
}

function groupSemanticChunks(chunks: readonly StoredAudioChunk[]): StoredAudioChunk[][] {
  const groups: StoredAudioChunk[][] = [];
  for (const chunk of chunks) {
    const current = groups.at(-1);
    if (current?.[0].segmentId === chunk.segmentId) current.push(chunk);
    else groups.push([chunk]);
  }
  return groups;
}
