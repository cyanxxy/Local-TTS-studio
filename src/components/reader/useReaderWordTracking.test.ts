import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AudioSegment } from "../../hooks/useAudioPlayer";
import { PlaybackClock } from "../../lib/playbackClock";
import { useReaderWordTracking } from "./useReaderWordTracking";

const segment: AudioSegment = {
  id: "segment-1",
  text: "Hello extraordinary world.",
  startSec: 0,
  endSec: 3,
  index: 1,
  total: 1,
  textStart: 10,
  textEnd: 36,
};

describe("useReaderWordTracking", () => {
  it("follows the spoken word through the active segment as the clock moves", () => {
    const clock = new PlaybackClock();
    clock.set(0.2);
    const { result } = renderHook(() => useReaderWordTracking(clock, segment, null));

    expect(result.current).toEqual({ wordIndex: 0, wordRange: { start: 10, end: 15 } });

    act(() => clock.set(1.5));
    expect(result.current).toEqual({ wordIndex: 1, wordRange: { start: 16, end: 29 } });
  });

  it("tracks nothing without a segment or between words", () => {
    const clock = new PlaybackClock();
    clock.set(1.5);
    const { result, rerender } = renderHook(
      ({ active }: { active: AudioSegment | null }) => useReaderWordTracking(clock, active, null),
      { initialProps: { active: null as AudioSegment | null } },
    );
    expect(result.current).toEqual({ wordIndex: -1, wordRange: null });

    rerender({ active: segment });
    act(() => clock.set(9));
    expect(result.current).toEqual({ wordIndex: -1, wordRange: null });
  });

  it("suppresses the segment still growing but tracks the finished one while generating", () => {
    const finished: AudioSegment = { ...segment, id: "segment-1", startSec: 0, endSec: 3 };
    const growing: AudioSegment = {
      ...segment,
      id: "segment-2",
      text: "Another growing sentence.",
      startSec: 3,
      endSec: 5,
      textStart: 40,
      textEnd: 65,
    };
    const clock = new PlaybackClock();
    clock.set(0.2);
    const { result, rerender } = renderHook(
      ({ active, growingId }: { active: AudioSegment; growingId: string | null }) => (
        useReaderWordTracking(clock, active, growingId)
      ),
      { initialProps: { active: finished, growingId: growing.id as string | null } },
    );
    expect(result.current).toEqual({ wordIndex: 0, wordRange: { start: 10, end: 15 } });

    act(() => clock.set(3.2));
    rerender({ active: growing, growingId: growing.id });
    expect(result.current).toEqual({ wordIndex: -1, wordRange: null });

    // Once generation ends nothing is growing, so the last segment tracks too.
    rerender({ active: growing, growingId: null });
    expect(result.current.wordIndex).toBe(0);
  });
});
