import { memo, useCallback, useMemo } from "react";
import type { AudioSegment } from "../../hooks/useAudioPlayer";
import type { PlaybackClock } from "../../lib/playbackClock";
import type { ReaderTone } from "../../lib/readerPreferences";
import type { GenerationStats } from "../../types";
import { AudioPlayer } from "../AudioPlayer";
import { deriveReaderDockState } from "./readerDockState";

/** The shared player re-renders only when its own props change. */
const DockAudioPlayer = memo(AudioPlayer);

interface ReaderPlayerDockProps {
  fullScreen: boolean;
  tone: ReaderTone;
  isPlaying: boolean;
  clock: PlaybackClock;
  totalDuration: number;
  segments: AudioSegment[];
  activeSegmentId: string | null;
  /** How many passages the active section will be generated as. */
  sectionPreviewCount: number;
  stats: GenerationStats;
  isGenerating: boolean;
  generationProgress: number;
  generationError: string | null;
  modelReady: boolean;
  modelError: string | null;
  loadingProgress: number;
  canGenerate: boolean;
  charsRemaining: number;
  playbackRate: number;
  onPlaybackRateChange?: (rate: number) => void;
  isRetaking: boolean;
  canRetakeSegments: boolean;
  onRetakeSegment: (segmentId: string) => void;
  onJumpToSegment: (segmentId: string) => void;
  onGenerate: () => void;
  onRetryLoad: () => void;
  onTogglePlay: () => void;
  onSeek: (percentage: number) => void;
  onSkipBackward: () => void;
  onSkipForward: () => void;
  onDownload: () => void;
  onStop: () => void;
}

/** The Reader's floating transport: the shared audio player in its dock variant. */
export const ReaderPlayerDock = memo(function ReaderPlayerDock({
  fullScreen,
  tone,
  isPlaying,
  clock,
  totalDuration,
  segments,
  activeSegmentId,
  sectionPreviewCount,
  stats,
  isGenerating,
  generationProgress,
  generationError,
  modelReady,
  modelError,
  loadingProgress,
  canGenerate,
  charsRemaining,
  playbackRate,
  onPlaybackRateChange,
  isRetaking,
  canRetakeSegments,
  onRetakeSegment,
  onJumpToSegment,
  onGenerate,
  onRetryLoad,
  onTogglePlay,
  onSeek,
  onSkipBackward,
  onSkipForward,
  onDownload,
  onStop,
}: ReaderPlayerDockProps) {
  const hasAudio = totalDuration > 0;
  const dockState = useMemo(() => deriveReaderDockState({
    hasAudio,
    isGenerating,
    generationProgress,
    modelReady,
    modelError,
    generationError,
    canGenerate,
    charsRemaining,
    loadingProgress,
  }), [
    canGenerate,
    charsRemaining,
    generationError,
    generationProgress,
    hasAudio,
    isGenerating,
    loadingProgress,
    modelError,
    modelReady,
  ]);
  const { showRetry, isPreparing } = dockState;

  const handlePrimaryAction = useCallback(() => {
    if (showRetry) {
      onRetryLoad();
      return;
    }
    if (isGenerating || isPreparing) return;
    if (canGenerate) onGenerate();
  }, [canGenerate, isGenerating, isPreparing, onGenerate, onRetryLoad, showRetry]);

  const primaryAction = useMemo(
    () => (dockState.primaryAction ? { ...dockState.primaryAction, onClick: handlePrimaryAction } : undefined),
    [dockState.primaryAction, handlePrimaryAction],
  );

  const activeSegmentIndex = segments.findIndex((segment) => segment.id === activeSegmentId);
  const handlePreviousSegment = useCallback(() => {
    if (activeSegmentIndex > 0) onJumpToSegment(segments[activeSegmentIndex - 1].id);
  }, [activeSegmentIndex, onJumpToSegment, segments]);
  const handleNextSegment = useCallback(() => {
    if (activeSegmentIndex >= 0 && activeSegmentIndex < segments.length - 1) {
      onJumpToSegment(segments[activeSegmentIndex + 1].id);
    }
  }, [activeSegmentIndex, onJumpToSegment, segments]);
  const handleRetakeCurrentSegment = useCallback(() => {
    if (activeSegmentIndex >= 0) onRetakeSegment(segments[activeSegmentIndex].id);
  }, [activeSegmentIndex, onRetakeSegment, segments]);

  return (
    <div
      className={`reader-tone-${tone} ${
        fullScreen
          ? "fixed bottom-4 left-1/2 z-40 w-[min(44rem,calc(100vw-1.5rem))] -translate-x-1/2 sm:bottom-6"
          : "w-full"
      }`}
    >
      <DockAudioPlayer
        variant="dock"
        embedded
        isPlaying={isPlaying}
        clock={clock}
        totalDuration={totalDuration}
        segmentCount={segments.length}
        activeSegmentNumber={activeSegmentIndex >= 0 ? activeSegmentIndex + 1 : null}
        sectionPreviewCount={sectionPreviewCount}
        statusLabel={dockState.statusLabel}
        stats={stats}
        isGenerating={isGenerating}
        allowPlaybackDuringGeneration
        playbackRate={playbackRate}
        onPlaybackRateChange={onPlaybackRateChange}
        canPreviousSegment={activeSegmentIndex > 0}
        canNextSegment={activeSegmentIndex >= 0 && activeSegmentIndex < segments.length - 1}
        onPreviousSegment={handlePreviousSegment}
        onNextSegment={handleNextSegment}
        canRegenerate={hasAudio && !isGenerating && canGenerate}
        onRegenerate={onGenerate}
        canRetakeSegment={segments.length > 0 && canRetakeSegments && activeSegmentIndex >= 0 && !isRetaking}
        onRetakeSegment={canRetakeSegments ? handleRetakeCurrentSegment : undefined}
        isRetaking={isRetaking}
        primaryAction={primaryAction}
        onTogglePlay={onTogglePlay}
        onSeek={onSeek}
        onSkipBackward={onSkipBackward}
        onSkipForward={onSkipForward}
        onDownload={onDownload}
        onStop={onStop}
      />
    </div>
  );
});
