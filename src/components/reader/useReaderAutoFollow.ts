import {
  useCallback,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

/** Auto-follow leaves the page alone while the spoken word sits in this band. */
const FOLLOW_BAND_TOP = 0.12;
const FOLLOW_BAND_BOTTOM = 0.62;
/** How long scroll events after our own scroll are not treated as the user's. */
const INSTANT_SCROLL_GRACE_MS = 120;
const SMOOTH_SCROLL_GRACE_MS = 800;

function prefersReducedMotion(): boolean {
  if (document.documentElement.dataset.motion === "reduced") return true;
  return typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

interface UseReaderAutoFollowOptions {
  /**
   * Identifies what the pane shows (document, section and text). A pause the
   * user caused by scrolling belongs to that view and lapses when it changes.
   */
  scope: string;
  documentId: string | null;
  sectionId: string | null;
  /** Document offset of the active section, or null without one. */
  sectionStart: number | null;
  editing: boolean;
  isPlaying: boolean;
  hasAudio: boolean;
  scrollerRef: RefObject<HTMLDivElement | null>;
  articleRef: RefObject<HTMLElement | null>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

export interface ReaderAutoFollow {
  /** The user scrolled away during playback and auto-follow is holding still. */
  followPaused: boolean;
  /** The reading pane's scroll handler. */
  handleScroll: () => void;
  /** Hands control back to auto-follow and recentres the spoken word. */
  resume: () => void;
  /** Hands control back to auto-follow without scrolling, e.g. before a jump. */
  release: () => void;
  /** Glides the spoken word back into view when it has left the comfortable band. */
  scrollMarkerIntoView: (recenter?: boolean) => void;
  /** Scrolls a section-local text offset into the upper third of the pane. */
  scrollToLocalOffset: (localOffset: number) => void;
  /** Scrolls to a document offset once the section holding it has rendered. */
  scrollAfterSectionChange: (documentOffset: number) => void;
}

/**
 * Auto-follow hands control back the moment the user scrolls during playback,
 * and stays paused until they resume it deliberately (pill, jump, or replay).
 * Our own scrolls open a short grace window instead of a one-shot flag: a
 * smooth scroll fires many `scroll` events, and a flag left armed by a no-op
 * scroll would swallow the user's next real one.
 */
export function useReaderAutoFollow({
  scope,
  documentId,
  sectionId,
  sectionStart,
  editing,
  isPlaying,
  hasAudio,
  scrollerRef,
  articleRef,
  textareaRef,
}: UseReaderAutoFollowOptions): ReaderAutoFollow {
  const [followState, setFollowState] = useState({
    pausedScope: null as string | null,
    wasPlaying: isPlaying,
  });
  if (followState.wasPlaying !== isPlaying) {
    // Playback starting again re-enables auto-follow wherever it was started
    // from — the dock, Space, auto-continue or a streamed chunk. Adjusting
    // during render keeps the "Resume auto-follow" pill from painting for a
    // frame while audio is already playing.
    setFollowState({
      pausedScope: isPlaying ? null : followState.pausedScope,
      wasPlaying: isPlaying,
    });
  }
  const followPaused = followState.pausedScope !== null && followState.pausedScope === scope;
  const programmaticScrollUntilRef = useRef(0);
  // Cross-section jumps land after the new section's text renders; this holds
  // the document offset to scroll to once that happens.
  const pendingScrollOffsetRef = useRef<number | null>(null);

  const handleScroll = useCallback(() => {
    if (performance.now() < programmaticScrollUntilRef.current) return;
    if (!isPlaying || !hasAudio) return;
    setFollowState((current) => (
      current.pausedScope === scope ? current : { ...current, pausedScope: scope }
    ));
  }, [hasAudio, isPlaying, scope]);

  const release = useCallback(() => {
    setFollowState((current) => (
      current.pausedScope === null ? current : { ...current, pausedScope: null }
    ));
  }, []);

  const scrollMarkerIntoView = useCallback((recenter = false) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const marker = scroller.querySelector<HTMLElement>(".reader-word-highlight-active")
      ?? scroller.querySelector<HTMLElement>(".reader-chunk-highlight-active");
    if (!marker) return;

    const height = scroller.clientHeight;
    const markerTop = marker.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    // The page holds still while the spoken word stays in a comfortable band;
    // re-pinning it on every new line made the text lurch every few seconds.
    if (!recenter && markerTop >= height * FOLLOW_BAND_TOP && markerTop <= height * FOLLOW_BAND_BOTTOM) return;

    // When it leaves the band, glide it back to the upper third, book-style.
    const lead = Math.max(32, height * 0.28);
    const nextTop = Math.max(0, scroller.scrollTop + markerTop - lead);
    if (Math.abs(scroller.scrollTop - nextTop) < 1) return;
    const smooth = !recenter && !prefersReducedMotion() && typeof scroller.scrollTo === "function";
    programmaticScrollUntilRef.current = performance.now()
      + (smooth ? SMOOTH_SCROLL_GRACE_MS : INSTANT_SCROLL_GRACE_MS);
    if (smooth) scroller.scrollTo({ top: nextTop, behavior: "smooth" });
    else scroller.scrollTop = nextTop;
  }, [scrollerRef]);

  const resume = useCallback(() => {
    release();
    scrollMarkerIntoView(true);
  }, [release, scrollMarkerIntoView]);

  const scrollToLocalOffset = useCallback((localOffset: number) => {
    const scroller = scrollerRef.current;
    const root = articleRef.current;
    if (!scroller || !root) return;
    const paragraphs = [...root.querySelectorAll<HTMLElement>("[data-block-start]")];
    if (paragraphs.length === 0) return;
    let paragraph = paragraphs[0];
    for (const element of paragraphs) {
      if (Number(element.dataset.blockStart) > localOffset) break;
      paragraph = element;
    }

    let remaining = Math.max(0, localOffset - Number(paragraph.dataset.blockStart));
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode() as Text | null;
    while (node && remaining > node.length) {
      remaining -= node.length;
      node = walker.nextNode() as Text | null;
    }
    const range = document.createRange();
    if (node) {
      range.setStart(node, Math.min(node.length, remaining));
    } else {
      range.selectNodeContents(paragraph);
    }
    range.collapse(true);
    const rangeRect = typeof range.getBoundingClientRect === "function"
      ? range.getBoundingClientRect()
      : null;
    const anchorRect = rangeRect && (rangeRect.height > 0 || rangeRect.top !== 0)
      ? rangeRect
      : paragraph.getBoundingClientRect();
    const lead = Math.max(32, scroller.clientHeight * 0.28);
    const nextTop = Math.max(
      0,
      scroller.scrollTop + anchorRect.top - scroller.getBoundingClientRect().top - lead,
    );
    if (Math.abs(scroller.scrollTop - nextTop) < 1) return;
    programmaticScrollUntilRef.current = performance.now() + INSTANT_SCROLL_GRACE_MS;
    scroller.scrollTop = nextTop;
  }, [articleRef, scrollerRef]);

  const scrollAfterSectionChange = useCallback((documentOffset: number) => {
    pendingScrollOffsetRef.current = documentOffset;
  }, []);

  // A new section (or the editor closing) starts at the top, unless a jump
  // parked a destination for the section that just rendered.
  const showSection = useEffectEvent(() => {
    if (editing) return;
    // A grace window opened just before this section change has nothing left to cover.
    programmaticScrollUntilRef.current = 0;
    const pending = pendingScrollOffsetRef.current;
    pendingScrollOffsetRef.current = null;
    if (pending !== null && sectionStart !== null && pending >= sectionStart) {
      scrollToLocalOffset(pending - sectionStart);
      return;
    }
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
    if (textareaRef.current) textareaRef.current.scrollTop = 0;
  });
  useLayoutEffect(() => {
    showSection();
  }, [documentId, sectionId, editing]);

  return {
    followPaused,
    handleScroll,
    resume,
    release,
    scrollMarkerIntoView,
    scrollToLocalOffset,
    scrollAfterSectionChange,
  };
}
