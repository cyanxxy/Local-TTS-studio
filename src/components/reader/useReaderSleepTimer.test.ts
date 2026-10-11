import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaybackClock } from "../../lib/playbackClock";
import { useReaderSleepTimer } from "./useReaderSleepTimer";

interface Props {
  sectionKey: string;
  atChapterEnd: boolean;
  hasNextSection: boolean;
  totalDuration: number;
  isPlaying: boolean;
  isGenerating: boolean;
}

const MIDDLE_OF_CHAPTER: Props = {
  sectionKey: "book:chapter-1:section-1",
  atChapterEnd: false,
  hasNextSection: true,
  totalDuration: 60,
  isPlaying: true,
  isGenerating: false,
};

const LAST_PART_OF_CHAPTER: Props = {
  ...MIDDLE_OF_CHAPTER,
  sectionKey: "book:chapter-1:section-2",
  atChapterEnd: true,
};

function setup(initial: Props = MIDDLE_OF_CHAPTER) {
  const clock = new PlaybackClock();
  const onPause = vi.fn();
  const onStopGeneration = vi.fn();
  const onHoldChange = vi.fn();
  const view = renderHook((props: Props) => useReaderSleepTimer({
    ...props,
    clock,
    onPause,
    onStopGeneration,
    onHoldChange,
  }), { initialProps: initial });
  return { ...view, clock, onPause, onStopGeneration, onHoldChange };
}

describe("useReaderSleepTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts a timed timer down on the chip and pauses playback when it runs out", () => {
    const { result, onPause, onHoldChange } = setup();

    act(() => result.current.start("15"));
    expect(result.current.choice).toBe("15");
    expect(result.current.label).toBe("15m");

    act(() => vi.advanceTimersByTime(14 * 60_000 + 30_000));
    expect(result.current.label).toBe("1m");

    act(() => vi.advanceTimersByTime(30_000));
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(result.current.label).toBeNull();
    expect(result.current.holdsContinuation).toBe(false);
    expect(onHoldChange).not.toHaveBeenCalled();
  });

  it("can be cancelled before it runs out", () => {
    const { result, onPause } = setup();
    act(() => result.current.start("30"));

    act(() => result.current.start("off"));
    act(() => vi.advanceTimersByTime(30 * 60_000));

    expect(result.current.label).toBeNull();
    expect(onPause).not.toHaveBeenCalled();
  });

  it("holds continuation when a timed timer runs out as the section ends", () => {
    const { result, rerender, clock, onPause, onHoldChange } = setup();
    act(() => result.current.start("15"));
    rerender({ ...MIDDLE_OF_CHAPTER, isPlaying: false });
    act(() => clock.set(60));

    act(() => vi.advanceTimersByTime(15 * 60_000));

    expect(onPause).not.toHaveBeenCalled();
    expect(result.current.holdsContinuation).toBe(true);
    expect(onHoldChange).toHaveBeenLastCalledWith(true);

    rerender({ ...MIDDLE_OF_CHAPTER, sectionKey: "book:chapter-1:section-2", isPlaying: false, totalDuration: 0 });
    expect(result.current.holdsContinuation).toBe(false);
    expect(onHoldChange).toHaveBeenLastCalledWith(false);
  });

  it("stops a continuation that is still synthesizing when the timer runs out", () => {
    const { result, rerender, onStopGeneration, onPause } = setup();
    act(() => result.current.start("15"));
    rerender({ ...MIDDLE_OF_CHAPTER, totalDuration: 0, isPlaying: false, isGenerating: true });

    act(() => vi.advanceTimersByTime(15 * 60_000));

    expect(onStopGeneration).toHaveBeenCalledTimes(1);
    expect(onPause).not.toHaveBeenCalled();
    expect(result.current.label).toBeNull();
  });

  it("leaves a paused section alone when the timer runs out mid-section", () => {
    const { result, rerender, clock, onPause, onStopGeneration, onHoldChange } = setup();
    act(() => result.current.start("15"));
    rerender({ ...MIDDLE_OF_CHAPTER, isPlaying: false, isGenerating: true });
    act(() => clock.set(20));

    act(() => vi.advanceTimersByTime(15 * 60_000));

    expect(onPause).not.toHaveBeenCalled();
    expect(onStopGeneration).not.toHaveBeenCalled();
    expect(onHoldChange).not.toHaveBeenCalled();
    expect(result.current.label).toBeNull();
  });

  it("lets playback continue inside the chapter and holds it at the chapter's end", () => {
    const { result, rerender, onHoldChange } = setup();
    act(() => result.current.start("chapter"));
    expect(result.current.label).toBe("End of chapter");
    expect(result.current.holdsContinuation).toBe(false);

    rerender(LAST_PART_OF_CHAPTER);
    expect(result.current.holdsContinuation).toBe(true);
    expect(onHoldChange).toHaveBeenLastCalledWith(true);
  });

  it("switches off once the chapter has played out, holding until the page turns", () => {
    const { result, rerender, clock, onHoldChange, onPause } = setup(LAST_PART_OF_CHAPTER);
    act(() => result.current.start("chapter"));

    act(() => clock.set(60));
    rerender({ ...LAST_PART_OF_CHAPTER, isPlaying: false });

    expect(result.current.label).toBeNull();
    expect(result.current.choice).toBe("off");
    expect(result.current.holdsContinuation).toBe(true);
    expect(onPause).not.toHaveBeenCalled();
    expect(onHoldChange).toHaveBeenCalledTimes(1);

    rerender({ ...MIDDLE_OF_CHAPTER, sectionKey: "book:chapter-2:section-1", isPlaying: false, totalDuration: 0 });
    expect(result.current.holdsContinuation).toBe(false);
    expect(onHoldChange).toHaveBeenLastCalledWith(false);
  });

  it("does not fire while a stream has only drained its buffer", () => {
    const { result, rerender, clock } = setup(LAST_PART_OF_CHAPTER);
    act(() => result.current.start("chapter"));

    act(() => clock.set(60));
    rerender({ ...LAST_PART_OF_CHAPTER, isPlaying: false, isGenerating: true });

    expect(result.current.label).toBe("End of chapter");
  });

  it("does not fire for a chapter that had already ended when it was set", () => {
    const { result, clock } = setup({ ...LAST_PART_OF_CHAPTER, isPlaying: false });
    act(() => clock.set(60));

    act(() => result.current.start("chapter"));

    expect(result.current.label).toBe("End of chapter");
  });

  it("clears at the end of the book without holding anything", () => {
    const lastSection = { ...LAST_PART_OF_CHAPTER, hasNextSection: false };
    const { result, rerender, clock, onHoldChange } = setup(lastSection);
    act(() => result.current.start("chapter"));
    expect(result.current.holdsContinuation).toBe(false);

    act(() => clock.set(60));
    rerender({ ...lastSection, isPlaying: false });

    expect(result.current.label).toBeNull();
    expect(result.current.holdsContinuation).toBe(false);
    expect(onHoldChange).not.toHaveBeenCalled();
  });

  it("releases a hold when the Reader unmounts", () => {
    const { result, unmount, onHoldChange } = setup(LAST_PART_OF_CHAPTER);
    act(() => result.current.start("chapter"));
    expect(onHoldChange).toHaveBeenLastCalledWith(true);

    unmount();

    expect(onHoldChange).toHaveBeenLastCalledWith(false);
  });
});
