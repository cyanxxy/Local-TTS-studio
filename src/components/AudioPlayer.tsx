import { useRef, useCallback, useEffect, useState, type ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Ellipsis,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Repeat1,
  RotateCcw,
  RotateCw,
  Sparkles,
  Square,
} from "lucide-react";
import type { GenerationStats } from "../types";
import { usePlaybackSelector, usePlaybackTime, type PlaybackClock } from "../lib/playbackClock";

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
  clock: PlaybackClock;
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

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

function formatPlaybackRate(rate: number): string {
  return `${rate.toFixed(2).replace(/\.?0+$/, "")}×`;
}

/** Listening time, not an editing timecode: m:ss, or h:mm:ss past an hour. */
function formatTime(secs: number): string {
  const total = Math.floor(Math.max(0, Number.isFinite(secs) ? secs : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/**
 * The playback position advances every animation frame. Only these two leaves
 * subscribe to it, so the rest of the player — transport buttons, status
 * labels — re-renders when its own props change rather than 60 times a second.
 */
function selectElapsedSeconds(timeSec: number): number {
  return Math.floor(Math.max(0, Number.isFinite(timeSec) ? timeSec : 0));
}

/** Whole-second readout, so it settles at 1 Hz instead of the frame rate. */
function ElapsedTime({ clock, className }: { clock: PlaybackClock; className: string }) {
  const seconds = usePlaybackSelector(clock, selectElapsedSeconds);
  return <span className={className}>{formatTime(seconds)}</span>;
}

/** Any listed rate is one pick away, instead of cycling through all of them. */
function PlaybackRateSelect({
  rate,
  onChange,
  className = "",
}: {
  rate: number;
  onChange: (rate: number) => void;
  className?: string;
}) {
  const known = PLAYBACK_RATES.some((value) => Math.abs(value - rate) < 0.001);
  return (
    <select
      aria-label="Playback speed"
      title="Playback speed"
      value={rate}
      onChange={(event) => onChange(Number(event.target.value))}
      className={`h-[44px] cursor-pointer appearance-none rounded-full bg-transparent px-2 text-center font-mono text-xs text-text-muted transition-colors hover:bg-text-primary/[0.07] hover:text-text-primary tabular-nums ${className}`}
    >
      {!known && <option value={rate}>{formatPlaybackRate(rate)}</option>}
      {PLAYBACK_RATES.map((value) => (
        <option key={value} value={value}>{formatPlaybackRate(value)}</option>
      ))}
    </select>
  );
}

interface SeekBarProps {
  clock: PlaybackClock;
  totalDuration: number;
  hasAudio: boolean;
  compact: boolean;
  onSeek: (percentage: number) => void;
}

function SeekBar({ clock, totalDuration, hasAudio, compact, onSeek }: SeekBarProps) {
  // The scrubber is the one element that genuinely wants frame-rate updates.
  const currentTime = usePlaybackTime(clock);
  const barRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const onSeekRef = useRef(onSeek);

  useEffect(() => {
    onSeekRef.current = onSeek;
  }, [onSeek]);

  const progress = totalDuration > 0 ? Math.min(100, (currentTime / totalDuration) * 100) : 0;

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
      const dur = totalDuration;
      if (!hasAudio || dur === 0) return;
      const cur = clock.getTime();
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
    [clock, hasAudio, totalDuration],
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

  return (
    <div
      ref={barRef}
      className={`h-8 group relative min-w-0 flex-1 select-none rounded-full ${
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
      ? `Passage ${activeSegmentNumber} of ${segmentCount}`
      : `${segmentCount} passage${segmentCount !== 1 ? "s" : ""}`;
  }

  if (sectionPreviewCount && sectionPreviewCount > 0) {
    return `${sectionPreviewCount} passage${sectionPreviewCount !== 1 ? "s" : ""}`;
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

interface OverflowAction {
  key: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  tone?: "danger";
}

/**
 * On phones the dock's secondary controls do not fit beside the transport, so
 * they collapse into one menu instead of sliding underneath it.
 */
function OverflowMenu({
  actions,
  rate,
  onRateChange,
}: {
  actions: OverflowAction[];
  rate: number;
  onRateChange?: (rate: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="More playback options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex h-[44px] w-[44px] items-center justify-center rounded-full text-text-muted transition-colors hover:bg-text-primary/[0.07] hover:text-text-primary"
      >
        <Ellipsis size={16} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Playback options"
          className="glass-pop absolute right-0 bottom-full z-10 mb-2 w-52 rounded-2xl p-1.5"
        >
          {onRateChange && (
            <label className="flex items-center justify-between gap-2 rounded-[10px] px-3 py-1 text-sm text-text-secondary">
              Speed
              <PlaybackRateSelect rate={rate} onChange={onRateChange} className="h-9" />
            </label>
          )}
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              role="menuitem"
              disabled={action.disabled}
              onClick={() => {
                setOpen(false);
                action.onSelect();
              }}
              className={`flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                action.tone === "danger"
                  ? "text-danger hover:bg-danger-light"
                  : "text-text-secondary hover:bg-text-primary/[0.07] hover:text-text-primary"
              }`}
            >
              {action.icon}
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function AudioPlayer({
  compact = false,
  embedded = false,
  variant = "panel",
  isPlaying,
  clock,
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
  const isDock = variant === "dock";
  const hasAudio = totalDuration > 0;
  const canTogglePlayback = hasAudio && (!isGenerating || allowPlaybackDuringGeneration);
  // Pause already holds the position, so Stop only exists to cancel a
  // generation that is still running.
  const canStop = Boolean(onStop) && isGenerating;
  // Benchmark numbers belong to Studio; listeners in the Reader never see them.
  const statsVisible = hasGenerationStats(stats) && !isDock;
  const sectionText = sectionLabel(segmentCount, activeSegmentNumber, sectionPreviewCount);
  const effectivePrimaryAction = hasAudio ? undefined : primaryAction;

  // The player is itself glass (or sits on a surface), so its buttons are
  // fills — never a second material — and they give on press, not lift.
  const transportButton = (enabled: boolean) =>
    `flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full ${
      enabled
        ? "glass-fill text-text-secondary hover:text-text-primary"
        : "cursor-not-allowed text-text-muted/50"
    }`;

  const utilityButton = (enabled: boolean) =>
    `flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full transition-all duration-200 ${
      enabled
        ? "text-text-muted hover:bg-text-primary/[0.07] hover:text-text-primary"
        : "cursor-not-allowed text-text-muted/50"
    }`;

  const centerButtonSize = isDock ? "h-13 w-13" : "h-12 w-12";
  const centerLabel = effectivePrimaryAction?.label ?? (isPlaying ? "Pause" : "Play");
  const centerDisabled = effectivePrimaryAction
    ? Boolean(effectivePrimaryAction.disabled)
    : !canTogglePlayback;
  const centerTone = effectivePrimaryAction?.tone ?? "accent";
  // Play is the action a paused player is waiting for, so it carries the
  // accent; while playing, Pause steps back to an outlined control.
  const centerClass = effectivePrimaryAction
    ? centerTone === "danger"
      ? "border border-danger/30 bg-danger-light text-danger shadow-glass-sm hover:bg-danger hover:text-white"
      : centerTone === "neutral" || effectivePrimaryAction.disabled
        ? "border border-border/70 bg-text-primary/[0.03] text-text-muted/70"
        : "glass-accent text-white"
    : centerDisabled
      ? "border border-border text-text-muted cursor-not-allowed"
      : isPlaying
        ? "glass-fill text-accent"
        : "glass-accent text-white";

  const handleCenterClick = () => {
    if (effectivePrimaryAction) {
      if (!effectivePrimaryAction.disabled) effectivePrimaryAction.onClick();
      return;
    }
    if (canTogglePlayback) onTogglePlay();
  };

  const seekControl = (
    <SeekBar
      clock={clock}
      totalDuration={totalDuration}
      hasAudio={hasAudio}
      compact={compact}
      onSeek={onSeek}
    />
  );

  const statsPanel = statsVisible && (
    <div className={`${compact ? "px-4 py-2 gap-4" : embedded ? "px-6 py-3 gap-6" : "px-5 py-3 gap-6"} flex flex-wrap items-center border-b border-black/5`}>
      {stats.firstLatency !== null && (
        <div className="flex flex-col">
          <span className="font-mono text-base font-semibold leading-none text-accent tabular-nums">
            {stats.firstLatency.toFixed(2)}s
          </span>
          <span className="mt-1 text-xs font-semibold text-text-secondary">
            First audio
          </span>
        </div>
      )}
      {stats.processingTime > 0 && (
        <div className="flex flex-col">
          <span className="font-mono text-base font-semibold leading-none text-accent tabular-nums">
            {stats.processingTime.toFixed(2)}s
          </span>
          <span className="mt-1 text-xs font-semibold text-text-secondary">
            Total time
          </span>
        </div>
      )}
      {stats.charsPerSec > 0 && (
        <div className="flex flex-col">
          <span className="font-mono text-base font-semibold leading-none text-accent tabular-nums">
            {stats.charsPerSec.toFixed(0)}
          </span>
          <span className="mt-1 text-xs font-semibold text-text-secondary">
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
            className="mt-1 text-xs font-semibold text-text-secondary"
            title="Real-time factor — generation time ÷ audio duration (lower is faster)"
          >
            RTF
          </span>
        </div>
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
          ? <Pause size={isDock ? 19 : 17} fill="currentColor" />
          : <Play size={isDock ? 19 : 17} fill="currentColor" className="translate-x-px" />}
    </button>
  );

  const stopButton = canStop && onStop && (
    <button
      type="button"
      onClick={onStop}
      aria-label="Stop generation"
      title="Stop generation"
      className="flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full text-danger transition-all duration-200 hover:bg-danger hover:text-white"
    >
      <Square size={12} />
    </button>
  );

  const overflowActions: OverflowAction[] = [
    ...(onRegenerate && hasAudio
      ? [{
          key: "regenerate",
          label: "Regenerate speech",
          icon: <Sparkles size={14} />,
          onSelect: onRegenerate,
          disabled: !canRegenerate,
        }]
      : []),
    ...(onRetakeSegment && segmentCount > 0
      ? [{
          key: "retake",
          label: isRetaking ? "Retaking passage" : "Retake passage",
          icon: <Repeat1 size={14} />,
          onSelect: onRetakeSegment,
          disabled: !canRetakeSegment || isRetaking,
        }]
      : []),
    {
      key: "download",
      label: "Download audio",
      icon: <Download size={14} />,
      onSelect: onDownload,
      disabled: !hasAudio,
    },
    ...(canStop && onStop
      ? [{
          key: "stop",
          label: "Stop generation",
          icon: <Square size={12} />,
          onSelect: onStop,
          tone: "danger" as const,
        }]
      : []),
  ];

  const dockBody = (
    <div className="glass rounded-[28px] px-3 pt-3 pb-2.5 sm:px-5">
      <div className="flex items-center gap-3">
        <ElapsedTime
          clock={clock}
          className="w-12 shrink-0 text-right font-mono text-xs text-text-muted tabular-nums"
        />
        {seekControl}
        <span className="w-12 shrink-0 font-mono text-xs text-text-muted tabular-nums">
          {formatTime(totalDuration)}
        </span>
      </div>

      {/* Three columns: the outer two share the leftover width equally, so the
          transport stays centred; everything secondary must fit its column. */}
      <div className="mt-2 flex items-center justify-between gap-1 sm:gap-2">
        <div className="flex min-w-0 flex-1 basis-0 items-center gap-0.5">
          {segmentCount > 0 ? (
            <>
              <button
                type="button"
                aria-label="Previous passage"
                onClick={onPreviousSegment}
                disabled={!canPreviousSegment}
                className={`max-sm:hidden ${utilityButton(canPreviousSegment)}`}
              >
                <ChevronLeft size={14} />
              </button>
              <span className="min-w-9 text-center font-mono text-xs text-text-muted tabular-nums whitespace-nowrap">
                {activeSegmentNumber ?? "–"}/{segmentCount}
              </span>
              <button
                type="button"
                aria-label="Next passage"
                onClick={onNextSegment}
                disabled={!canNextSegment}
                className={`max-sm:hidden ${utilityButton(canNextSegment)}`}
              >
                <ChevronRight size={14} />
              </button>
            </>
          ) : (
            <span className="truncate font-mono text-2xs text-text-muted/70">
              {sectionText}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 sm:gap-3">
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
          <div className="flex items-center gap-0.5 max-sm:hidden">
            {hasAudio && onPlaybackRateChange && (
              <PlaybackRateSelect rate={playbackRate} onChange={onPlaybackRateChange} />
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
                aria-label={isRetaking ? "Retaking passage" : "Retake passage"}
                title="Retake current passage"
                className={utilityButton(canRetakeSegment && !isRetaking)}
              >
                {isRetaking
                  ? <RefreshCw size={14} className="animate-spin" />
                  : <Repeat1 size={14} />}
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
            {stopButton}
          </div>
          <div className="sm:hidden">
            <OverflowMenu
              actions={overflowActions}
              rate={playbackRate}
              onRateChange={hasAudio ? onPlaybackRateChange : undefined}
            />
          </div>
        </div>
      </div>
      {statusLabel && (
        <div className="mt-2 text-center font-mono text-2xs text-text-muted/70">
          {statusLabel}
        </div>
      )}
    </div>
  );

  const panelBody = (
    <>
      {statsPanel}
      <div className={`${compact ? "px-4 py-3 gap-3" : embedded ? "px-6 py-4 gap-4" : "px-5 py-4 gap-4"} flex flex-col`}>
        <div className="flex items-center gap-3">
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
          {stopButton}
          <span className={`ml-auto truncate ${compact ? "text-xs" : "text-sm"} text-text-muted`}>
            {sectionText}
          </span>
          {hasAudio && onPlaybackRateChange && (
            <PlaybackRateSelect rate={playbackRate} onChange={onPlaybackRateChange} />
          )}
          <button
            type="button"
            onClick={onDownload}
            disabled={!hasAudio}
            aria-label="Download audio"
            title="Download audio"
            className={`flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-xl transition-all ${
              hasAudio
                ? "text-text-muted hover:bg-accent-light hover:text-accent"
                : "cursor-not-allowed text-text-muted"
            }`}
          >
            <Download size={16} />
          </button>
        </div>

        <div className="flex items-center gap-3 sm:gap-4">
          <ElapsedTime
            clock={clock}
            className={`font-mono text-xs text-text-muted ${compact ? "w-11" : "w-12"} shrink-0 text-right tabular-nums`}
          />
          {seekControl}
          <span className={`font-mono text-xs text-text-muted ${compact ? "w-11" : "w-12"} shrink-0 tabular-nums`}>
            {formatTime(totalDuration)}
          </span>
        </div>
      </div>
    </>
  );

  return (
    <div
      className={embedded || isDock
        ? ""
        : `surface ${compact ? "rounded-2xl" : "rounded-[22px]"} overflow-hidden`
      }
    >
      {isDock ? dockBody : panelBody}
    </div>
  );
}
