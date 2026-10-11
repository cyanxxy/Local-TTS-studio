// @vitest-environment node

import { describe, expect, it } from "vitest";
import { AudioStreamValidator } from "./audioStreamValidator";

const LIMITS = { maxRequestAudioSamples: 10_000, maxRequestAudioBytes: 40_000 };

function metadata(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "audio_chunk",
    requestId: "r1",
    index,
    total: 0,
    sampleRate: 24_000,
    sampleCount: 2,
    silenceAfterSamples: 0,
    ...overrides,
  };
}

function audio(sampleCount = 2): ArrayBuffer {
  return new Float32Array(sampleCount).buffer;
}

function streamChunks(validator: AudioStreamValidator, count: number, overrides: Record<string, unknown> = {}): void {
  for (let index = 0; index < count; index += 1) {
    validator.acceptMetadata(metadata(index, overrides));
    validator.acceptBinary(audio());
  }
}

function result(audioChunkCount: number, sampleRate = 24_000): Record<string, unknown> {
  return { type: "result", requestId: "r1", ok: true, result: { audioChunkCount, sampleRate } };
}

describe("AudioStreamValidator", () => {
  it("pairs each metadata frame with its binary frame", () => {
    const validator = new AudioStreamValidator("r1", true, LIMITS);
    validator.acceptMetadata(metadata(0, { total: 1, silenceAfterSamples: 4 }));
    expect(validator.hasPendingChunk).toBe(true);

    const bytes = audio();
    const chunk = validator.acceptBinary(bytes);

    expect(chunk).toEqual({
      requestId: "r1",
      index: 0,
      total: 1,
      sampleRate: 24_000,
      sampleCount: 2,
      silenceAfterSamples: 4,
      audio: bytes,
    });
    expect(chunk.audio).toBe(bytes);
    expect(validator.hasPendingChunk).toBe(false);
    expect(validator.chunkCount).toBe(1);
    expect(() => validator.verifyResult(result(1))).not.toThrow();
  });

  it("refuses audio of either kind for a command request, but still checks nothing in its result", () => {
    const validator = new AudioStreamValidator("w1", false, LIMITS);
    expect(() => validator.acceptMetadata(metadata(0))).toThrow("unexpected audio for a command request");
    expect(() => validator.acceptBinary(audio())).toThrow("unexpected audio for a command request");
    expect(() => validator.verifyResult({ ok: true, result: {} })).not.toThrow();
  });

  it("requires metadata before every binary frame and one binary frame per metadata frame", () => {
    const validator = new AudioStreamValidator("r1", true, LIMITS);
    expect(() => validator.acceptBinary(audio())).toThrow("binary frame without metadata");

    validator.acceptMetadata(metadata(0));
    expect(() => validator.acceptMetadata(metadata(1))).toThrow("metadata before the pending binary frame");
  });

  it("checks the binary length against the declared sample count", () => {
    const validator = new AudioStreamValidator("r1", true, LIMITS);
    validator.acceptMetadata(metadata(0, { sampleCount: 3 }));
    expect(() => validator.acceptBinary(audio(2))).toThrow("unexpected byte length");
    // The broken pair is consumed, so the failure does not repeat.
    expect(validator.hasPendingChunk).toBe(false);
  });

  it("requires indexes in order without duplicates or gaps", () => {
    const validator = new AudioStreamValidator("r1", true, LIMITS);
    streamChunks(validator, 2);

    expect(() => validator.acceptMetadata(metadata(1))).toThrow("duplicate audio chunk index");
    expect(() => validator.acceptMetadata(metadata(0))).toThrow("duplicate audio chunk index");
    expect(() => validator.acceptMetadata(metadata(3))).toThrow("out of sequence");
    expect(() => validator.acceptMetadata(metadata(2))).not.toThrow();
  });

  it("refuses a sample rate or a declared total that changes mid-stream", () => {
    const rate = new AudioStreamValidator("r1", true, LIMITS);
    streamChunks(rate, 1);
    expect(() => rate.acceptMetadata(metadata(1, { sampleRate: 48_000 }))).toThrow("changed the audio sample rate");

    const total = new AudioStreamValidator("r1", true, LIMITS);
    streamChunks(total, 1, { total: 3 });
    expect(() => total.acceptMetadata(metadata(1, { total: 4 }))).toThrow("changed the audio chunk total");
    // An unknown total (0) after a declared one is still allowed.
    expect(() => total.acceptMetadata(metadata(1, { total: 0 }))).not.toThrow();
  });

  it("keeps the request under its audio budget, trailing silence included", () => {
    const validator = new AudioStreamValidator("r1", true, { maxRequestAudioSamples: 10, maxRequestAudioBytes: 40 });
    validator.acceptMetadata(metadata(0, { sampleCount: 4, silenceAfterSamples: 2 }));
    validator.acceptBinary(audio(4));

    expect(() => validator.acceptMetadata(metadata(1, { sampleCount: 4, silenceAfterSamples: 1 })))
      .toThrow("audio exceeded the 40-byte request limit");
    expect(() => validator.acceptMetadata(metadata(1, { sampleCount: 4 }))).not.toThrow();
  });

  it("checks the result against the streamed chunk count, declared total and sample rate", () => {
    const short = new AudioStreamValidator("r1", true, LIMITS);
    streamChunks(short, 2);
    expect(() => short.verifyResult(result(3))).toThrow("did not match the streamed audio chunk count");

    const declared = new AudioStreamValidator("r1", true, LIMITS);
    streamChunks(declared, 2, { total: 3 });
    expect(() => declared.verifyResult(result(2))).toThrow("did not match the streamed audio chunk count");

    const rate = new AudioStreamValidator("r1", true, LIMITS);
    streamChunks(rate, 1);
    expect(() => rate.verifyResult(result(1, 48_000))).toThrow("did not match the streamed audio sample rate");
  });

  it("rejects a malformed generation result", () => {
    const validator = new AudioStreamValidator("r1", true, LIMITS);
    expect(() => validator.verifyResult({ ok: true, result: { audioChunkCount: 0, sampleRate: 24_000 } }))
      .toThrow("invalid audio chunk count");
  });
});
