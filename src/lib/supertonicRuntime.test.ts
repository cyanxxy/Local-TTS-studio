import { describe, expect, it, vi } from "vitest";
import {
  buildTransformersRemoteFileUrl,
  createSupertonicSpeakerEmbeddingsTensor,
  createSupertonicVoiceStore,
  getSupertonicBatchSize,
  getSupertonicVoiceFilename,
  resolveSupertonicVoice,
  takeSupertonicBatch,
  type QueuedSupertonicChunk,
  validateSupertonicVoiceEmbedding,
} from "./supertonicRuntime";

function createQueue(length: number): QueuedSupertonicChunk[] {
  return Array.from({ length }, (_, index) => ({
    chunk: {
      text: `Chunk ${index + 1}`,
      start: index * 10,
      end: index * 10 + 6,
      pauseAfterSec: 0,
      pauseKind: "none",
    },
    depth: 0,
  }));
}

describe("supertonicRuntime", () => {
  it("builds pinned model file URLs from the Transformers.js remote template", () => {
    expect(buildTransformersRemoteFileUrl({
      remoteHost: "https://huggingface.co",
      remotePathTemplate: "/{model}/resolve/{revision}/",
      modelId: "onnx-community/Supertonic-TTS-2-ONNX",
      revision: "68d4d9420d0e0e51d14656e1ec5c9b091490b49e",
      filename: "voices/F1.bin",
    })).toBe(
      "https://huggingface.co/onnx-community/Supertonic-TTS-2-ONNX/resolve/68d4d9420d0e0e51d14656e1ec5c9b091490b49e/voices/F1.bin",
    );
  });

  it("wraps speaker embeddings in a single-row tensor for batch-safe reuse", () => {
    const tensor = createSupertonicSpeakerEmbeddingsTensor(new Float32Array([1, 2, 3, 4]));

    expect(tensor.dims).toEqual([1, 4]);
  });

  it("validates voice embeddings against the model style dimension", () => {
    const valid = new Float32Array(256);
    expect(validateSupertonicVoiceEmbedding(valid, "voices/F1.bin", 128)).toBe(valid);
    expect(() => validateSupertonicVoiceEmbedding(new Float32Array(129), "voices/F1.bin", 128))
      .toThrow("Embedding file appears truncated for voices/F1.bin.");
  });

  it("resolves voice filenames and defaults unknown voices to Female", () => {
    expect(resolveSupertonicVoice("Male")).toBe("Male");
    expect(resolveSupertonicVoice("Female 4")).toBe("Female 4");
    expect(resolveSupertonicVoice("Unknown")).toBe("Female");
    expect(getSupertonicVoiceFilename("Female")).toBe("voices/F1.bin");
    expect(getSupertonicVoiceFilename("Female 4")).toBe("voices/F4.bin");
    expect(getSupertonicVoiceFilename("Male")).toBe("voices/M1.bin");
    expect(getSupertonicVoiceFilename("Male 5")).toBe("voices/M5.bin");
    expect(getSupertonicVoiceFilename("Unknown")).toBe("voices/F1.bin");
  });

  it("preloads a voice once and reuses the cached embedding", async () => {
    const fetchBinaryFile = vi.fn(async (filename: string) => new TextEncoder().encode(filename).buffer);
    const parseEmbeddingBuffer = vi.fn((buffer: ArrayBuffer) => new Float32Array([buffer.byteLength]));
    const store = createSupertonicVoiceStore(fetchBinaryFile, parseEmbeddingBuffer);

    const first = await store.preload("Male");
    const second = await store.ensure("Male");

    expect(fetchBinaryFile).toHaveBeenCalledTimes(1);
    expect(fetchBinaryFile).toHaveBeenCalledWith("voices/M1.bin");
    expect(parseEmbeddingBuffer).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(store.get("Male")).toBe(first);
  });

  it("lazy-loads a missing voice only once when requested repeatedly", async () => {
    const fetchBinaryFile = vi.fn(async (filename: string) => new TextEncoder().encode(filename).buffer);
    const parseEmbeddingBuffer = vi.fn((buffer: ArrayBuffer) => new Float32Array([buffer.byteLength]));
    const store = createSupertonicVoiceStore(fetchBinaryFile, parseEmbeddingBuffer);

    const [first, second] = await Promise.all([
      store.ensure("Female"),
      store.ensure("Female"),
    ]);

    expect(fetchBinaryFile).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it("keeps the first emitted chunk single-shot before batching", () => {
    const queue = createQueue(4);
    const selected = takeSupertonicBatch(queue, {
      backend: "webgpu",
      emitted: 0,
      sentenceSpeedVariance: 0,
    });

    expect(selected).toHaveLength(1);
    expect(queue).toHaveLength(3);
  });

  it("uses backend-specific batch sizes after the first chunk", () => {
    expect(getSupertonicBatchSize("webgpu", 1, 0)).toBe(3);
    expect(getSupertonicBatchSize("wasm", 1, 0)).toBe(2);
  });

  it("disables batching when sentence speed variance is enabled", () => {
    const queue = createQueue(4);
    const selected = takeSupertonicBatch(queue, {
      backend: "webgpu",
      emitted: 2,
      sentenceSpeedVariance: 0.15,
    });

    expect(selected).toHaveLength(1);
    expect(queue).toHaveLength(3);
  });
});
