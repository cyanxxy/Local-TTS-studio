import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  BookOpen,
  ChevronDown,
  FileUp,
  Loader2,
  SlidersHorizontal,
} from "lucide-react";
import {
  MIN_TEXT_LENGTH,
  MODELS,
  QUALITY_MIN,
  QUALITY_MAX,
  QUALITY_STEP,
} from "../constants";
import { getMeaningfulTextLength } from "../lib/textValidation";
import type { ModelState, ModelType, GenerationStats } from "../types";
import type { AudioSegment } from "../hooks/useAudioPlayer";
import { chunkTextForModelDetailed } from "../lib/chunking";
import { AudioPlayer, type AudioPlayerPrimaryAction } from "./AudioPlayer";
import { ModelToggle } from "./ModelToggle";
import { VoiceSelector } from "./VoiceSelector";

interface AdvancedReaderPageProps {
  fullScreen?: boolean;
  text: string;
  onTextChange: (text: string) => void;
  /** Desktop-only document import (PDF/DOCX/images via LiteParse); absent on web builds. */
  onImportDocument?: () => void;
  isImportingDocument?: boolean;
  activeModel: ModelType;
  onModelChange: (model: ModelType) => void;
  desktopModelOptions?: ReaderDesktopModelOption[];
  desktopModelSettings?: ReactNode;
  kokoroState: ModelState;
  supertonicState: ModelState;
  unavailableModels?: Partial<Record<ModelType, string>>;
  kokoroVoices: string[];
  voice: string;
  onVoiceChange: (voice: string) => void;
  quality: number;
  onQualityChange: (quality: number) => void;
  canGenerate: boolean;
  modelReady: boolean;
  modelError: string | null;
  loadingProgress: number;
  generationProgress: number;
  isGenerating: boolean;
  onGenerate: () => void;
  onRetryLoad: () => void;
  onStop: () => void;
  stats: GenerationStats;
  isPlaying: boolean;
  currentTime: number;
  totalDuration: number;
  playbackRate?: number;
  onPlaybackRateChange?: (rate: number) => void;
  segments: AudioSegment[];
  activeSegmentId: string | null;
  onTogglePlay: () => void;
  onSeek: (percentage: number) => void;
  onSkipBackward: () => void;
  onSkipForward: () => void;
  onDownload: () => void;
  isRetaking: boolean;
  onRetakeSegment: (segmentId: string) => void;
  canRetakeSegments?: boolean;
  onJumpToSegment: (segmentId: string) => void;
}

interface ReaderDesktopModelOption {
  key: string;
  label: string;
  badge: string;
  detail: string;
  selected?: boolean;
  onSelect: () => void;
}

interface OverlayPart {
  text: string;
  sectionIndex: number;
  isActive: boolean;
}

interface SectionBoundary {
  start: number;
  end: number;
  id: string | null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** "af_heart" → "Heart" */
function formatVoiceName(id: string): string {
  const i = id.indexOf("_");
  if (i === -1) return id;
  const name = id.slice(i + 1).replace(/_/g, " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Splits the source text into contiguous spans aligned to section boundaries and
 * the active range. Spans carry only background styling (tint + highlight), never
 * inline content, so the overlay stays glyph-for-glyph identical to the textarea
 * beneath it — keeping the caret, highlights, and scrolling in sync.
 */
function buildOverlayParts(
  text: string,
  boundaries: SectionBoundary[],
  activeRange: { start: number; end: number } | null,
): OverlayPart[] {
  if (!text) return [];
  if (boundaries.length === 0 && !activeRange) {
    return [{ text, sectionIndex: -1, isActive: false }];
  }

  const offsets = new Set<number>([0, text.length]);
  for (const boundary of boundaries) {
    offsets.add(clamp(boundary.start, 0, text.length));
    offsets.add(clamp(boundary.end, 0, text.length));
  }
  if (activeRange) {
    offsets.add(clamp(activeRange.start, 0, text.length));
    offsets.add(clamp(activeRange.end, 0, text.length));
  }

  const sorted = [...offsets].sort((a, b) => a - b);
  const parts: OverlayPart[] = [];

  for (let i = 0; i < sorted.length - 1; i++) {
    const partStart = sorted[i];
    const partEnd = sorted[i + 1];
    if (partEnd <= partStart) continue;

    const sectionIndex = boundaries.findIndex(
      (boundary) => partStart >= boundary.start && partStart < boundary.end,
    );

    const isActive = activeRange
      ? partStart >= activeRange.start && partEnd <= activeRange.end
      : false;

    parts.push({
      text: text.slice(partStart, partEnd),
      sectionIndex,
      isActive,
    });
  }

  return parts;
}

/* Shared metrics for the overlay and the transparent textarea beneath it.
   Both must be glyph-for-glyph identical, so they always use this one string. */
const DOCUMENT_TEXT_CLASSES =
  "whitespace-pre-wrap break-words font-reading text-reader sm:text-reader-lg";

/* Horizontal padding comes from .reader-doc-pad, which centers a readable
   text column inside the full-bleed panel at any window size. */
function documentPadding(fullScreen: boolean): string {
  return fullScreen
    ? "reader-doc-pad pt-8 pb-44 sm:pt-12 sm:pb-48"
    : "reader-doc-pad py-8";
}

export function AdvancedReaderPage({
  fullScreen = false,
  text,
  onTextChange,
  onImportDocument,
  isImportingDocument = false,
  activeModel,
  onModelChange,
  desktopModelOptions = [],
  desktopModelSettings,
  kokoroState,
  supertonicState,
  unavailableModels,
  kokoroVoices,
  voice,
  onVoiceChange,
  quality,
  onQualityChange,
  canGenerate,
  modelReady,
  modelError,
  loadingProgress,
  generationProgress,
  isGenerating,
  onGenerate,
  onRetryLoad,
  onStop,
  stats,
  isPlaying,
  currentTime,
  totalDuration,
  playbackRate = 1,
  onPlaybackRateChange,
  segments,
  activeSegmentId,
  onTogglePlay,
  onSeek,
  onSkipBackward,
  onSkipForward,
  onDownload,
  isRetaking,
  onRetakeSegment,
  canRetakeSegments = true,
  onJumpToSegment,
}: AdvancedReaderPageProps) {
  const runtimeBackend = activeModel === "kokoro"
    ? kokoroState.backend
    : supertonicState.backend;
  const selectedDesktopModel = desktopModelOptions.find((option) => option.selected);
  const activeModelState = selectedDesktopModel
    ? {
        ready: modelReady,
        loading: !modelReady && !modelError,
        downloadProgress: loadingProgress,
        error: modelError,
        backend: null,
      }
    : activeModel === "kokoro" ? kokoroState : supertonicState;
  const activeModelLabel = selectedDesktopModel?.label ?? MODELS[activeModel].label;
  const overlayRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const readingTextId = useId();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const settingsOpenRef = useRef(settingsOpen);

  useEffect(() => {
    settingsOpenRef.current = settingsOpen;
  }, [settingsOpen]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!settingsOpenRef.current) return;
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const previewChunks = useMemo(
    () => chunkTextForModelDetailed(text, activeModel, { runtime: { backend: runtimeBackend, quality } }),
    [activeModel, quality, runtimeBackend, text],
  );

  const activeSegmentIndex = useMemo(
    () => segments.findIndex((segment) => segment.id === activeSegmentId),
    [activeSegmentId, segments],
  );

  const activeRange = useMemo(() => {
    const activeSegment = segments.find((segment) => segment.id === activeSegmentId) ?? null;
    if (
      activeSegment
      && typeof activeSegment.textStart === "number"
      && typeof activeSegment.textEnd === "number"
    ) {
      return {
        start: activeSegment.textStart,
        end: activeSegment.textEnd,
      };
    }

    const fallback = activeSegmentIndex >= 0 ? previewChunks[activeSegmentIndex] : null;
    if (fallback) {
      return { start: fallback.start, end: fallback.end };
    }

    return null;
  }, [activeSegmentId, activeSegmentIndex, previewChunks, segments]);

  const sectionBoundaries = useMemo((): SectionBoundary[] => {
    if (segments.length > 0) {
      return segments.map((seg, index) => {
        // Fall back to the matching preview chunk range when a segment lacks
        // offsets, so a missing boundary never expands to span the whole text.
        const fallback = previewChunks[index];
        return {
          start: seg.textStart ?? fallback?.start ?? 0,
          end: seg.textEnd ?? fallback?.end ?? text.length,
          id: seg.id,
        };
      });
    }
    return previewChunks.map((chunk) => ({
      start: chunk.start,
      end: chunk.end,
      id: null,
    }));
  }, [segments, previewChunks, text.length]);

  const overlayParts = useMemo(
    () => buildOverlayParts(text, sectionBoundaries, activeRange),
    [text, sectionBoundaries, activeRange],
  );

  const hasGeneratedSegments = segments.length > 0;
  const meaningfulLength = getMeaningfulTextLength(text);
  const charsRemaining = MIN_TEXT_LENGTH - meaningfulLength;
  const hasAudio = totalDuration > 0;
  const focusMode = isPlaying && activeRange !== null;

  // Auto-follow backs off after the user scrolls manually, so reading ahead
  // or reviewing earlier text is never yanked back to the spoken sentence.
  const programmaticScrollRef = useRef(false);
  const lastUserScrollAtRef = useRef(0);
  const USER_SCROLL_GRACE_MS = 4000;

  const syncOverlayScroll = (target: HTMLTextAreaElement) => {
    if (programmaticScrollRef.current) {
      programmaticScrollRef.current = false;
    } else {
      lastUserScrollAtRef.current = Date.now();
    }
    if (!overlayRef.current) return;
    overlayRef.current.scrollTop = target.scrollTop;
    overlayRef.current.scrollLeft = target.scrollLeft;
  };

  useEffect(() => {
    if (!isPlaying) return;
    if (Date.now() - lastUserScrollAtRef.current < USER_SCROLL_GRACE_MS) return;
    if (!overlayRef.current || !textareaRef.current) return;
    const marker = overlayRef.current.querySelector<HTMLElement>(".reader-chunk-highlight-active");
    if (!marker) return;

    // Keep the spoken sentence in the upper third of the page, book-style.
    const lead = Math.max(32, overlayRef.current.clientHeight * 0.28);
    const nextTop = Math.max(0, marker.offsetTop - lead);
    if (Math.abs(textareaRef.current.scrollTop - nextTop) < 1) return;
    programmaticScrollRef.current = true;
    overlayRef.current.scrollTop = nextTop;
    textareaRef.current.scrollTop = nextTop;
  }, [activeRange, isPlaying]);

  /* ── Player dock actions ──────────────────────────────────── */
  const showRetry = !modelReady && !!modelError;
  const isPreparing = !modelReady && !modelError;
  const displayProgress = clamp(generationProgress, 0, 100);

  const statusLabel = isGenerating
    ? displayProgress > 0 ? `Generating ${Math.round(displayProgress)}%` : "Generating…"
    : showRetry
      ? "Model failed to load"
      : isPreparing
        ? loadingProgress > 0 ? `Preparing ${Math.round(loadingProgress)}%` : "Preparing…"
        : hasAudio
          ? null
          : canGenerate
            ? "Ready to generate"
            : charsRemaining > 0
              ? `Need ${charsRemaining.toLocaleString()} more character${charsRemaining !== 1 ? "s" : ""}`
              : "Ready";

  const primaryActionDisabled = !showRetry && (isGenerating || isPreparing || !canGenerate);
  const handlePrimaryAction = useCallback(() => {
    if (showRetry) {
      onRetryLoad();
      return;
    }
    if (isGenerating || isPreparing) return;
    if (canGenerate) onGenerate();
  }, [canGenerate, isGenerating, isPreparing, onGenerate, onRetryLoad, showRetry]);

  const primaryAction: AudioPlayerPrimaryAction | undefined = hasAudio
    ? undefined
    : {
        label: showRetry
          ? "Retry model load"
          : isGenerating
            ? "Generating"
            : isPreparing
              ? loadingProgress > 0 ? `Preparing ${Math.round(loadingProgress)}%` : "Preparing"
              : "Generate speech",
        onClick: handlePrimaryAction,
        disabled: primaryActionDisabled,
        busy: isGenerating || isPreparing,
        progress: isGenerating ? displayProgress : isPreparing ? loadingProgress : undefined,
        icon: showRetry ? "retry" : isGenerating || isPreparing ? "loading" : "generate",
        tone: showRetry ? "danger" : primaryActionDisabled ? "neutral" : "accent",
      };

  const canPreviousSegment = activeSegmentIndex > 0;
  const canNextSegment = activeSegmentIndex >= 0 && activeSegmentIndex < segments.length - 1;
  const activeSegmentNumber = activeSegmentIndex >= 0 ? activeSegmentIndex + 1 : null;
  const canRetakeCurrentSegment = hasGeneratedSegments && canRetakeSegments && activeSegmentIndex >= 0 && !isRetaking;

  const handlePreviousSegment = useCallback(() => {
    if (activeSegmentIndex > 0) {
      onJumpToSegment(segments[activeSegmentIndex - 1].id);
    }
  }, [activeSegmentIndex, onJumpToSegment, segments]);

  const handleNextSegment = useCallback(() => {
    if (activeSegmentIndex >= 0 && activeSegmentIndex < segments.length - 1) {
      onJumpToSegment(segments[activeSegmentIndex + 1].id);
    }
  }, [activeSegmentIndex, onJumpToSegment, segments]);

  const handleRetakeCurrentSegment = useCallback(() => {
    if (activeSegmentIndex >= 0) {
      onRetakeSegment(segments[activeSegmentIndex].id);
    }
  }, [activeSegmentIndex, onRetakeSegment, segments]);

  return (
    <div className={`flex w-full flex-col gap-3 sm:gap-4 ${fullScreen ? "min-h-[calc(100vh-9.5rem)]" : "mt-6"}`}>

      {/* ── Toolbar ─────────────────────────────────────────── */}
      {/* relative z-30 lifts the toolbar's stacking context above the document
          panel so the settings popover never paints behind the reader overlay */}
      <div className="glass relative z-30 flex items-center justify-between gap-3 rounded-2xl py-2 pr-2 pl-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-light">
            <BookOpen size={14} className="text-accent" />
          </div>
          <div className="min-w-0">
            <h2 className="font-display text-lg leading-none font-semibold text-text-primary">Reader</h2>
            <p className="mt-0.5 truncate font-mono text-xs tabular-nums text-text-muted">
              {meaningfulLength.toLocaleString()} chars · {previewChunks.length} section{previewChunks.length !== 1 ? "s" : ""}
              {statusLabel ? ` · ${statusLabel}` : ""}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
        {onImportDocument && (
          <button
            type="button"
            onClick={onImportDocument}
            disabled={isImportingDocument}
            aria-label="Import document"
            title="Import a document (PDF, text, Office, images)"
            className="flex items-center gap-2 rounded-xl border border-white/50 bg-white/40 px-3 py-2 text-sm text-text-primary shadow-glass-sm backdrop-blur-md transition-all duration-200 hover:-translate-y-px hover:bg-white/60 active:translate-y-0 active:scale-[0.98] disabled:cursor-default disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:bg-white/40"
          >
            {isImportingDocument
              ? <Loader2 size={14} className="animate-spin text-text-muted" />
              : <FileUp size={14} className="text-text-muted" />}
            <span className="hidden font-medium sm:inline">
              {isImportingDocument ? "Importing…" : "Import"}
            </span>
          </button>
        )}

        {/* Voice & model settings popover */}
        <div ref={settingsRef} className="relative">
          <button
            type="button"
            onClick={() => setSettingsOpen((o) => !o)}
            aria-expanded={settingsOpen}
            aria-label="Voice settings"
            className="flex items-center gap-2 rounded-xl border border-white/50 bg-white/40 px-3 py-2 text-sm text-text-primary shadow-glass-sm backdrop-blur-md transition-all duration-200 hover:-translate-y-px hover:bg-white/60 active:translate-y-0 active:scale-[0.98]"
          >
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                activeModelState.ready ? "bg-success" : activeModelState.error ? "bg-danger" : "bg-text-muted animate-pulse"
              }`}
              style={activeModelState.ready ? { boxShadow: "0 0 6px color-mix(in srgb, var(--color-success) 60%, transparent)" } : undefined}
            />
            <span className="hidden font-medium sm:inline">{formatVoiceName(voice)}</span>
            <span className="hidden text-xs text-text-muted md:inline">{activeModelLabel}</span>
            <SlidersHorizontal size={13} className="text-text-muted sm:hidden" />
            <ChevronDown
              size={13}
              className={`hidden text-text-muted transition-transform duration-200 sm:block ${settingsOpen ? "rotate-180" : ""}`}
            />
          </button>

          {settingsOpen && (
            <div className="glass-pop animate-scale-in absolute top-full right-0 z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] origin-top-right rounded-2xl p-4">
              <div className="flex flex-col gap-4">
                <ModelToggle
                  activeModel={activeModel}
                  onModelChange={onModelChange}
                  kokoroState={kokoroState}
                  supertonicState={supertonicState}
                  unavailableModels={unavailableModels}
                />

                {desktopModelOptions.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-semibold uppercase tracking-widest text-text-muted">
                      Desktop runtime
                    </span>
                    <div className="grid grid-cols-1 gap-1.5">
                      {desktopModelOptions.map((option) => (
                        <button
                          key={option.key}
                          type="button"
                          onClick={() => {
                            option.onSelect();
                            setSettingsOpen(false);
                          }}
                          className={`flex min-w-0 items-start justify-between gap-3 rounded-2xl border px-3 py-2.5 text-left text-lg font-semibold backdrop-blur-md transition-all duration-200 active:translate-y-0 active:scale-[0.98] ${
                            option.selected
                              ? "border-accent/40 bg-accent/[0.10] text-accent shadow-accent-sm ring-1 ring-accent/15"
                              : "border-white/50 bg-white/35 text-text-muted shadow-glass-sm hover:-translate-y-0.5 hover:bg-white/55 hover:text-text-primary"
                          }`}
                        >
                          <span className="min-w-0">
                            <span className={option.selected ? "block text-accent" : "block text-text-primary"}>{option.label}</span>
                            <span className="mt-0.5 block text-xs font-medium leading-4 text-text-muted">
                              {option.detail}
                            </span>
                          </span>
                          <span className="shrink-0 rounded-full border border-accent/25 bg-accent-light px-2 py-0.5 font-mono text-2xs uppercase tracking-[0.12em] text-accent">
                            {option.badge}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {selectedDesktopModel && desktopModelSettings}

                {!selectedDesktopModel && (
                  <VoiceSelector
                    activeModel={activeModel}
                    voice={voice}
                    onVoiceChange={onVoiceChange}
                    kokoroVoices={kokoroVoices}
                  />
                )}

                {!selectedDesktopModel && activeModel === "supertonic" && (
                  <div>
                    <div className="mb-2 flex items-baseline justify-between">
                      <label
                        htmlFor={`${readingTextId}-quality`}
                        className="text-xs font-semibold uppercase tracking-widest text-text-muted"
                      >
                        Quality
                      </label>
                      <span className="font-mono text-sm font-medium tabular-nums text-text-primary">
                        {quality} steps
                      </span>
                    </div>
                    <input
                      id={`${readingTextId}-quality`}
                      type="range"
                      min={QUALITY_MIN}
                      max={QUALITY_MAX}
                      step={QUALITY_STEP}
                      value={quality}
                      onChange={(e) => onQualityChange(parseInt(e.target.value))}
                    />
                    <div className="mt-1.5 flex justify-between">
                      <span className="text-xs text-text-muted">Faster</span>
                      <span className="text-xs text-text-muted">Higher quality</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        </div>
      </div>

      {/* ── Document ────────────────────────────────────────── */}
      <section className={`glass-panel relative overflow-hidden rounded-[28px] ${fullScreen ? "flex-1" : ""}`}>
        <label htmlFor={readingTextId} className="sr-only">
          Reading Text
        </label>
        <div className={`relative ${fullScreen ? "h-full min-h-[55vh]" : "min-h-72"}`}>
          <div
            ref={overlayRef}
            aria-hidden
            className={`pointer-events-none absolute inset-0 z-20 select-none overflow-auto text-text-primary ${DOCUMENT_TEXT_CLASSES} ${documentPadding(fullScreen)} ${focusMode ? "reader-focus" : ""}`}
          >
            {overlayParts.map((part, index) => {
              const activeClass = part.isActive
                ? "reader-chunk-highlight reader-chunk-highlight-active"
                : "";
              const tintClass = part.sectionIndex >= 0
                ? part.sectionIndex % 2 === 0
                  ? "reader-section-even"
                  : "reader-section-odd"
                : "";
              const className = `${tintClass} ${activeClass}`.trim();

              return (
                <span key={`part-${index}`} className={className || undefined}>
                  {part.text}
                </span>
              );
            })}
            {/* Mirror a trailing blank line so the textarea's final newline keeps overlay height in sync. */}
            {text.endsWith("\n") && <span>{"\n"}</span>}
          </div>

          <textarea
            id={readingTextId}
            ref={textareaRef}
            value={text}
            onChange={(event) => onTextChange(event.target.value)}
            onScroll={(event) => syncOverlayScroll(event.currentTarget)}
            onMouseUp={(event) => {
              if (!hasGeneratedSegments) return;
              const ta = event.currentTarget;
              if (ta.selectionStart !== ta.selectionEnd) return;
              const pos = ta.selectionStart;
              const boundary = sectionBoundaries.find(
                (b) => b.id !== null && pos >= b.start && pos < b.end,
              );
              if (boundary?.id) onJumpToSegment(boundary.id);
            }}
            placeholder="Type or paste long-form text to read aloud…"
            className={`absolute inset-0 z-10 h-full w-full resize-none bg-transparent text-transparent caret-text-primary placeholder:font-sans placeholder:text-text-muted focus:outline-none ${DOCUMENT_TEXT_CLASSES} ${documentPadding(fullScreen)}`}
            style={{ WebkitTextFillColor: "transparent" }}
          />
        </div>
      </section>

      {/* ── Player dock ─────────────────────────────────────── */}
      <div
        className={
          fullScreen
            ? "fixed bottom-4 left-1/2 z-40 w-[min(44rem,calc(100vw-1.5rem))] -translate-x-1/2 sm:bottom-6"
            : "w-full"
        }
      >
        <AudioPlayer
          variant="dock"
          embedded
          isPlaying={isPlaying}
          currentTime={currentTime}
          totalDuration={totalDuration}
          segmentCount={segments.length}
          activeSegmentNumber={activeSegmentNumber}
          sectionPreviewCount={previewChunks.length}
          statusLabel={statusLabel}
          stats={stats}
          isGenerating={isGenerating}
          allowPlaybackDuringGeneration
          playbackRate={playbackRate}
          onPlaybackRateChange={onPlaybackRateChange}
          canPreviousSegment={canPreviousSegment}
          canNextSegment={canNextSegment}
          onPreviousSegment={handlePreviousSegment}
          onNextSegment={handleNextSegment}
          canRegenerate={hasAudio && !isGenerating && canGenerate}
          onRegenerate={onGenerate}
          canRetakeSegment={canRetakeCurrentSegment}
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
    </div>
  );
}
