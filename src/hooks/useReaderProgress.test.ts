import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaybackClock } from "../lib/playbackClock";
import { buildReaderSections, createReaderDocument } from "../lib/readerDocument";
import type { AudioSegment as ReaderSegment } from "../lib/audioTimeline";
import { READER_PROGRESS_SAMPLE_MS, useReaderProgress } from "./useReaderProgress";

const document = createReaderDocument({
  id: "progress-book",
  text: "A paragraph long enough to fill several sections. ".repeat(900),
});
const sections = buildReaderSections(document.text, document.chapters);
const [first, second] = sections;

const segment: ReaderSegment = {
  id: "seg",
  text: "spoken",
  startSec: 0,
  endSec: 4,
  index: 1,
  total: 1,
  textStart: 0,
  textEnd: 200,
};

interface Overrides {
  active?: boolean;
  isGenerating?: boolean;
  isPlaying?: boolean;
  isSynthesisComplete?: boolean;
  restorePending?: boolean;
  autoAdvance?: boolean;
  segments?: ReaderSegment[];
  totalDuration?: number;
}

function setup(overrides: Overrides = {}) {
  const clock = new PlaybackClock();
  const updateProgress = vi.fn();
  const advance = vi.fn();
  const view = renderHook((props: Overrides) => useReaderProgress({
    active: props.active ?? true,
    document,
    section: first,
    sectionIndex: 0,
    sectionCount: sections.length,
    nextSection: second,
    player: {
      activeSegmentId: "seg",
      clock,
      getCurrentTime: clock.getTime,
      isPlaying: props.isPlaying ?? false,
      isSynthesisComplete: props.isSynthesisComplete ?? false,
      segments: props.segments ?? [segment],
      totalDuration: props.totalDuration ?? 4,
    },
    isGenerating: props.isGenerating ?? false,
    isRestorePending: () => props.restorePending ?? false,
    updateProgress,
    autoAdvance: props.autoAdvance ?? true,
    advance,
  }), { initialProps: overrides });
  return { ...view, clock, updateProgress, advance };
}

describe("useReaderProgress", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records the position inside the active passage on every clock tick, at most once per sample period", () => {
    const { clock, updateProgress } = setup();
    // Mounting writes once; later ticks inside the sample period do not.
    expect(updateProgress).toHaveBeenCalledTimes(1);
    act(() => clock.set(2));
    expect(updateProgress).toHaveBeenCalledTimes(1);

    vi.spyOn(Date, "now").mockReturnValue(1_000_000 + READER_PROGRESS_SAMPLE_MS);
    act(() => clock.set(2));
    act(() => clock.set(3));
    expect(updateProgress).toHaveBeenLastCalledWith({
      positionSec: 3,
      totalDurationSec: 4,
      textOffset: first.start + 150,
    });
  });

  it("records nothing while the section's saved audio is still being looked up, or without audio", () => {
    expect(setup({ restorePending: true }).updateProgress).not.toHaveBeenCalled();
    expect(setup({ segments: [] }).updateProgress).not.toHaveBeenCalled();
    expect(setup({ totalDuration: 0 }).updateProgress).not.toHaveBeenCalled();
    expect(setup({ active: false }).updateProgress).not.toHaveBeenCalled();
  });

  it("records the section's end when a finished stream is played out", () => {
    const { clock, updateProgress } = setup({ isSynthesisComplete: true });
    updateProgress.mockClear();
    act(() => clock.set(4));
    expect(updateProgress).toHaveBeenLastCalledWith({
      positionSec: 4,
      totalDurationSec: 4,
      textOffset: first.end - 1,
    });
  });

  it("turns to the next section, playing and generating it, once the finished section is played out", () => {
    const { clock, advance } = setup({ isSynthesisComplete: true });
    expect(advance).not.toHaveBeenCalled();

    act(() => clock.set(4));
    expect(advance).toHaveBeenCalledTimes(1);
    expect(advance).toHaveBeenCalledWith(second, { autoPlay: true, autoGenerate: true });

    // Once per section, however many ticks follow.
    act(() => clock.set(3.99));
    act(() => clock.set(4));
    expect(advance).toHaveBeenCalledTimes(1);
  });

  it("turns the page without playing or generating while the sleep timer holds continuation", () => {
    const { clock, advance, result } = setup({ isSynthesisComplete: true });
    act(() => result.current.setAutoAdvanceHold(true));
    act(() => clock.set(4));
    expect(advance).toHaveBeenCalledWith(second, null);
  });

  it("waits for the hold to be released before a later section continues by itself", () => {
    const { clock, advance, result } = setup({ isSynthesisComplete: true });
    act(() => result.current.setAutoAdvanceHold(true));
    act(() => result.current.setAutoAdvanceHold(false));
    act(() => clock.set(4));
    expect(advance).toHaveBeenCalledWith(second, { autoPlay: true, autoGenerate: true });
  });

  it.each([
    ["it is switched off", { autoAdvance: false }],
    ["the Reader is not on screen", { active: false }],
    ["the section is still generating", { isGenerating: true }],
    ["the stream has not finished", { isSynthesisComplete: false }],
    ["audio is still playing", { isPlaying: true }],
    ["the saved audio is still being looked up", { restorePending: true }],
    ["there is no audio", { segments: [] }],
  ] satisfies Array<[string, Overrides]>)("does not continue when %s", (_, overrides) => {
    const { clock, advance } = setup({ isSynthesisComplete: true, ...overrides });
    act(() => clock.set(4));
    expect(advance).not.toHaveBeenCalled();
  });

  it("does not continue before the end", () => {
    const { clock, advance } = setup({ isSynthesisComplete: true });
    act(() => clock.set(3.9));
    expect(advance).not.toHaveBeenCalled();
  });

  it("stops listening to the clock when the Reader leaves the screen", () => {
    const { clock, rerender, updateProgress, advance } = setup({ isSynthesisComplete: true });
    rerender({ isSynthesisComplete: true, active: false });
    updateProgress.mockClear();
    act(() => clock.set(4));
    expect(updateProgress).not.toHaveBeenCalled();
    expect(advance).not.toHaveBeenCalled();
  });
});
