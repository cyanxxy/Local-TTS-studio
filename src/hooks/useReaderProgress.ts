import { useCallback, useEffect, useEffectEvent, useMemo, useRef } from "react";
import type { ReaderDocumentRecord, ReaderSection } from "../lib/readerDocument";
import type { UseAudioPlayerReturn } from "./useAudioPlayer";
import type { UseReaderLibraryReturn } from "./useReaderLibrary";

/** How often the Reader samples playback position to persist reading progress. */
export const READER_PROGRESS_SAMPLE_MS = 750;

/** How the Reader moves on when a section finishes. */
export interface ReaderAdvance {
  /** Play and, without saved audio, generate the next section. */
  autoPlay: boolean;
  autoGenerate: boolean;
}

interface Options {
  /** The Reader page is on screen. */
  active: boolean;
  document: ReaderDocumentRecord | null;
  section: ReaderSection | null;
  sectionIndex: number;
  sectionCount: number;
  nextSection: ReaderSection | null;
  player: Pick<
    UseAudioPlayerReturn,
    "activeSegmentId" | "clock" | "getCurrentTime" | "isPlaying" | "isSynthesisComplete" | "segments" | "totalDuration"
  >;
  /** The Reader engine is still synthesizing the section. */
  isGenerating: boolean;
  /** The section's saved audio is still being looked up, so the empty player says nothing. */
  isRestorePending: () => boolean;
  updateProgress: UseReaderLibraryReturn["updateProgress"];
  /** The reader turned on "continue to the next section". */
  autoAdvance: boolean;
  /** Turns to `next`; `continuation` is null when the page should turn without playing. */
  advance: (next: ReaderSection, continuation: ReaderAdvance | null) => void;
}

export interface ReaderProgress {
  /**
   * Holds auto-continuation (the sleep timer): while held, a finished section
   * still turns the page, but the next section neither plays nor generates.
   */
  setAutoAdvanceHold: (held: boolean) => void;
}

/**
 * Records the reading position while the Reader plays, and moves on to the
 * next section once the active one has been synthesized and played to its end.
 */
export function useReaderProgress({
  active,
  document,
  section,
  sectionIndex,
  sectionCount,
  nextSection,
  player,
  isGenerating,
  isRestorePending,
  updateProgress,
  autoAdvance,
  advance,
}: Options): ReaderProgress {
  const {
    activeSegmentId,
    clock,
    getCurrentTime,
    isPlaying,
    isSynthesisComplete,
    segments,
    totalDuration,
  } = player;
  const lastProgressUpdateRef = useRef(0);
  const autoAdvancedSectionRef = useRef<string | null>(null);
  const autoAdvanceHeldRef = useRef(false);
  const sectionId = section?.id ?? null;

  const recordProgress = useCallback(() => {
    if (!active || !document || !section) return;
    // Switching Reader documents resets the shared player before IndexedDB
    // audio has loaded. Never persist that temporary zero state over a real
    // resume point, and do not create progress from an empty transport.
    if (isRestorePending() || segments.length === 0 || totalDuration <= 0) return;
    const currentTime = getCurrentTime();
    const now = Date.now();
    const atEnd = isSynthesisComplete && totalDuration > 0 && currentTime >= totalDuration;
    const isLastSection = sectionIndex === sectionCount - 1;
    const terminalTextOffset = isLastSection && isSynthesisComplete
      ? document.text.length
      : Math.max(section.start, section.end - 1);
    if (atEnd && document.progress.textOffset >= terminalTextOffset) return;
    if (!atEnd && now - lastProgressUpdateRef.current < READER_PROGRESS_SAMPLE_MS) return;
    lastProgressUpdateRef.current = now;

    const segment = segments.find((entry) => entry.id === activeSegmentId);
    let textOffset = document.progress.textOffset;
    if (segment && typeof segment.textStart === "number" && typeof segment.textEnd === "number") {
      const duration = Math.max(0.001, segment.endSec - segment.startSec);
      const ratio = Math.max(0, Math.min(1, (currentTime - segment.startSec) / duration));
      const localOffset = segment.textStart + (segment.textEnd - segment.textStart) * ratio;
      textOffset = section.start + localOffset;
    }
    if (atEnd) textOffset = terminalTextOffset;
    else textOffset = Math.max(section.start, Math.min(terminalTextOffset, textOffset));
    updateProgress({
      positionSec: currentTime,
      totalDurationSec: totalDuration,
      textOffset,
    });
  }, [
    active,
    activeSegmentId,
    document,
    getCurrentTime,
    isRestorePending,
    isSynthesisComplete,
    section,
    sectionCount,
    sectionIndex,
    segments,
    totalDuration,
    updateProgress,
  ]);

  // Transport-shape changes (a new active segment, pausing, the stream ending)
  // are React state, so they still drive a progress write directly.
  useEffect(() => {
    recordProgress();
  }, [recordProgress, isPlaying]);

  useEffect(() => {
    autoAdvancedSectionRef.current = null;
  }, [sectionId]);

  const maybeAutoAdvance = useCallback(() => {
    if (
      !active
      || !autoAdvance
      || !section
      || !nextSection
      || isRestorePending()
      || isGenerating
      || !isSynthesisComplete
      || isPlaying
      || segments.length === 0
      || totalDuration <= 0
      || getCurrentTime() < totalDuration - 0.02
      || autoAdvancedSectionRef.current === section.id
    ) return;
    autoAdvancedSectionRef.current = section.id;
    advance(nextSection, autoAdvanceHeldRef.current ? null : { autoPlay: true, autoGenerate: true });
  }, [
    active,
    advance,
    autoAdvance,
    getCurrentTime,
    isGenerating,
    isPlaying,
    isRestorePending,
    isSynthesisComplete,
    nextSection,
    section,
    segments.length,
    totalDuration,
  ]);

  useEffect(() => {
    maybeAutoAdvance();
  }, [maybeAutoAdvance]);

  // The position itself is not React state, so watch it through the clock
  // instead of a render dependency. The listener fires on the animation frame
  // but re-renders nothing: both callbacks are guarded (a throttle, and a
  // per-section latch) and only touch state when they actually do something.
  // Listening rather than polling also keeps a scrub-while-paused both
  // recording its resume point and honouring auto-advance at the end.
  const onPlaybackTick = useEffectEvent(() => {
    recordProgress();
    maybeAutoAdvance();
  });
  useEffect(() => {
    if (!active) return;
    return clock.subscribe(() => onPlaybackTick());
  }, [active, clock]);

  const setAutoAdvanceHold = useCallback((held: boolean) => {
    autoAdvanceHeldRef.current = held;
  }, []);

  return useMemo(() => ({ setAutoAdvanceHold }), [setAutoAdvanceHold]);
}
