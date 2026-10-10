import { describe, expect, it } from "vitest";
import type { AudioSegment } from "../../hooks/useAudioPlayer";
import { findSegmentForTextOffset, segmentSpeechEndSec } from "./readerSegments";

function segment(id: string, textStart: number | undefined, textEnd: number | undefined, startSec = 0): AudioSegment {
  return { id, text: id, startSec, endSec: startSec + 1, index: 1, total: 1, textStart, textEnd };
}

describe("findSegmentForTextOffset", () => {
  const segments = [segment("a", 0, 10), segment("b", 14, 20), segment("c", 20, 30)];

  it("returns the segment that covers an offset", () => {
    expect(findSegmentForTextOffset(segments, 5)?.id).toBe("a");
    expect(findSegmentForTextOffset(segments, 20)?.id).toBe("c");
  });

  it("resolves a gap to the next segment and a tail to the last generated one", () => {
    expect(findSegmentForTextOffset(segments, 12)?.id).toBe("b");
    expect(findSegmentForTextOffset(segments, 45)?.id).toBe("c");
  });

  it("ignores segments without text ranges", () => {
    expect(findSegmentForTextOffset([segment("x", undefined, undefined)], 3)).toBeUndefined();
    expect(findSegmentForTextOffset([], 3)).toBeUndefined();
  });
});

describe("segmentSpeechEndSec", () => {
  it("ends speech before the pause that trails a segment", () => {
    expect(segmentSpeechEndSec({ ...segment("a", 0, 1, 2), endSec: 5, pauseAfterSec: 0.5 })).toBe(4.5);
    expect(segmentSpeechEndSec({ ...segment("a", 0, 1, 2), endSec: 5 })).toBe(5);
    expect(segmentSpeechEndSec({ ...segment("a", 0, 1, 2), endSec: 3, pauseAfterSec: 9 })).toBe(2);
  });
});
