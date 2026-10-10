import type { AudioSegment } from "../../hooks/useAudioPlayer";

/**
 * The generated segment that covers a section-local text offset. Offsets in a
 * gap between segments resolve to the next segment, and offsets past the last
 * generated segment (a stream still in flight) to the last one before them.
 */
export function findSegmentForTextOffset(
  segments: readonly AudioSegment[],
  targetOffset: number,
): AudioSegment | undefined {
  return segments.find((segment) => (
    typeof segment.textStart === "number"
    && typeof segment.textEnd === "number"
    && targetOffset >= segment.textStart
    && targetOffset < segment.textEnd
  ))
    ?? segments.find((segment) => (
      typeof segment.textStart === "number" && segment.textStart >= targetOffset
    ))
    ?? [...segments].reverse().find((segment) => (
      typeof segment.textEnd === "number" && segment.textEnd <= targetOffset
    ));
}

/** When a segment's speech ends: its audio end minus the pause that trails it. */
export function segmentSpeechEndSec(segment: AudioSegment): number {
  return Math.max(segment.startSec, segment.endSec - Math.max(0, segment.pauseAfterSec ?? 0));
}
