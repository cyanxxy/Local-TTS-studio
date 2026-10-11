import { useCallback, useMemo } from "react";
import type { AudioSegment } from "../../hooks/useAudioPlayer";
import { usePlaybackSelector, type PlaybackClock } from "../../lib/playbackClock";
import type { EstimatedWordRange } from "../../lib/readerDocument";
import { estimateSegmentWords } from "./readerSegments";
import type { TextRange } from "./readerTextLayout";

const NO_WORDS: EstimatedWordRange[] = [];

export interface ReaderWordTracking {
  /** Index of the spoken word in the active segment, or -1. */
  wordIndex: number;
  /** Section-local offsets of the spoken word. */
  wordRange: TextRange | null;
}

/**
 * Follows the spoken word through the active segment. Selecting an index
 * rather than the position itself keeps the subscriber off the animation-frame
 * path: the value only changes when the spoken word does, a few times a
 * second. Only the reading pane subscribes, so the rest of the Reader does not
 * re-render at word rate.
 */
export function useReaderWordTracking(
  clock: PlaybackClock,
  activeSegment: AudioSegment | null,
  /** False while a streaming model is still extending segment durations. */
  trackingStable: boolean,
): ReaderWordTracking {
  const words = useMemo(
    () => (trackingStable && activeSegment ? estimateSegmentWords(activeSegment) : NO_WORDS),
    [activeSegment, trackingStable],
  );
  const selectWordIndex = useCallback(
    (timeSec: number) => words.findIndex((word) => timeSec >= word.startSec && timeSec < word.endSec),
    [words],
  );
  const wordIndex = usePlaybackSelector(clock, selectWordIndex);
  const wordRange = useMemo(() => {
    const word = wordIndex >= 0 ? words[wordIndex] : undefined;
    return word ? { start: word.start, end: word.end } : null;
  }, [wordIndex, words]);
  return { wordIndex, wordRange };
}
