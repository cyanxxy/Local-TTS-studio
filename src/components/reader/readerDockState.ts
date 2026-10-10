import type { AudioPlayerPrimaryAction } from "../AudioPlayer";
import { clamp } from "./readerTextLayout";

export interface ReaderDockInput {
  hasAudio: boolean;
  isGenerating: boolean;
  generationProgress: number;
  modelReady: boolean;
  modelError: string | null;
  generationError: string | null;
  canGenerate: boolean;
  /** Meaningful characters still missing before generation is allowed. */
  charsRemaining: number;
  loadingProgress: number;
}

/** The primary action minus its handler, which the dock binds itself. */
export type ReaderDockPrimaryAction = Omit<AudioPlayerPrimaryAction, "onClick">;

export interface ReaderDockState {
  statusLabel: string | null;
  /** The model failed to load, so the primary action retries the load. */
  showRetry: boolean;
  /** The model is still loading, so nothing can be generated yet. */
  isPreparing: boolean;
  /** Present only while there is no audio to play. */
  primaryAction: ReaderDockPrimaryAction | undefined;
}

/**
 * What the Reader's player dock says and offers before audio exists: a failed
 * generation must never read as "Ready", and a model still loading shows its
 * own progress instead of a generate button that cannot work yet.
 */
export function deriveReaderDockState(input: ReaderDockInput): ReaderDockState {
  const {
    hasAudio,
    isGenerating,
    modelReady,
    modelError,
    generationError,
    canGenerate,
    charsRemaining,
    loadingProgress,
  } = input;
  const showRetry = !modelReady && !!modelError;
  const isPreparing = !modelReady && !modelError;
  const displayProgress = clamp(input.generationProgress, 0, 100);

  const statusLabel = isGenerating
    ? displayProgress > 0 ? `Generating ${Math.round(displayProgress)}%` : "Generating…"
    : showRetry
      ? "Model failed to load"
      : generationError && !hasAudio
        ? "Generation failed · try again"
        : isPreparing
          ? loadingProgress > 0 ? `Preparing ${Math.round(loadingProgress)}%` : "Preparing…"
          : hasAudio
            ? null
            : canGenerate
              ? "Ready to generate"
              : charsRemaining > 0
                ? `Need ${charsRemaining.toLocaleString()} more character${charsRemaining !== 1 ? "s" : ""}`
                : "Ready";

  if (hasAudio) return { statusLabel, showRetry, isPreparing, primaryAction: undefined };

  const disabled = !showRetry && (isGenerating || isPreparing || !canGenerate);
  return {
    statusLabel,
    showRetry,
    isPreparing,
    primaryAction: {
      label: showRetry
        ? "Retry model load"
        : isGenerating
          ? "Generating"
          : isPreparing
            ? loadingProgress > 0 ? `Preparing ${Math.round(loadingProgress)}%` : "Preparing"
            : generationError ? "Try generating again" : "Generate speech",
      disabled,
      busy: isGenerating || isPreparing,
      progress: isGenerating ? displayProgress : isPreparing ? loadingProgress : undefined,
      icon: showRetry ? "retry" : isGenerating || isPreparing ? "loading" : "generate",
      tone: showRetry || (generationError && !disabled) ? "danger" : disabled ? "neutral" : "accent",
    },
  };
}
