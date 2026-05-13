import { Tensor } from "@huggingface/transformers";
import type { InferenceBackend } from "../types";
import type { TextChunk } from "./chunking";

export const SUPERTONIC_DEFAULT_VOICE = "Female";

const SUPERTONIC_VOICE_FILES: Readonly<Record<string, string>> = {
  Female: "voices/F1.bin",
  "Female 2": "voices/F2.bin",
  "Female 3": "voices/F3.bin",
  "Female 4": "voices/F4.bin",
  "Female 5": "voices/F5.bin",
  Male: "voices/M1.bin",
  "Male 2": "voices/M2.bin",
  "Male 3": "voices/M3.bin",
  "Male 4": "voices/M4.bin",
  "Male 5": "voices/M5.bin",
};

export interface QueuedSupertonicChunk {
  chunk: TextChunk;
  depth: number;
}

export interface SupertonicBatchSelectionOptions {
  backend: InferenceBackend | null;
  emitted: number;
  sentenceSpeedVariance: number;
}

export interface SupertonicVoiceStore {
  clear: () => void;
  ensure: (voice: string) => Promise<Float32Array>;
  get: (voice: string) => Float32Array | null;
  preload: (voice: string) => Promise<Float32Array>;
}

export interface TransformersRemoteFileUrlOptions {
  remoteHost: string;
  remotePathTemplate: string;
  modelId: string;
  revision: string;
  filename: string;
}

export function isSupertonicVoice(voice: string): boolean {
  return Object.hasOwn(SUPERTONIC_VOICE_FILES, voice);
}

export function resolveSupertonicVoice(voice?: string): string {
  if (voice && isSupertonicVoice(voice)) {
    return voice;
  }
  return SUPERTONIC_DEFAULT_VOICE;
}

export function getSupertonicVoiceFilename(voice: string): string {
  const resolvedVoice = resolveSupertonicVoice(voice);
  return SUPERTONIC_VOICE_FILES[resolvedVoice];
}

export function buildTransformersRemoteFileUrl({
  remoteHost,
  remotePathTemplate,
  modelId,
  revision,
  filename,
}: TransformersRemoteFileUrlOptions): string {
  const template = remotePathTemplate
    .replace("{model}", modelId)
    .replace("{revision}", revision);
  const normalizedTemplate = template.endsWith("/") ? template : `${template}/`;
  return new URL(`${normalizedTemplate}${filename}`, remoteHost).toString();
}

export function validateSupertonicVoiceEmbedding(
  embedding: Float32Array,
  filename: string,
  styleDim: number,
): Float32Array {
  if (!Number.isInteger(styleDim) || styleDim <= 0) {
    throw new Error("Supertonic style dimension is unavailable.");
  }

  if (embedding.length === 0 || embedding.length % styleDim !== 0) {
    throw new Error(`Embedding file appears truncated for ${filename}.`);
  }

  return embedding;
}

export function createSupertonicSpeakerEmbeddingsTensor(embedding: Float32Array): Tensor {
  return new Tensor("float32", embedding, [1, embedding.length]);
}

export function getSupertonicBatchSize(
  backend: InferenceBackend | null,
  emitted: number,
  sentenceSpeedVariance: number,
): number {
  if (emitted === 0 || sentenceSpeedVariance !== 0) {
    return 1;
  }

  if (backend === "webgpu") {
    return 3;
  }

  if (backend === "wasm") {
    return 2;
  }

  return 1;
}

export function takeSupertonicBatch(
  queue: QueuedSupertonicChunk[],
  options: SupertonicBatchSelectionOptions,
): QueuedSupertonicChunk[] {
  if (queue.length === 0) return [];

  const batchSize = getSupertonicBatchSize(
    options.backend,
    options.emitted,
    options.sentenceSpeedVariance,
  );

  return queue.splice(0, Math.min(queue.length, batchSize));
}

export function createSupertonicVoiceStore(
  fetchBinaryFile: (filename: string) => Promise<ArrayBuffer>,
  parseEmbeddingBuffer: (buffer: ArrayBuffer, filename: string) => Float32Array,
): SupertonicVoiceStore {
  const cachedVoices = new Map<string, Float32Array>();
  const inFlightVoices = new Map<string, Promise<Float32Array>>();

  const loadVoice = async (voice: string): Promise<Float32Array> => {
    const resolvedVoice = resolveSupertonicVoice(voice);
    const existing = cachedVoices.get(resolvedVoice);
    if (existing) return existing;

    const pending = inFlightVoices.get(resolvedVoice);
    if (pending) return pending;

    const filename = getSupertonicVoiceFilename(resolvedVoice);
    const promise = fetchBinaryFile(filename)
      .then((buffer) => parseEmbeddingBuffer(buffer, filename))
      .then((embedding) => {
        cachedVoices.set(resolvedVoice, embedding);
        inFlightVoices.delete(resolvedVoice);
        return embedding;
      })
      .catch((error: unknown) => {
        inFlightVoices.delete(resolvedVoice);
        throw error;
      });

    inFlightVoices.set(resolvedVoice, promise);
    return promise;
  };

  return {
    clear() {
      cachedVoices.clear();
      inFlightVoices.clear();
    },
    ensure(voice: string) {
      return loadVoice(voice);
    },
    get(voice: string) {
      return cachedVoices.get(resolveSupertonicVoice(voice)) ?? null;
    },
    preload(voice: string) {
      return loadVoice(voice);
    },
  };
}
