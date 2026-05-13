import { describe, expect, it } from "vitest";
import {
  buildAudioSegments,
  buildCaptionSegments,
  getCaptionEndSec,
  getChunkDuration,
  retimeStoredChunks,
  toAudioSegment,
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
});
