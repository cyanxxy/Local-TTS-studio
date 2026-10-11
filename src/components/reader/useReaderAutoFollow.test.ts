import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReaderAutoFollow } from "./useReaderAutoFollow";

interface Props {
  scope: string;
  sectionId: string | null;
  sectionStart: number | null;
  isPlaying: boolean;
  hasAudio: boolean;
  editing: boolean;
}

function rect(top: number): DOMRect {
  return { x: 0, y: top, top, bottom: top, left: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) };
}

function setup(initial: Partial<Props> = {}) {
  const scroller = document.createElement("div");
  const article = document.createElement("article");
  const textarea = document.createElement("textarea");
  scroller.append(article);
  document.body.append(scroller, textarea);
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 200 });
  const refs = {
    scrollerRef: { current: scroller },
    articleRef: { current: article },
    textareaRef: { current: textarea },
  };
  const view = renderHook((props: Props) => useReaderAutoFollow({
    ...props,
    documentId: "book",
    ...refs,
  }), {
    initialProps: {
      scope: "view-1",
      sectionId: "section-1",
      sectionStart: 0,
      isPlaying: true,
      hasAudio: true,
      editing: false,
      ...initial,
    },
  });
  return { ...view, scroller, article, textarea };
}

describe("useReaderAutoFollow", () => {
  beforeEach(() => {
    vi.spyOn(performance, "now").mockReturnValue(10_000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("pauses when the user scrolls during playback, for the current view only", () => {
    const { result, rerender } = setup();
    expect(result.current.followPaused).toBe(false);

    act(() => result.current.handleScroll());
    expect(result.current.followPaused).toBe(true);

    rerender({ scope: "view-2", sectionId: "section-2", sectionStart: 100, isPlaying: true, hasAudio: true, editing: false });
    expect(result.current.followPaused).toBe(false);
  });

  it("does not pause for scrolls without playing audio", () => {
    const paused = setup({ isPlaying: false });
    act(() => paused.result.current.handleScroll());
    expect(paused.result.current.followPaused).toBe(false);
    paused.unmount();

    const silent = setup({ hasAudio: false });
    act(() => silent.result.current.handleScroll());
    expect(silent.result.current.followPaused).toBe(false);
  });

  it("hands control back when playback starts again", () => {
    const { result, rerender } = setup();
    act(() => result.current.handleScroll());

    const base = { scope: "view-1", sectionId: "section-1", sectionStart: 0, hasAudio: true, editing: false };
    rerender({ ...base, isPlaying: false });
    expect(result.current.followPaused).toBe(true);
    rerender({ ...base, isPlaying: true });
    expect(result.current.followPaused).toBe(false);
  });

  it("releases and resumes on request", () => {
    const { result, scroller, article } = setup();
    const marker = document.createElement("span");
    marker.className = "reader-word-highlight-active";
    article.append(marker);
    vi.spyOn(marker, "getBoundingClientRect").mockReturnValue(rect(150));
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(rect(0));

    act(() => result.current.handleScroll());
    act(() => result.current.release());
    expect(result.current.followPaused).toBe(false);

    act(() => result.current.handleScroll());
    act(() => result.current.resume());
    expect(result.current.followPaused).toBe(false);
    // Recentring puts the word in the upper third: 150 - 0.28 * 200.
    expect(scroller.scrollTop).toBe(94);
  });

  it("leaves the page still while the spoken word sits in the comfortable band", () => {
    const { result, scroller, article } = setup();
    const marker = document.createElement("span");
    marker.className = "reader-chunk-highlight-active";
    article.append(marker);
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(rect(0));
    const markerRect = vi.spyOn(marker, "getBoundingClientRect").mockReturnValue(rect(60));

    act(() => result.current.scrollMarkerIntoView());
    expect(scroller.scrollTop).toBe(0);

    markerRect.mockReturnValue(rect(190));
    act(() => result.current.scrollMarkerIntoView());
    expect(scroller.scrollTop).toBe(134);
  });

  it("does not mistake its own scrolling for the user's", () => {
    const { result, scroller, article } = setup();
    const marker = document.createElement("span");
    marker.className = "reader-word-highlight-active";
    article.append(marker);
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(rect(0));
    vi.spyOn(marker, "getBoundingClientRect").mockReturnValue(rect(190));

    act(() => result.current.scrollMarkerIntoView());
    act(() => result.current.handleScroll());

    expect(result.current.followPaused).toBe(false);
  });

  it("starts a new section at the top unless a jump parked a destination", () => {
    const { result, rerender, scroller, article, textarea } = setup();
    const paragraph = document.createElement("p");
    paragraph.dataset.blockStart = "0";
    paragraph.textContent = "Destination paragraph.";
    article.append(paragraph);
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(rect(0));
    vi.spyOn(paragraph, "getBoundingClientRect").mockReturnValue(rect(400));

    scroller.scrollTop = 300;
    textarea.scrollTop = 50;
    rerender({ scope: "view-2", sectionId: "section-2", sectionStart: 100, isPlaying: true, hasAudio: true, editing: false });
    expect(scroller.scrollTop).toBe(0);
    expect(textarea.scrollTop).toBe(0);

    act(() => result.current.scrollAfterSectionChange(205));
    rerender({ scope: "view-3", sectionId: "section-3", sectionStart: 200, isPlaying: true, hasAudio: true, editing: false });
    expect(scroller.scrollTop).toBe(344);
  });

  it("keeps the editor's scroll position while editing", () => {
    const { rerender, scroller } = setup();
    scroller.scrollTop = 120;

    rerender({ scope: "view-1", sectionId: "section-2", sectionStart: 0, isPlaying: true, hasAudio: true, editing: true });

    expect(scroller.scrollTop).toBe(120);
  });
});
