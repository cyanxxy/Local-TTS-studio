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

  describe("unit gaps", () => {
    const unit = (index: number, total = 3) => ({ textUnitIndex: index, textUnitTotal: total });

    function gap(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        type: "unit_gap",
        requestId: "r1",
        sampleRate: 24_000,
        textUnitIndex: 0,
        textUnitTotal: 3,
        silenceSamples: 100,
        ...overrides,
      };
    }

    function streamedUnit(unitIndex: number): AudioStreamValidator {
      const validator = new AudioStreamValidator("r1", true, LIMITS);
      for (let index = 0; index <= unitIndex; index += 1) {
        validator.acceptMetadata(metadata(index, unit(index)));
        validator.acceptBinary(audio());
        if (index < unitIndex) validator.acceptGap(gap({ textUnitIndex: index }));
      }
      return validator;
    }

    it("places a gap after the last chunk of its text unit without counting it as a chunk", () => {
      const validator = new AudioStreamValidator("r1", true, LIMITS);
      validator.acceptMetadata(metadata(0, unit(0)));
      validator.acceptBinary(audio());
      validator.acceptMetadata(metadata(1, unit(0)));
      validator.acceptBinary(audio());

      expect(validator.acceptGap(gap())).toEqual({
        requestId: "r1",
        afterChunkIndex: 1,
        sampleRate: 24_000,
        silenceSamples: 100,
        textUnitIndex: 0,
        textUnitTotal: 3,
      });
      expect(validator.chunkCount).toBe(2);
      validator.acceptMetadata(metadata(2, unit(1)));
      validator.acceptBinary(audio());
      expect(() => validator.verifyResult(result(3))).not.toThrow();
    });

    it("counts declared silence against the request budget", () => {
      const validator = streamedUnit(0);
      // 2 streamed samples leave 9,998 of the 10,000-sample budget.
      expect(() => validator.acceptGap(gap({ silenceSamples: 9_999 }))).toThrow(/request limit/);
      expect(() => validator.acceptGap(gap({ silenceSamples: 9_998 }))).not.toThrow();
      // The accepted gap used the whole budget, so even a 2-sample chunk is over it.
      expect(() => validator.acceptMetadata(metadata(1, unit(1)))).toThrow(/request limit/);
    });

    it.each([
      ["a gap before any audio", () => new AudioStreamValidator("r1", true, LIMITS), gap(), /before audio/],
      ["a gap for another text unit", () => streamedUnit(0), gap({ textUnitIndex: 1 }), /other than the last/],
      ["a changed text-unit total", () => streamedUnit(0), gap({ textUnitTotal: 4 }), /other than the last/],
      ["a gap after the final text unit", () => streamedUnit(2), gap({ textUnitIndex: 2 }), /after the final/],
      ["a changed sample rate", () => streamedUnit(0), gap({ sampleRate: 48_000 }), /sample rate/],
      ["empty silence", () => streamedUnit(0), gap({ silenceSamples: 0 }), /invalid silence/],
      ["excessive silence", () => streamedUnit(0), gap({ silenceSamples: 192_001 }), /invalid silence/],
      ["a fractional silence count", () => streamedUnit(0), gap({ silenceSamples: 1.5 }), /invalid unit gap/],
      ["a missing text unit", () => streamedUnit(0), gap({ textUnitIndex: undefined }), /invalid unit gap/],
    ])("rejects %s", (_name, build, frame, message) => {
      expect(() => build().acceptGap(frame)).toThrow(message);
    });

    it("rejects a second gap for the same text unit", () => {
      const validator = streamedUnit(0);
      validator.acceptGap(gap());
      expect(() => validator.acceptGap(gap())).toThrow(/duplicate unit gap/);
    });

    it("rejects a gap between a chunk's metadata and its binary frame", () => {
      const validator = new AudioStreamValidator("r1", true, LIMITS);
      validator.acceptMetadata(metadata(0, unit(0)));
      expect(() => validator.acceptGap(gap())).toThrow(/pending binary frame/);
    });

    it("rejects a gap when the last chunk carried no text-unit metadata", () => {
      const validator = new AudioStreamValidator("r1", true, LIMITS);
      validator.acceptMetadata(metadata(0));
      validator.acceptBinary(audio());
      expect(() => validator.acceptGap(gap())).toThrow(/before audio for a text unit/);
    });

    it("rejects a gap for a command request", () => {
      expect(() => new AudioStreamValidator("r1", false, LIMITS).acceptGap(gap())).toThrow(/unexpected audio/);
    });
  });
});
