import type { SynthesisChunk } from "../shared/engineRuntime";
import type { CachedReaderAudioChunk } from "./readerDocument";

/** About how fast speech is read aloud, to size audio before it exists. */
const SPEECH_CHARACTERS_PER_SECOND = 14;
const FLOAT32_BYTES = 4;

/** The PCM an engine producing `sampleRate` audio would make for `characters` of text. */
export function estimateSpeechBytes(characters: number, sampleRate: number): number {
  return Math.ceil((Math.max(0, characters) / SPEECH_CHARACTERS_PER_SECOND) * sampleRate * FLOAT32_BYTES);
}

/**
 * A rendered passage in the shape the Reader audio cache stores. The audio is
 * the engine's own buffer when the chunk owns all of it, and a copy of its
 * window otherwise.
 */
export function toCachedChunk(chunk: SynthesisChunk): CachedReaderAudioChunk {
  const { audio } = chunk;
  return {
    audio: audio.byteOffset === 0 && audio.byteLength === audio.buffer.byteLength
      ? audio.buffer as ArrayBuffer
      : audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer,
    samplingRate: chunk.samplingRate,
    text: chunk.text,
    index: chunk.index,
    total: chunk.total,
    textStart: chunk.textStart,
    textEnd: chunk.textEnd,
    pauseAfterSec: chunk.pauseAfterSec,
    pauseKind: chunk.pauseKind,
  };
}

/**
 * Finishes a rendered section for the cache: engines that do not know the
 * passage count up front report 0, and the saved audio must say how many
 * passages it holds.
 */
export function sealRenderedChunks(chunks: readonly CachedReaderAudioChunk[]): CachedReaderAudioChunk[] {
  return chunks.map((chunk) => (chunk.total > 0 ? chunk : { ...chunk, total: chunks.length }));
}

/** Seconds of audio in `chunks` (pauses are part of the audio). */
export function cachedChunksDurationSec(chunks: readonly CachedReaderAudioChunk[]): number {
  return chunks.reduce((total, chunk) => total + chunk.audio.byteLength / FLOAT32_BYTES / chunk.samplingRate, 0);
}

/** A render grew past the memory it was allowed. */
export class RenderBudgetError extends Error {
  constructor(maxBytes: number) {
    super(`The rendered audio exceeded ${Math.round(maxBytes / (1024 * 1024))} MiB.`);
    this.name = "RenderBudgetError";
  }
}

/**
 * Collects an engine's stream for one section into cache chunks. Stops with a
 * `RenderBudgetError` once the PCM it holds passes `maxBytes`; whatever ends
 * the stream early (an abort, a failure) rejects with its own error.
 */
export async function collectSectionChunks(
  stream: AsyncIterable<SynthesisChunk>,
  { maxBytes = Number.POSITIVE_INFINITY, onChunk }: {
    maxBytes?: number;
    onChunk?: (chunk: CachedReaderAudioChunk, bytes: number) => void;
  } = {},
): Promise<CachedReaderAudioChunk[]> {
  const chunks: CachedReaderAudioChunk[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const cached = toCachedChunk(chunk);
    bytes += cached.audio.byteLength;
    if (bytes > maxBytes) throw new RenderBudgetError(maxBytes);
    chunks.push(cached);
    onChunk?.(cached, bytes);
  }
  return sealRenderedChunks(chunks);
}
