import { useRef, useCallback, useEffect } from "react";
import { Play, Pause, Download, RotateCcw, RotateCw, Square } from "lucide-react";
import type { GenerationStats } from "../types";

interface AudioPlayerProps {
  compact?: boolean;
  embedded?: boolean;
  isPlaying: boolean;
  currentTime: number;
  totalDuration: number;
  segmentCount: number;
  activeSegmentNumber: number | null;
  stats: GenerationStats;
  isGenerating: boolean;
  onTogglePlay: () => void;
  onSeek: (percentage: number) => void;
  onSkipBackward: () => void;
  onSkipForward: () => void;
  onDownload: () => void;
  onStop?: () => void;
}

function formatTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = (secs % 60).toFixed(1);
  return `${m}:${s.padStart(4, "0")}`;
}

export function AudioPlayer({
  compact = false,
  embedded = false,
  isPlaying,
  currentTime,
  totalDuration,
  segmentCount,
  activeSegmentNumber,
  stats,
  isGenerating,
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

  const progress = totalDuration > 0 ? Math.min(100, (currentTime / totalDuration) * 100) : 0;
  const hasAudio = totalDuration > 0;
  const canStop = Boolean(onStop) && (isGenerating || hasAudio || isPlaying || currentTime > 0);

  const hasStats =
    stats.firstLatency !== null ||
    stats.processingTime > 0 ||
    stats.charsPerSec > 0 ||
    stats.rtf > 0;

  const getSeekPct = useCallback((clientX: number): number => {
    if (!barRef.current) return 0;
    const rect = barRef.current.getBoundingClientRect();
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

  return (
    <div
      className={embedded
        ? ""
        : `border border-border/60 ${compact ? "rounded-xl" : "rounded-2xl"} bg-panel overflow-hidden shadow-md ring-1 ring-black/5`
      }
    >

      {hasStats && (
        <div className={`${compact ? "px-4 py-2 gap-4" : embedded ? "px-6 py-3 gap-6" : "px-5 py-3 gap-6"} flex items-center border-b border-border flex-wrap`}>
          {stats.firstLatency !== null && (
            <div className="flex flex-col">
              <span className="font-mono text-[13px] font-semibold text-accent tabular-nums leading-none">
                {stats.firstLatency.toFixed(2)}s
              </span>
              <span className="text-[9px] font-semibold uppercase tracking-widest text-text-muted mt-1">
                First chunk
              </span>
            </div>
          )}
          {stats.processingTime > 0 && (
            <div className="flex flex-col">
              <span className="font-mono text-[13px] font-semibold text-accent tabular-nums leading-none">
                {stats.processingTime.toFixed(2)}s
              </span>
              <span className="text-[9px] font-semibold uppercase tracking-widest text-text-muted mt-1">
                Total time
              </span>
            </div>
          )}
          {stats.charsPerSec > 0 && (
            <div className="flex flex-col">
              <span className="font-mono text-[13px] font-semibold text-accent tabular-nums leading-none">
                {stats.charsPerSec.toFixed(0)}
              </span>
              <span className="text-[9px] font-semibold uppercase tracking-widest text-text-muted mt-1">
                Chars/sec
              </span>
            </div>
          )}
          {stats.rtf > 0 && (
            <div className="flex flex-col">
              <span className="font-mono text-[13px] font-semibold text-accent tabular-nums leading-none">
                {stats.rtf.toFixed(3)}×
              </span>
              <span className="text-[9px] font-semibold uppercase tracking-widest text-text-muted mt-1">
                RTF
              </span>
            </div>
          )}
        </div>
      )}

      <div className={`${compact ? "px-4 py-3 gap-3" : embedded ? "px-6 py-4 gap-4" : "px-5 py-4 gap-4"} flex flex-col`}>
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={onSkipBackward}
            disabled={!hasAudio}
            aria-label="Back 10 seconds"
            className={`${compact ? "w-8 h-8" : "w-9 h-9"} rounded-full border flex items-center justify-center transition-all duration-200 ${
              hasAudio
                ? "border-border-strong text-text-secondary hover:border-accent/60 hover:text-accent hover:bg-surface"
                : "border-border text-text-muted cursor-not-allowed"
            }`}
          >
            <RotateCcw size={14} />
          </button>

          <button
            onClick={onTogglePlay}
            disabled={isGenerating || !hasAudio}
            aria-label={isPlaying ? "Pause" : "Play"}
            className={`${compact ? "w-9 h-9" : "w-10 h-10"} rounded-full border flex items-center justify-center transition-all duration-300 ${
              isGenerating || !hasAudio
                ? "border-border text-text-muted cursor-not-allowed"
                : isPlaying
                  ? "border-accent bg-accent/10 text-accent hover:bg-accent hover:text-white shadow-accent-sm"
                  : "border-border-strong text-text-secondary hover:border-accent hover:text-accent hover:shadow-accent-sm hover:bg-surface"
            }`}
          >
            {isPlaying
              ? <Pause size={14} fill="currentColor" />
              : <Play size={14} fill="currentColor" className="translate-x-px" />}
          </button>

          <button
            onClick={onSkipForward}
            disabled={!hasAudio}
            aria-label="Forward 10 seconds"
            className={`${compact ? "w-8 h-8" : "w-9 h-9"} rounded-full border flex items-center justify-center transition-all duration-200 ${
              hasAudio
                ? "border-border-strong text-text-secondary hover:border-accent/60 hover:text-accent hover:bg-surface"
                : "border-border text-text-muted cursor-not-allowed"
            }`}
          >
            <RotateCw size={14} />
          </button>

          {canStop && onStop && (
            <button
              onClick={onStop}
              aria-label={isGenerating ? "Stop generation" : "Stop playback"}
              title={isGenerating ? "Stop generation" : "Stop playback"}
              className={`${compact ? "w-8 h-8" : "w-9 h-9"} rounded-full border border-danger/40 text-danger bg-danger-light hover:bg-danger hover:text-white transition-all duration-200`}
            >
              <Square size={12} className="mx-auto" />
            </button>
          )}

        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 sm:flex-nowrap sm:gap-4">
          <span className={`font-mono text-xs text-text-muted ${compact ? "w-11" : "w-12"} text-right tabular-nums flex-shrink-0`}>
            {formatTime(currentTime)}
          </span>

          <div
            ref={barRef}
            className={`order-last min-w-0 basis-full sm:order-none sm:basis-auto flex-1 ${compact ? "h-1" : "h-1.5"} rounded-full relative group select-none ${
              hasAudio ? "bg-border-strong cursor-pointer" : "bg-border"
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
            <div
              className="absolute top-0 left-0 h-full rounded-full bg-accent"
              style={{ width: `${progress}%` }}
            />
            <div
              className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-accent opacity-0 group-hover:opacity-100 transition-opacity"
              style={{
                left: `calc(${progress}% - 6px)`,
                boxShadow: "var(--shadow-accent-lg)",
              }}
            />
          </div>

          <span className={`font-mono text-xs text-text-muted ${compact ? "w-11" : "w-12"} tabular-nums flex-shrink-0`}>
            {formatTime(totalDuration)}
          </span>

          <button
            onClick={onDownload}
            disabled={!hasAudio}
            aria-label="Download audio"
            title="Download audio"
            className={`ml-auto rounded-lg p-2 transition-all flex-shrink-0 sm:ml-0 ${
              hasAudio
                ? "text-text-muted hover:text-accent hover:bg-accent-light"
                : "text-text-muted cursor-not-allowed"
            }`}
          >
            <Download size={16} />
          </button>
        </div>

        <div className={`flex items-center justify-start ${compact ? "text-[10px]" : "text-[11px]"} text-text-muted sm:justify-end`}>
          <span>
            {segmentCount > 0
              ? activeSegmentNumber
                ? `Section ${activeSegmentNumber} of ${segmentCount}`
                : `${segmentCount} sections`
              : "No audio loaded"}
          </span>
        </div>
      </div>
    </div>
  );
}
