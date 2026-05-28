import { useEffect, useId, useMemo, useRef } from "react";
import { BookOpen, ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";
import { MIN_TEXT_LENGTH } from "../constants";
import type { ModelState, ModelType, GenerationStats } from "../types";
import type { AudioSegment } from "../hooks/useAudioPlayer";
import { chunkTextForModelDetailed } from "../lib/chunking";
import { ModelToggle } from "./ModelToggle";
import { VoiceSelector } from "./VoiceSelector";
import { ControlsProvider } from "./ControlsContext";
import { Controls } from "./Controls";
import { AudioPlayer } from "./AudioPlayer";

interface AdvancedReaderPageProps {
  fullScreen?: boolean;
  text: string;
  onTextChange: (text: string) => void;
  activeModel: ModelType;
  onModelChange: (model: ModelType) => void;
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
  segments: AudioSegment[];
  activeSegmentId: string | null;
  onTogglePlay: () => void;
  onSeek: (percentage: number) => void;
  onSkipBackward: () => void;
  onSkipForward: () => void;
  onDownload: () => void;
  isRetaking: boolean;
  onRetakeSegment: (segmentId: string) => void;
  onJumpToSegment: (segmentId: string) => void;
}

interface OverlayPart {
  text: string;
  sectionIndex: number;
  isActive: boolean;
  isSectionStart: boolean;
  sectionId: string | null;
}

interface SectionBoundary {
  start: number;
  end: number;
  id: string | null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function buildOverlayParts(
  text: string,
  boundaries: SectionBoundary[],
  activeRange: { start: number; end: number } | null,
): OverlayPart[] {
  if (!text) return [];
  if (boundaries.length === 0 && !activeRange) {
    return [{ text, sectionIndex: -1, isActive: false, isSectionStart: false, sectionId: null }];
  }

  const offsets = new Set<number>([0, text.length]);
  for (const b of boundaries) {
    offsets.add(clamp(b.start, 0, text.length));
    offsets.add(clamp(b.end, 0, text.length));
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

    let sectionIndex = -1;
    let sectionId: string | null = null;
    for (let s = 0; s < boundaries.length; s++) {
      if (partStart >= boundaries[s].start && partStart < boundaries[s].end) {
        sectionIndex = s;
        sectionId = boundaries[s].id;
        break;
      }
    }

    const isActive = activeRange
      ? partStart >= activeRange.start && partEnd <= activeRange.end
      : false;

    const isSectionStart = sectionIndex >= 0
      && clamp(boundaries[sectionIndex].start, 0, text.length) === partStart;

    parts.push({
      text: text.slice(partStart, partEnd),
      sectionIndex,
      isActive,
      isSectionStart,
      sectionId,
    });
  }

  return parts;
}

export function AdvancedReaderPage({
  fullScreen = false,
  text,
  onTextChange,
  activeModel,
  onModelChange,
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
  segments,
  activeSegmentId,
  onTogglePlay,
  onSeek,
  onSkipBackward,
  onSkipForward,
  onDownload,
  isRetaking,
  onRetakeSegment,
  onJumpToSegment,
}: AdvancedReaderPageProps) {
  const activeSegmentNumber = useMemo(() => {
    if (!activeSegmentId) return null;
    const index = segments.findIndex((segment) => segment.id === activeSegmentId);
    return index >= 0 ? index + 1 : null;
  }, [activeSegmentId, segments]);

  const runtimeBackend = activeModel === "kokoro"
    ? kokoroState.backend
    : supertonicState.backend;
  const overlayRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const readingTextId = useId();

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
      return segments.map((seg) => ({
        start: seg.textStart ?? 0,
        end: seg.textEnd ?? text.length,
        id: seg.id,
      }));
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

  const syncOverlayScroll = (target: HTMLTextAreaElement) => {
    if (!overlayRef.current) return;
    overlayRef.current.scrollTop = target.scrollTop;
    overlayRef.current.scrollLeft = target.scrollLeft;
  };

  useEffect(() => {
    if (!overlayRef.current || !textareaRef.current) return;
    const marker = overlayRef.current.querySelector<HTMLElement>(".reader-chunk-highlight-active");
    if (!marker) return;

    const nextTop = Math.max(0, marker.offsetTop - 32);
    overlayRef.current.scrollTop = nextTop;
    textareaRef.current.scrollTop = nextTop;
  }, [activeRange]);

  return (
    <div className={`grid grid-cols-1 lg:grid-cols-5 ${fullScreen ? "gap-3 sm:gap-4" : "mt-6 gap-4 sm:gap-5"} ${fullScreen ? "min-h-[calc(100vh-9.5rem)]" : ""}`}>
      <section className={`${fullScreen ? "lg:col-span-5" : "lg:col-span-3"} flex h-full flex-col gap-4 rounded-[22px] glass-panel p-4 sm:gap-5 sm:p-6`}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-accent-light flex items-center justify-center shrink-0">
                <BookOpen size={14} className="text-accent" />
              </div>
              <h2 className="text-lg font-display font-semibold text-text-primary">Reader Mode</h2>
            </div>
            <p className="mt-1.5 text-xs text-text-muted pl-9">
              Edit your text with chunk boundaries rendered directly inside the editor.
            </p>
          </div>
          {hasGeneratedSegments && activeSegmentIndex >= 0 && (
            <div className="shrink-0 animate-fade-up">
              <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold font-mono bg-accent-light text-accent border border-accent/20 tabular-nums">
                <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                {activeSegmentIndex + 1} / {segments.length}
              </span>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <label
            htmlFor={readingTextId}
            className="text-xs font-semibold uppercase tracking-widest text-text-muted"
          >
            Reading Text
          </label>
          <div className={`relative rounded-2xl border border-black/10 bg-surface/50 backdrop-blur-md shadow-glass-sm transition-shadow duration-200 focus-within:shadow-accent-sm ${fullScreen ? "min-h-[40vh] sm:min-h-[45vh]" : "min-h-64"}`}>

            <div
              ref={overlayRef}
              aria-hidden
              className="pointer-events-none absolute inset-0 z-20 overflow-auto whitespace-pre-wrap break-words px-4 py-3 text-lg leading-6 text-text-primary select-none sm:text-xl sm:leading-7"
            >
              {overlayParts.map((part, index) => {
                const isGenerated = part.sectionId !== null;
                const activeClass = part.isActive
                  ? "reader-chunk-highlight reader-chunk-highlight-active"
                  : "";
                const tintClass = part.sectionIndex >= 0
                  ? part.sectionIndex % 2 === 0
                    ? "reader-section-even"
                    : "reader-section-odd"
                  : "";

                return (
                  <span key={`part-${index}`} className={`${tintClass} ${activeClass}`.trim() || undefined}>
                    {part.isSectionStart && part.sectionIndex >= 0 && (
                      <span
                        className={`reader-section-badge ${
                          isGenerated
                            ? "reader-section-badge-generated pointer-events-auto cursor-pointer"
                            : "reader-section-badge-preview"
                        }`}
                        onClick={
                          isGenerated && part.sectionId
                            ? (e) => {
                                e.stopPropagation();
                                onJumpToSegment(part.sectionId!);
                              }
                            : undefined
                        }
                      >
                        {part.sectionIndex + 1}
                      </span>
                    )}
                    {part.text}
                  </span>
                );
              })}
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
              placeholder="Paste or write long-form text to read aloud"
              className={`relative z-10 h-full w-full resize-none rounded-xl bg-transparent px-4 py-3 text-lg leading-6 text-transparent caret-text-primary placeholder:text-text-muted focus:outline-none sm:text-xl sm:leading-7 ${
                fullScreen ? "min-h-[40vh] sm:min-h-[45vh]" : "min-h-64"
              }`}
              style={{ WebkitTextFillColor: "transparent" }}
            />
          </div>
          {hasGeneratedSegments && (
            <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-white/55 bg-white/40 backdrop-blur-md shadow-glass-sm px-3 py-2 animate-fade-up sm:flex-nowrap">
              <button
                type="button"
                aria-label="Previous segment"
                onClick={() => {
                  if (activeSegmentIndex > 0) {
                    onJumpToSegment(segments[activeSegmentIndex - 1].id);
                  }
                }}
                disabled={activeSegmentIndex <= 0}
                className="order-1 rounded-lg p-1.5 text-text-secondary transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:text-text-muted"
              >
                <ChevronLeft size={13} />
              </button>

              <div className="order-4 flex min-w-0 basis-full items-center gap-2.5 sm:order-2 sm:basis-auto sm:flex-1">
                <div className="flex-1 h-[3px] rounded-full bg-surface overflow-hidden">
                  <div
                    className="h-full rounded-full bg-accent transition-all duration-300 ease-out"
                    style={{
                      width: activeSegmentIndex >= 0
                        ? `${((activeSegmentIndex + 1) / segments.length) * 100}%`
                        : "0%",
                    }}
                  />
                </div>
                <span className="text-xs font-mono text-text-muted tabular-nums whitespace-nowrap shrink-0">
                  {activeSegmentIndex >= 0 ? activeSegmentIndex + 1 : "–"} / {segments.length}
                </span>
              </div>

              <button
                type="button"
                aria-label="Next segment"
                onClick={() => {
                  if (activeSegmentIndex >= 0 && activeSegmentIndex < segments.length - 1) {
                    onJumpToSegment(segments[activeSegmentIndex + 1].id);
                  }
                }}
                disabled={activeSegmentIndex < 0 || activeSegmentIndex >= segments.length - 1}
                className="order-2 rounded-lg p-1.5 text-text-secondary transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:text-text-muted sm:order-3"
              >
                <ChevronRight size={13} />
              </button>

              <div className="mx-0.5 hidden h-4 w-px shrink-0 bg-border sm:order-4 sm:block" />

              <button
                type="button"
                onClick={() => {
                  if (activeSegmentIndex >= 0) {
                    onRetakeSegment(segments[activeSegmentIndex].id);
                  }
                }}
                disabled={activeSegmentIndex < 0 || isRetaking}
                className="order-5 flex w-full items-center justify-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold text-accent transition-colors hover:bg-accent-light disabled:cursor-not-allowed disabled:text-text-muted sm:w-auto sm:justify-start"
              >
                <RotateCcw size={10} />
                {isRetaking ? "Retaking…" : "Retake"}
              </button>
            </div>
          )}

          <div className="flex flex-col gap-1 text-sm text-text-muted sm:flex-row sm:items-center sm:justify-between">
            <span className="tabular-nums">{text.length.toLocaleString()} chars</span>
            <span className={text.length >= MIN_TEXT_LENGTH ? "text-success" : ""}>
              {previewChunks.length} chunk{previewChunks.length !== 1 ? "s" : ""}
              {text.length < MIN_TEXT_LENGTH
                ? ` · Need ${(MIN_TEXT_LENGTH - text.length).toLocaleString()} more`
                : " · Ready"}
            </span>
          </div>
        </div>

      </section>

      {(totalDuration > 0 || isGenerating) && (
        <div className={fullScreen ? "lg:col-span-5" : "lg:col-span-3"}>
          <AudioPlayer
            compact={fullScreen}
            isPlaying={isPlaying}
            currentTime={currentTime}
            totalDuration={totalDuration}
            segmentCount={segments.length}
            activeSegmentNumber={activeSegmentNumber}
            stats={stats}
            isGenerating={isGenerating}
            onTogglePlay={onTogglePlay}
            onSeek={onSeek}
            onSkipBackward={onSkipBackward}
            onSkipForward={onSkipForward}
            onDownload={onDownload}
            onStop={onStop}
          />
        </div>
      )}

      <aside className={`${fullScreen ? "lg:col-span-5 gap-4 rounded-[20px] p-4 sm:p-5" : "lg:col-span-2 gap-5 rounded-[22px] p-4 sm:gap-6 sm:p-6"} flex h-full flex-col glass-panel`}>
        <ModelToggle
          activeModel={activeModel}
          onModelChange={onModelChange}
          kokoroState={kokoroState}
          supertonicState={supertonicState}
          unavailableModels={unavailableModels}
        />

        <VoiceSelector
          activeModel={activeModel}
          voice={voice}
          onVoiceChange={onVoiceChange}
          kokoroVoices={kokoroVoices}
        />

        <ControlsProvider
          value={{
            activeModel,
            quality,
            onQualityChange,
            onGenerate,
            onRetryLoad,
            onStop,
            isGenerating,
            canGenerate,
            modelReady,
            modelError,
            loadingProgress,
            generationProgress,
          }}
        >
          <Controls />
        </ControlsProvider>

      </aside>
    </div>
  );
}
