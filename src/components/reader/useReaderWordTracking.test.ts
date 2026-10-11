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
    const { result } = renderHook(() => useReaderWordTracking(clock, segment, true));

    expect(result.current).toEqual({ wordIndex: 0, wordRange: { start: 10, end: 15 } });

    act(() => clock.set(1.5));
    expect(result.current).toEqual({ wordIndex: 1, wordRange: { start: 16, end: 29 } });
  });

  it("tracks nothing without a segment, while timing is unstable, or between words", () => {
    const clock = new PlaybackClock();
    clock.set(1.5);
    const { result, rerender } = renderHook(
      ({ active, stable }: { active: AudioSegment | null; stable: boolean }) => (
        useReaderWordTracking(clock, active, stable)
      ),
      { initialProps: { active: null as AudioSegment | null, stable: true } },
    );
    expect(result.current).toEqual({ wordIndex: -1, wordRange: null });

    rerender({ active: segment, stable: false });
    expect(result.current).toEqual({ wordIndex: -1, wordRange: null });

    rerender({ active: segment, stable: true });
    act(() => clock.set(9));
    expect(result.current).toEqual({ wordIndex: -1, wordRange: null });
  });
});
