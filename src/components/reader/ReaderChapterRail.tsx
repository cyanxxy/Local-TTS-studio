import { ChevronDown, ChevronLeft, ChevronRight, Moon } from "lucide-react";
import type { PlaybackClock } from "../../lib/playbackClock";
import { RemainingTime } from "./RemainingTime";
import { clamp } from "./readerTextLayout";

const PAGE_TURN_BUTTON =
  "flex h-7 w-7 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-text-primary/[0.08] hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent";

interface ReaderChapterRailProps {
  previousLabel: string;
  nextLabel: string;
  onPrevious?: () => void;
  onNext?: () => void;
  /** Visible text of the contents button. */
  title: string;
  contentsLabel: string;
  onOpenContents: () => void;
  partIndex: number;
  partCount: number;
  /** Whole-book progress, 0–100. */
  readingProgress: number;
  clock: PlaybackClock;
  totalDuration: number;
  sleepTimerLabel: string | null;
  onCancelSleepTimer: () => void;
}

/**
 * Running head: where you are, one tap to the contents, and the two page turns
 * — the only chapter chrome the reader needs.
 */
export function ReaderChapterRail({
  previousLabel,
  nextLabel,
  onPrevious,
  onNext,
  title,
  contentsLabel,
  onOpenContents,
  partIndex,
  partCount,
  readingProgress,
  clock,
  totalDuration,
  sleepTimerLabel,
  onCancelSleepTimer,
}: ReaderChapterRailProps) {
  return (
    <nav
      aria-label="Chapter navigation"
      className="flex shrink-0 items-center gap-2 border-b border-border/40 px-2.5 py-2 sm:gap-3 sm:px-3"
    >
      {/* Both page turns sit together on the left, the way a reader's
          thumb expects them, instead of straddling the title. */}
      <div className="flex shrink-0 items-center rounded-full bg-text-primary/[0.05] p-0.5">
        <button
          type="button"
          disabled={!onPrevious}
          onClick={onPrevious}
          aria-label={previousLabel}
          title={`${previousLabel} (←)`}
          className={PAGE_TURN_BUTTON}
        >
          <ChevronLeft size={15} />
        </button>
        <span className="h-4 w-px bg-border/70" aria-hidden />
        <button
          type="button"
          disabled={!onNext}
          onClick={onNext}
          aria-label={nextLabel}
          title={`${nextLabel} (→)`}
          className={PAGE_TURN_BUTTON}
        >
          <ChevronRight size={15} />
        </button>
      </div>

      {/* Hugging its own text keeps the hover and focus ring on the
          title instead of stretching a highlight across the whole rail. */}
      <button
        type="button"
        onClick={onOpenContents}
        aria-label={contentsLabel}
        aria-haspopup="dialog"
        title="Open contents"
        className="group -ml-1 mr-auto flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left transition-colors hover:bg-text-primary/[0.07]"
      >
        <span className="truncate text-sm font-medium text-text-secondary transition-colors group-hover:text-accent">
          {title}
        </span>
        {partCount > 1 && (
          <span className="flex shrink-0 items-center gap-1" aria-hidden>
            {partCount <= 6 ? (
              Array.from({ length: partCount }, (_, index) => (
                <span
                  key={index}
                  className={`h-1.5 w-1.5 rounded-full transition-colors ${
                    index === partIndex ? "bg-accent" : "bg-border"
                  }`}
                />
              ))
            ) : (
              <span className="font-mono text-2xs text-text-muted tabular-nums">
                {partIndex + 1}/{partCount}
              </span>
            )}
          </span>
        )}
        <ChevronDown
          size={13}
          className="shrink-0 text-text-muted transition-colors group-hover:text-accent"
        />
      </button>

      <div className="flex shrink-0 items-center gap-2">
        <div className="hidden h-1 w-20 overflow-hidden rounded-full bg-border/80 sm:block md:w-28">
          <div
            className="h-full rounded-full bg-accent transition-[transform] duration-300 origin-left"
            style={{ transform: `scaleX(${clamp(readingProgress / 100, 0, 1)})` }}
          />
        </div>
        {/* Fixed width so the rail does not twitch as the number grows. */}
        <span className="w-9 shrink-0 text-right font-mono text-2xs text-text-muted tabular-nums">
          {Math.round(readingProgress)}%
        </span>
        <RemainingTime
          clock={clock}
          totalDuration={totalDuration}
          className="hidden whitespace-nowrap font-mono text-2xs text-text-muted tabular-nums md:inline"
        />
        {sleepTimerLabel && (
          <button
            type="button"
            onClick={onCancelSleepTimer}
            aria-label={`Sleep timer: ${sleepTimerLabel}. Cancel`}
            title="Cancel sleep timer"
            className="flex items-center gap-1 rounded-full bg-accent-light px-2 py-0.5 font-mono text-2xs text-accent tabular-nums"
          >
            <Moon size={10} aria-hidden />
            {sleepTimerLabel}
          </button>
        )}
      </div>
    </nav>
  );
}
