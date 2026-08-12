import { describe, expect, it } from "vitest";
import {
  appendAudioSegment,
  buildAudioSegments,
  buildCaptionSegments,
  getCaptionEndSec,
  getChunkDuration,
  retimeStoredChunks,
  toAudioSegment,
  type AudioSegment,
  type StoredAudioChunk,
} from "./audioTimeline";

function chunk(overrides: Partial<StoredAudioChunk> = {}): StoredAudioChunk {
  return {
    audio: new Float32Array(4),
    samplingRate: 4,
    text: "First segment",
    index: 1,
    total: 2,
    startSec: 10,
    endSec: 11,
    segmentId: "segment-1",
    ...overrides,
  };
}

describe("audioTimeline", () => {
  it("computes chunk and caption durations", () => {
    expect(getChunkDuration(chunk({ audio: new Float32Array(8), samplingRate: 4 }))).toBe(2);
    expect(getCaptionEndSec(chunk({ startSec: 1, endSec: 3, pauseAfterSec: 0.5 }))).toBe(2.5);
    expect(getCaptionEndSec(chunk({ startSec: 1, endSec: 1.2, pauseAfterSec: 2 }))).toBe(1);
  });

  it("builds audio segment labels from chunk metadata or fallbacks", () => {
    expect(toAudioSegment(chunk(), 0, 2)).toMatchObject({
      id: "segment-1",
      text: "First segment",
      index: 1,
      total: 2,
    });

    expect(toAudioSegment(chunk({
      text: "  ",
      index: undefined,
      total: undefined,
    }), 2, 4)).toMatchObject({
      text: "Segment 3",
      index: 3,
      total: 4,
    });
  });

  it("retimes chunks sequentially and builds captions without trailing synthetic pauses", () => {
    const retimed = retimeStoredChunks([
      chunk({ segmentId: "a", audio: new Float32Array(4), samplingRate: 4, text: "A", pauseAfterSec: 0.25 }),
      chunk({ segmentId: "b", audio: new Float32Array(8), samplingRate: 4, text: "", pauseAfterSec: -1 }),
    ]);

    expect(retimed.map(({ startSec, endSec }) => [startSec, endSec])).toEqual([[0, 1], [1, 3]]);
    expect(buildAudioSegments(retimed)).toHaveLength(2);
    expect(buildCaptionSegments(retimed)).toEqual([
      { startSec: 0, endSec: 0.75, text: "A" },
      { startSec: 1, endSec: 3, text: "Section 2" },
    ]);
  });

  it("groups streamed transport chunks that belong to one semantic text unit", () => {
    const chunks = retimeStoredChunks([
      chunk({
        segmentId: "qwen-unit-1",
        audio: new Float32Array(4),
        samplingRate: 4,
        text: "A complete Qwen sentence.",
        textStart: 10,
        textEnd: 35,
        index: 1,
        total: 2,
      }),
      chunk({
        segmentId: "qwen-unit-1",
        audio: new Float32Array(8),
        samplingRate: 4,
        text: "A complete Qwen sentence.",
        textStart: 10,
        textEnd: 35,
        index: 1,
        total: 2,
        pauseAfterSec: 0.2,
      }),
    ]);

    expect(buildAudioSegments(chunks)).toEqual([expect.objectContaining({
      id: "qwen-unit-1",
      text: "A complete Qwen sentence.",
      startSec: 0,
      endSec: 3,
      textStart: 10,
      textEnd: 35,
      index: 1,
      total: 2,
    })]);
    expect(buildCaptionSegments(chunks)).toEqual([{
      startSec: 0,
      endSec: 2.8,
      text: "A complete Qwen sentence.",
    }]);
  });

  it("fills fallback totals without replacing explicit transport totals", () => {
    const segments = buildAudioSegments([
      chunk({ segmentId: "fallback", index: undefined, total: undefined }),
      chunk({ segmentId: "explicit", index: 2, total: 2 }),
    ]);

    expect(segments.map(({ id, total }) => ({ id, total }))).toEqual([
      { id: "fallback", total: 2 },
      { id: "explicit", total: 2 },
    ]);
  });

  it("updates a streamed semantic segment incrementally", () => {
    const segments: AudioSegment[] = [];
    appendAudioSegment(segments, chunk({
      segmentId: "streamed",
      startSec: 0,
      endSec: 1,
      index: 1,
      total: 2,
    }));
    const publishedFirst = [...segments];
    appendAudioSegment(segments, chunk({
      segmentId: "streamed",
      startSec: 1,
      endSec: 3,
      pauseAfterSec: 0.25,
      index: 1,
      total: 2,
    }));

    expect(segments).toEqual([expect.objectContaining({
      id: "streamed",
      startSec: 0,
      endSec: 3,
      pauseAfterSec: 0.25,
    })]);
    expect(publishedFirst[0].endSec).toBe(1);
  });
});
