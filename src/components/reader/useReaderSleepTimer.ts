import { useCallback, useEffect, useEffectEvent, useState } from "react";
import { usePlaybackSelector, type PlaybackClock } from "../../lib/playbackClock";

export type SleepTimerChoice = "off" | "15" | "30" | "60" | "chapter";

export const SLEEP_TIMER_OPTIONS: ReadonlyArray<{ value: SleepTimerChoice; label: string }> = [
  { value: "off", label: "Off" },
  { value: "15", label: "15m" },
  { value: "30", label: "30m" },
  { value: "60", label: "60m" },
  { value: "chapter", label: "Chapter" },
];

/** Playback that stopped this close to the end of the section's audio has finished it. */
const SECTION_END_TOLERANCE_SEC = 0.05;
/** The chip shows minutes left; a half-minute tick keeps it honest. */
const LABEL_TICK_MS = 30_000;

interface UseReaderSleepTimerOptions {
  /** Identifies the active document section. */
  sectionKey: string;
  /** The active section is the last one of its chapter, or of the book. */
  atChapterEnd: boolean;
  /** Another section follows, so auto-continuation could carry playback on. */
  hasNextSection: boolean;
  clock: PlaybackClock;
  totalDuration: number;
  isPlaying: boolean;
  isGenerating: boolean;
  /** Pauses playback; only called while playing. */
  onPause: () => void;
  /** Stops a generation that has not produced audio yet. */
  onStopGeneration: () => void;
  /**
   * Told whether the timer currently forbids continuing into the next section.
   * Auto-continuation is decided by the parent, so this is how the timer stops it.
   */
  onHoldChange?: (held: boolean) => void;
}

export interface ReaderSleepTimer {
  choice: SleepTimerChoice;
  /** The rail chip's text, or null while no timer runs. */
  label: string | null;
  /** True while the timer forbids continuing into the next section. */
  holdsContinuation: boolean;
  start: (choice: SleepTimerChoice) => void;
}

interface SleepTimerState {
  choice: SleepTimerChoice;
  endsAt: number | null;
  /** Section the timer ran out in; continuation stays held until the reader leaves it. */
  asleepIn: string | null;
}

const NO_TIMER: SleepTimerState = { choice: "off", endsAt: null, asleepIn: null };

/**
 * The Reader's sleep timer. A timed timer pauses whatever is playing when it
 * runs out; "End of chapter" lets the chapter's last section play to its end.
 * Either way the next section must not start on its own afterwards, but
 * continuation happens in the parent once playback has already stopped, so the
 * timer reports a hold through `onHoldChange` instead of trying to pause audio
 * that is no longer playing. The hold lasts until the reader leaves the section.
 */
export function useReaderSleepTimer({
  sectionKey,
  atChapterEnd,
  hasNextSection,
  clock,
  totalDuration,
  isPlaying,
  isGenerating,
  onPause,
  onStopGeneration,
  onHoldChange,
}: UseReaderSleepTimerOptions): ReaderSleepTimer {
  const [timer, setTimer] = useState<SleepTimerState>(NO_TIMER);
  const [now, setNow] = useState(() => Date.now());
  const selectAtSectionEnd = useCallback(
    (timeSec: number) => totalDuration > 0 && timeSec >= totalDuration - SECTION_END_TOLERANCE_SEC,
    [totalDuration],
  );
  const atSectionEnd = usePlaybackSelector(clock, selectAtSectionEnd);
  // A stream still in flight can drain the buffer without having finished.
  const playedToEnd = atSectionEnd && !isPlaying && !isGenerating;
  const [wasPlayedToEnd, setWasPlayedToEnd] = useState(playedToEnd);
  if (wasPlayedToEnd !== playedToEnd) {
    setWasPlayedToEnd(playedToEnd);
    // The chapter's last section just played to its end: that is the timer
    // firing. It switches off but keeps holding continuation, so the parent
    // turning the page cannot start the next chapter.
    if (playedToEnd && timer.choice === "chapter" && atChapterEnd) {
      setTimer({ choice: "off", endsAt: null, asleepIn: hasNextSection ? sectionKey : null });
    }
  }

  const holdsContinuation = timer.asleepIn === sectionKey
    || (timer.choice === "chapter" && atChapterEnd && hasNextSection);

  const start = useCallback((choice: SleepTimerChoice) => {
    const startedAt = Date.now();
    setNow(startedAt);
    setTimer({
      choice,
      endsAt: choice === "off" || choice === "chapter" ? null : startedAt + Number(choice) * 60_000,
      asleepIn: null,
    });
  }, []);

  const expire = useEffectEvent(() => {
    const atEnd = totalDuration > 0 && clock.getTime() >= totalDuration - SECTION_END_TOLERANCE_SEC;
    if (isPlaying) {
      onPause();
    } else if (isGenerating && totalDuration <= 0) {
      // Usually the next section that auto-continuation just began
      // synthesizing; letting it finish would start playing it.
      onStopGeneration();
    }
    setTimer({ choice: "off", endsAt: null, asleepIn: atEnd && hasNextSection ? sectionKey : null });
  });

  useEffect(() => {
    if (timer.endsAt === null) return;
    const timeout = window.setTimeout(() => expire(), Math.max(0, timer.endsAt - Date.now()));
    const tick = window.setInterval(() => setNow(Date.now()), LABEL_TICK_MS);
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(tick);
    };
  }, [timer.endsAt]);

  const notifyHold = useEffectEvent((held: boolean) => onHoldChange?.(held));
  useEffect(() => {
    if (!holdsContinuation) return;
    notifyHold(true);
    return () => notifyHold(false);
  }, [holdsContinuation]);

  const label = timer.choice === "off"
    ? null
    : timer.choice === "chapter"
      ? "End of chapter"
      : `${Math.max(1, Math.ceil(((timer.endsAt ?? now) - now) / 60_000))}m`;

  return { choice: timer.choice, label, holdsContinuation, start };
}
