import { useRef, useCallback, useEffect } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Sparkles,
  Square,
} from "lucide-react";
import type { GenerationStats } from "../types";

type AudioPlayerVariant = "panel" | "dock";
type PrimaryActionIcon = "generate" | "retry" | "loading";
type PrimaryActionTone = "accent" | "danger" | "neutral";

export interface AudioPlayerPrimaryAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  progress?: number;
  icon?: PrimaryActionIcon;
  tone?: PrimaryActionTone;
}

interface AudioPlayerProps {
  compact?: boolean;
  embedded?: boolean;
  variant?: AudioPlayerVariant;
  isPlaying: boolean;
  currentTime: number;
  totalDuration: number;
  segmentCount: number;
  activeSegmentNumber: number | null;
  sectionPreviewCount?: number;
  statusLabel?: string | null;
  stats: GenerationStats;
  isGenerating: boolean;
  allowPlaybackDuringGeneration?: boolean;
  playbackRate?: number;
  onPlaybackRateChange?: (rate: number) => void;
  canPreviousSegment?: boolean;
  canNextSegment?: boolean;
  onPreviousSegment?: () => void;
  onNextSegment?: () => void;
  canRegenerate?: boolean;
  onRegenerate?: () => void;
  canRetakeSegment?: boolean;
  onRetakeSegment?: () => void;
  isRetaking?: boolean;
  primaryAction?: AudioPlayerPrimaryAction;
  onTogglePlay: () => void;
  onSeek: (percentage: number) => void;
  onSkipBackward: () => void;
  onSkipForward: () => void;
  onDownload: () => void;
  onStop?: () => void;
}

const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

function nextPlaybackRate(current: number): number {
  const index = PLAYBACK_RATES.findIndex((rate) => Math.abs(rate - current) < 0.001);
  return PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length] ?? 1;
}

function formatPlaybackRate(rate: number): string {
  return `${rate.toFixed(2).replace(/\.?0+$/, "")}×`;
}

function formatTime(secs: number): string {
  const totalTenths = Math.round(Math.max(0, Number.isFinite(secs) ? secs : 0) * 10);
  const m = Math.floor(totalTenths / 600);
  const s = ((totalTenths % 600) / 10).toFixed(1);
  return `${m}:${s.padStart(4, "0")}`;
}

function hasGenerationStats(stats: GenerationStats): boolean {
  return stats.firstLatency !== null ||
    stats.processingTime > 0 ||
    stats.charsPerSec > 0 ||
    stats.rtf > 0;
}

function sectionLabel(
  segmentCount: number,
  activeSegmentNumber: number | null,
  sectionPreviewCount: number | undefined,
): string {
  if (segmentCount > 0) {
    return activeSegmentNumber
      ? `Section ${activeSegmentNumber} of ${segmentCount}`
      : `${segmentCount} sections`;
  }

  if (sectionPreviewCount && sectionPreviewCount > 0) {
    return `${sectionPreviewCount} section${sectionPreviewCount !== 1 ? "s" : ""}`;
  }

  return "No audio loaded";
}

function renderPrimaryActionIcon(action: AudioPlayerPrimaryAction) {
  if (action.busy) {
    return (
      <span className="flex flex-col items-center justify-center gap-0.5">
        <Loader2 size={18} className="animate-spin" />
        {typeof action.progress === "number" && action.progress > 0 && (
          <span className="font-mono text-2xs tabular-nums leading-none">
            {Math.round(action.progress)}%
          </span>
        )}
      </span>
    );
  }

  if (action.icon === "retry") return <RefreshCw size={18} />;
  if (action.icon === "loading") return <Loader2 size={18} className="animate-spin" />;
  return <Sparkles size={19} />;
}

export function AudioPlayer({
  compact = false,
  embedded = false,
  variant = "panel",
  isPlaying,
  currentTime,
  totalDuration,
  segmentCount,
  activeSegmentNumber,
  sectionPreviewCount,
  statusLabel,
  stats,
  isGenerating,
  allowPlaybackDuringGeneration = false,
  playbackRate = 1,
  onPlaybackRateChange,
  canPreviousSegment = false,
  canNextSegment = false,
  onPreviousSegment,
  onNextSegment,
  canRegenerate = false,
  onRegenerate,
  canRetakeSegment = false,
  onRetakeSegment,
  isRetaking = false,
  primaryAction,
  onTogglePlay,
  onSeek,
  onSkipBackward,
  onSkipForward,
  onDownload,
  onStop,
}: AudioPlayerProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const onSeekRef = useRef(onSeek);
  const currentTimeRef = useRef(currentTime);
  const totalDurationRef = useRef(totalDuration);

  useEffect(() => {
    onSeekRef.current = onSeek;
  }, [onSeek]);
  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);
  useEffect(() => {
    totalDurationRef.current = totalDuration;
  }, [totalDuration]);

  const isDock = variant === "dock";
  const progress = totalDuration > 0 ? Math.min(100, (currentTime / totalDuration) * 100) : 0;
  const hasAudio = totalDuration > 0;
  const canTogglePlayback = hasAudio && (!isGenerating || allowPlaybackDuringGeneration);
  const canStop = Boolean(onStop) && (isGenerating || hasAudio || isPlaying || currentTime > 0);
  const statsVisible = hasGenerationStats(stats);
  const sectionText = sectionLabel(segmentCount, activeSegmentNumber, sectionPreviewCount);
  const effectivePrimaryAction = hasAudio ? undefined : primaryAction;

  const getSeekPct = useCallback((clientX: number): number => {
    if (!barRef.current) return 0;
    const rect = barRef.current.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!hasAudio) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      isDragging.current = true;
      onSeekRef.current(getSeekPct(e.clientX));
    },
    [getSeekPct, hasAudio],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const dur = totalDurationRef.current;
      if (!hasAudio || dur === 0) return;
      const cur = currentTimeRef.current;
      const step = 5 / dur;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        e.preventDefault();
        onSeekRef.current(Math.min(1, cur / dur + step));
      } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        e.preventDefault();
        onSeekRef.current(Math.max(0, cur / dur - step));
      } else if (e.key === "Home") {
        e.preventDefault();
        onSeekRef.current(0);
      } else if (e.key === "End") {
        e.preventDefault();
        onSeekRef.current(1);
      }
    },
    [hasAudio],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isDragging.current) return;
      onSeekRef.current(getSeekPct(e.clientX));
    },
    [getSeekPct],
  );

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    isDragging.current = false;
  }, []);

  const handlePointerCancel = useCallback(() => {
    isDragging.current = false;
  }, []);

  const transportButton = (enabled: boolean) =>
    `flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full border transition-all duration-200 ${
      enabled
        ? "border-white/55 bg-white/40 text-text-secondary shadow-glass-sm backdrop-blur-md hover:-translate-y-0.5 hover:bg-white/60 hover:text-accent"
        : "cursor-not-allowed border-border/70 text-text-muted/60"
    }`;

  const utilityButton = (enabled: boolean) =>
    `flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full transition-all duration-200 ${
      enabled
        ? "text-text-muted hover:bg-white/55 hover:text-accent"
        : "cursor-not-allowed text-text-muted/50"
    }`;

  const centerButtonSize = isDock ? "h-13 w-13" : "h-[44px] w-[44px]";
  const centerLabel = effectivePrimaryAction?.label ?? (isPlaying ? "Pause" : "Play");
  const centerDisabled = effectivePrimaryAction
    ? Boolean(effectivePrimaryAction.disabled)
    : !canTogglePlayback;
  const centerTone = effectivePrimaryAction?.tone ?? "accent";
  const centerClass = effectivePrimaryAction
    ? centerTone === "danger"
      ? "border border-danger/30 bg-danger-light text-danger shadow-glass-sm backdrop-blur-md hover:bg-danger hover:text-white"
      : centerTone === "neutral" || effectivePrimaryAction.disabled
        ? "border border-border/70 bg-white/35 text-text-muted/70 backdrop-blur-md"
        : "glass-accent text-white"
    : centerDisabled
      ? "border border-border text-text-muted cursor-not-allowed"
      : isPlaying
        ? "border border-accent bg-accent/10 text-accent shadow-accent-sm hover:bg-accent hover:text-white"
        : "border border-white/55 bg-white/45 text-text-secondary shadow-glass-sm backdrop-blur-md hover:-translate-y-0.5 hover:bg-white/65 hover:text-accent";

  const handleCenterClick = () => {
    if (effectivePrimaryAction) {
      if (!effectivePrimaryAction.disabled) effectivePrimaryAction.onClick();
      return;
    }
    if (canTogglePlayback) onTogglePlay();
  };

  const seekControl = (
    <div
      ref={barRef}
      className={`${isDock ? "h-8" : "order-last h-8 basis-full sm:order-none sm:basis-auto"} group relative min-w-0 flex-1 select-none rounded-full ${
        hasAudio ? "cursor-pointer" : ""
      }`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handlePointerCancel}
      onKeyDown={handleKeyDown}
      role="slider"
      tabIndex={hasAudio ? 0 : -1}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress)}
      aria-valuetext={`${formatTime(currentTime)} of ${formatTime(totalDuration)}`}
    >
      <div className={`absolute left-0 right-0 top-1/2 -translate-y-1/2 ${compact ? "h-1" : "h-1.5"} rounded-full ${hasAudio ? "bg-border-strong" : "bg-border"}`} />
      <div
        className={`absolute left-0 top-1/2 ${compact ? "h-1" : "h-1.5"} -translate-y-1/2 rounded-full bg-accent`}
        style={{ width: `${progress}%` }}
      />
      <div
        className="absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-accent opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        style={{
          left: `calc(${progress}% - 6px)`,
          boxShadow: "var(--shadow-accent-lg)",
        }}
      />
    </div>
  );

  const statsPanel = statsVisible && !isDock && (
    <div className={`${compact ? "px-4 py-2 gap-4" : embedded ? "px-6 py-3 gap-6" : "px-5 py-3 gap-6"} flex flex-wrap items-center border-b border-black/5`}>
      {stats.firstLatency !== null && (
        <div className="flex flex-col">
          <span className="font-mono text-base font-semibold leading-none text-accent tabular-nums">
            {stats.firstLatency.toFixed(2)}s
          </span>
          <span className="mt-1 text-2xs font-semibold uppercase tracking-widest text-text-muted">
            First audio
          </span>
        </div>
      )}
      {stats.processingTime > 0 && (
        <div className="flex flex-col">
          <span className="font-mono text-base font-semibold leading-none text-accent tabular-nums">
            {stats.processingTime.toFixed(2)}s
          </span>
          <span className="mt-1 text-2xs font-semibold uppercase tracking-widest text-text-muted">
            Total time
          </span>
        </div>
      )}
      {stats.charsPerSec > 0 && (
        <div className="flex flex-col">
          <span className="font-mono text-base font-semibold leading-none text-accent tabular-nums">
            {stats.charsPerSec.toFixed(0)}
          </span>
          <span className="mt-1 text-2xs font-semibold uppercase tracking-widest text-text-muted">
            Chars/sec
          </span>
        </div>
      )}
      {stats.rtf > 0 && (
        <div className="flex flex-col">
          <span className="font-mono text-base font-semibold leading-none text-accent tabular-nums">
            {stats.rtf.toFixed(3)}×
          </span>
          <span
            className="mt-1 text-2xs font-semibold uppercase tracking-widest text-text-muted"
            title="Real-time factor — generation time ÷ audio duration (lower is faster)"
          >
            RTF
          </span>
        </div>
      )}
    </div>
  );

  const statsChips = statsVisible && isDock && (
    <div className="mb-2 flex flex-wrap items-center justify-center gap-1.5">
      {stats.firstLatency !== null && (
        <span className="rounded-full border border-white/50 bg-white/45 px-2.5 py-1 font-mono text-2xs text-text-muted shadow-glass-sm backdrop-blur-md tabular-nums">
          first audio {stats.firstLatency.toFixed(2)}s
        </span>
      )}
      {stats.processingTime > 0 && (
        <span className="rounded-full border border-white/50 bg-white/45 px-2.5 py-1 font-mono text-2xs text-text-muted shadow-glass-sm backdrop-blur-md tabular-nums">
          total {stats.processingTime.toFixed(2)}s
        </span>
      )}
      {stats.charsPerSec > 0 && (
        <span className="rounded-full border border-white/50 bg-white/45 px-2.5 py-1 font-mono text-2xs text-text-muted shadow-glass-sm backdrop-blur-md tabular-nums">
          {stats.charsPerSec.toFixed(0)} chars/s
        </span>
      )}
      {stats.rtf > 0 && (
        <span
          title="Real-time factor — generation time ÷ audio duration (lower is faster)"
          className="rounded-full border border-white/50 bg-white/45 px-2.5 py-1 font-mono text-2xs text-text-muted shadow-glass-sm backdrop-blur-md tabular-nums"
        >
          RTF {stats.rtf.toFixed(3)}×
        </span>
      )}
    </div>
  );

  const centerActionButton = (
    <button
      type="button"
      onClick={handleCenterClick}
      disabled={centerDisabled}
      aria-label={centerLabel}
      title={centerLabel}
      className={`flex ${centerButtonSize} shrink-0 items-center justify-center rounded-full transition-all duration-300 ${centerClass}`}
    >
      {effectivePrimaryAction
        ? renderPrimaryActionIcon(effectivePrimaryAction)
        : isPlaying
          ? <Pause size={isDock ? 19 : 14} fill="currentColor" />
          : <Play size={isDock ? 19 : 14} fill="currentColor" className="translate-x-px" />}
    </button>
  );

  const dockBody = (
    <>
      {statsChips}
      <div className="glass-pop rounded-[26px] px-4 pt-3 pb-2.5 sm:px-5">
        <div className="flex items-center gap-3">
          <span className="w-11 shrink-0 text-right font-mono text-xs text-text-muted tabular-nums">
            {formatTime(currentTime)}
          </span>
          {seekControl}
          <span className="w-11 shrink-0 font-mono text-xs text-text-muted tabular-nums">
            {formatTime(totalDuration)}
          </span>
        </div>

        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex min-w-0 flex-1 basis-0 items-center gap-0.5">
            {segmentCount > 0 ? (
              <>
                <button
                  type="button"
                  aria-label="Previous section"
                  onClick={onPreviousSegment}
                  disabled={!canPreviousSegment}
                  className={utilityButton(canPreviousSegment)}
                >
                  <ChevronLeft size={14} />
                </button>
                <span className="min-w-9 text-center font-mono text-xs text-text-muted tabular-nums whitespace-nowrap">
                  {activeSegmentNumber ?? "–"}/{segmentCount}
                </span>
                <button
                  type="button"
                  aria-label="Next section"
                  onClick={onNextSegment}
                  disabled={!canNextSegment}
                  className={utilityButton(canNextSegment)}
                >
                  <ChevronRight size={14} />
                </button>
              </>
            ) : (
              <span className="font-mono text-2xs text-text-muted/70">
                {sectionText}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2.5 sm:gap-3">
            <button
              type="button"
              onClick={onSkipBackward}
              disabled={!hasAudio}
              aria-label="Back 10 seconds"
              className={transportButton(hasAudio)}
            >
              <RotateCcw size={14} />
            </button>
            {centerActionButton}
            <button
              type="button"
              onClick={onSkipForward}
              disabled={!hasAudio}
              aria-label="Forward 10 seconds"
              className={transportButton(hasAudio)}
            >
              <RotateCw size={14} />
            </button>
          </div>

          <div className="flex min-w-0 flex-1 basis-0 items-center justify-end gap-0.5">
            {hasAudio && onPlaybackRateChange && (
              <button
                type="button"
                onClick={() => onPlaybackRateChange(nextPlaybackRate(playbackRate))}
                aria-label={`Playback speed ${formatPlaybackRate(playbackRate)}`}
                title="Playback speed"
                className="flex h-[44px] min-w-[44px] items-center justify-center rounded-full px-1 font-mono text-xs text-text-muted transition-all duration-200 hover:bg-white/55 hover:text-accent tabular-nums"
              >
                {formatPlaybackRate(playbackRate)}
              </button>
            )}
            {onRegenerate && hasAudio && (
              <button
                type="button"
                onClick={onRegenerate}
                disabled={!canRegenerate}
                aria-label="Regenerate speech"
                title="Regenerate speech"
                className={utilityButton(canRegenerate)}
              >
                <Sparkles size={14} />
              </button>
            )}
            {onRetakeSegment && segmentCount > 0 && (
              <button
                type="button"
                onClick={onRetakeSegment}
                disabled={!canRetakeSegment || isRetaking}
                aria-label={isRetaking ? "Retaking section" : "Retake section"}
                title="Retake current section"
                className={utilityButton(canRetakeSegment && !isRetaking)}
              >
                <RefreshCw size={14} className={isRetaking ? "animate-spin" : undefined} />
              </button>
            )}
            <button
              type="button"
              onClick={onDownload}
              disabled={!hasAudio}
              aria-label="Download audio"
              title="Download audio"
              className={utilityButton(hasAudio)}
            >
              <Download size={14} />
            </button>
            {canStop && onStop && (
              <button
                type="button"
                onClick={onStop}
                aria-label={isGenerating ? "Stop generation" : "Stop playback"}
                title={isGenerating ? "Stop generation" : "Stop playback"}
                className="flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full text-danger transition-all duration-200 hover:bg-danger hover:text-white"
              >
                <Square size={12} />
              </button>
            )}
          </div>
        </div>
        {statusLabel && (
          <div className="mt-2 text-center font-mono text-2xs text-text-muted/70">
            {statusLabel}
          </div>
        )}
      </div>
    </>
  );

  const panelBody = (
    <>
      {statsPanel}
      <div className={`${compact ? "px-4 py-3 gap-3" : embedded ? "px-6 py-4 gap-4" : "px-5 py-4 gap-4"} flex flex-col`}>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onSkipBackward}
            disabled={!hasAudio}
            aria-label="Back 10 seconds"
            className={transportButton(hasAudio)}
          >
            <RotateCcw size={14} />
          </button>
          {centerActionButton}
          <button
            type="button"
            onClick={onSkipForward}
            disabled={!hasAudio}
            aria-label="Forward 10 seconds"
            className={transportButton(hasAudio)}
          >
            <RotateCw size={14} />
          </button>
          {canStop && onStop && (
            <button
              type="button"
              onClick={onStop}
              aria-label={isGenerating ? "Stop generation" : "Stop playback"}
              title={isGenerating ? "Stop generation" : "Stop playback"}
              className="h-[44px] w-[44px] shrink-0 rounded-full border border-danger/30 bg-danger-light text-danger shadow-glass-sm backdrop-blur-md transition-all duration-200 hover:-translate-y-0.5 hover:bg-danger hover:text-white"
            >
              <Square size={12} className="mx-auto" />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 sm:flex-nowrap sm:gap-4">
          <span className={`font-mono text-xs text-text-muted ${compact ? "w-11" : "w-12"} shrink-0 text-right tabular-nums`}>
            {formatTime(currentTime)}
          </span>
          {seekControl}
          <span className={`font-mono text-xs text-text-muted ${compact ? "w-11" : "w-12"} shrink-0 tabular-nums`}>
            {formatTime(totalDuration)}
          </span>
          <button
            type="button"
            onClick={onDownload}
            disabled={!hasAudio}
            aria-label="Download audio"
            title="Download audio"
            className={`ml-auto flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-xl transition-all sm:ml-0 ${
              hasAudio
                ? "text-text-muted hover:bg-accent-light hover:text-accent"
                : "cursor-not-allowed text-text-muted"
            }`}
          >
            <Download size={16} />
          </button>
        </div>

        <div className={`flex items-center justify-start ${compact ? "text-xs" : "text-sm"} text-text-muted sm:justify-end`}>
          <span>{sectionText}</span>
        </div>
      </div>
    </>
  );

  return (
    <div
      className={embedded || isDock
        ? ""
        : `glass-panel ${compact ? "rounded-2xl" : "rounded-[22px]"} overflow-hidden`
      }
    >
      {isDock ? dockBody : panelBody}
    </div>
  );
}
