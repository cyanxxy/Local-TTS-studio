/**
 * What the app shell needs to know about the single-session phoneme models
 * (Kitten, Paradee, Piper) without loading their onnxruntime-web runtimes:
 * how their workers chunk text, and where their downloads are cached. The
 * runtimes re-export these, so a worker and the engine descriptors that preview
 * its passages always agree.
 */
import type { InferenceBackend } from "../types";
import { chunkWithConstraintsDetailed, type TextChunk } from "./chunking";

/** Cache Storage for the pinned files; "transformers" keeps it inside the app's clear-cache contract. */
export const KITTEN_CACHE_NAME = "transformers-cache-kitten-v1";
export const PARADEE_CACHE_NAME = "transformers-cache-paradee-v1";

/** Upstream chunk_text's limit, which also keeps the style row inside the 400-row tables. */
export const KITTEN_MAX_CHUNK_CHARACTERS = 400;
/** The longest sentence-sized chunk Piper reads well; longer ones are split by the chunker. */
export const PIPER_MAX_CHUNK_CHARACTERS = 250;

/**
 * Plan a GENERATE text into chunks. The Reader's passage preview must use this
 * same function so its ranges match the worker's AUDIO_CHUNKs.
 */
export function chunkKittenText(text: string, backend: InferenceBackend | null): TextChunk[] {
  return chunkWithConstraintsDetailed(text, backend === "webgpu"
    ? { minCharacters: 80, maxCharacters: KITTEN_MAX_CHUNK_CHARACTERS }
    : { minCharacters: 40, maxCharacters: 240 });
}

/** Plan a GENERATE text into chunks; the Reader preview must use this same function. */
export function chunkParadeeText(text: string): TextChunk[] {
  return chunkWithConstraintsDetailed(text, { minCharacters: 40, maxCharacters: 280 });
}

/** Plan a GENERATE text into chunks; the Reader preview must use this same function. */
export function chunkPiperText(text: string): TextChunk[] {
  return chunkWithConstraintsDetailed(text, { minCharacters: 40, maxCharacters: PIPER_MAX_CHUNK_CHARACTERS });
}
