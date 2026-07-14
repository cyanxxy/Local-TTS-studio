import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  BookOpen,
  ChevronDown,
  FileUp,
  Library,
  Link2,
  Loader2,
  Plus,
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
import { buildQwen3TextUnits } from "../lib/qwenChunking";
import {
  estimateWordRanges,
  type ReaderDocumentRecord,
} from "../lib/readerDocument";
import { AudioPlayer, type AudioPlayerPrimaryAction } from "./AudioPlayer";
import { ModelToggle } from "./ModelToggle";
import { ReaderLibrarySidebar } from "./ReaderLibrarySidebar";
import { VoiceSelector } from "./VoiceSelector";

interface AdvancedReaderPageProps {
  fullScreen?: boolean;
  text: string;
  onTextChange: (text: string) => void;
  /** Desktop-only document import (PDF/DOCX/images via LiteParse); absent on web builds. */
  onImportDocument?: () => void;
  isImportingDocument?: boolean;
  onImportFile?: (file: File) => Promise<void> | void;
  onImportUrl?: (url: string) => Promise<void> | void;
  documents?: ReaderDocumentRecord[];
  activeDocument?: ReaderDocumentRecord | null;
  libraryLoading?: boolean;
  libraryError?: string | null;
  libraryPersistent?: boolean;
  onNewDocument?: () => void;
  onOpenDocument?: (id: string) => void;
  onDeleteDocument?: (id: string) => void;
  onUpdateDocumentMetadata?: (
    patch: Pick<Partial<ReaderDocumentRecord>, "title" | "author">,
  ) => void;
  onAddBookmark?: (input: { label: string; textOffset: number; positionSec: number }) => void;
  onRemoveBookmark?: (id: string) => void;
  onAddNote?: (input: { text: string; quote: string; textOffset: number }) => void;
  onUpdateNote?: (id: string, text: string) => void;
  onRemoveNote?: (id: string) => void;
  activeModel: ModelType;
  onModelChange: (model: ModelType) => void;
  desktopModelOptions?: ReaderDesktopModelOption[];
  desktopVoiceLabel?: string;
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
  isWordActive: boolean;
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
  activeWordRange: { start: number; end: number } | null,
): OverlayPart[] {
  if (!text) return [];
  if (boundaries.length === 0 && !activeRange && !activeWordRange) {
    return [{ text, sectionIndex: -1, isActive: false, isWordActive: false }];
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
  if (activeWordRange) {
    offsets.add(clamp(activeWordRange.start, 0, text.length));
    offsets.add(clamp(activeWordRange.end, 0, text.length));
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
    const isWordActive = activeWordRange
      ? partStart >= activeWordRange.start && partEnd <= activeWordRange.end
      : false;

    parts.push({
      text: text.slice(partStart, partEnd),
      sectionIndex,
      isActive,
      isWordActive,
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
  onImportFile,
  onImportUrl,
  documents = [],
  activeDocument = null,
  libraryLoading = false,
  libraryError = null,
  libraryPersistent = true,
  onNewDocument,
  onOpenDocument,
  onDeleteDocument,
  onUpdateDocumentMetadata,
  onAddBookmark,
  onRemoveBookmark,
  onAddNote,
  onUpdateNote,
  onRemoveNote,
  activeModel,
  onModelChange,
  desktopModelOptions = [],
  desktopVoiceLabel,
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
  const activeVoiceLabel = selectedDesktopModel
    ? desktopVoiceLabel ?? selectedDesktopModel.label
    : formatVoiceName(voice);
  const overlayRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const readingTextId = useId();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [urlImportOpen, setUrlImportOpen] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [urlImportError, setUrlImportError] = useState<string | null>(null);
  const [urlImportBusy, setUrlImportBusy] = useState(false);
  const [navigationTextOffset, setNavigationTextOffset] = useState<number | null>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const settingsOpenRef = useRef(settingsOpen);

  useEffect(() => {
    settingsOpenRef.current = settingsOpen;
  }, [settingsOpen]);

  useEffect(() => {
    setNavigationTextOffset(null);
  }, [activeDocument?.id, text]);

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
    () => selectedDesktopModel?.key === "qwen3"
      ? buildQwen3TextUnits(text)
      : chunkTextForModelDetailed(text, activeModel, { runtime: { backend: runtimeBackend, quality } }),
    [activeModel, quality, runtimeBackend, selectedDesktopModel?.key, text],
  );

  const activeSegmentIndex = useMemo(
    () => segments.findIndex((segment) => segment.id === activeSegmentId),
    [activeSegmentId, segments],
  );

  const activeSegment = useMemo(
    () => segments.find((segment) => segment.id === activeSegmentId) ?? null,
    [activeSegmentId, segments],
  );

  const activeRange = useMemo(() => {
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
  }, [activeSegment, activeSegmentIndex, previewChunks]);

  const estimatedWords = useMemo(() => {
    if (!activeSegment || typeof activeSegment.textStart !== "number") return [];
    const speechEnd = Math.max(
      activeSegment.startSec,
      activeSegment.endSec - Math.max(0, activeSegment.pauseAfterSec ?? 0),
    );
    return estimateWordRanges(
      activeSegment.text,
      activeSegment.textStart,
      activeSegment.startSec,
      speechEnd,
    );
  }, [activeSegment]);

  const activeWordRange = useMemo(() => {
    const activeWord = estimatedWords.find(
      (word) => currentTime >= word.startSec && currentTime < word.endSec,
    );
    return activeWord ? { start: activeWord.start, end: activeWord.end } : null;
  }, [currentTime, estimatedWords]);

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
    () => buildOverlayParts(text, sectionBoundaries, activeRange, activeWordRange),
    [text, sectionBoundaries, activeRange, activeWordRange],
  );

  const hasGeneratedSegments = segments.length > 0;
  const meaningfulLength = getMeaningfulTextLength(text);
  const charsRemaining = MIN_TEXT_LENGTH - meaningfulLength;
  const hasAudio = totalDuration > 0;
  const focusMode = isPlaying && activeRange !== null;
  const currentTextOffset = activeWordRange?.start
    ?? activeRange?.start
    ?? navigationTextOffset
    ?? activeDocument?.progress.textOffset
    ?? 0;
  const readingProgress = activeDocument?.progress.percent
    ?? (text.length > 0 ? (currentTextOffset / text.length) * 100 : 0);
  const currentChapter = activeDocument?.chapters.find(
    (chapter) => currentTextOffset >= chapter.start && currentTextOffset < chapter.end,
  ) ?? activeDocument?.chapters.at(-1) ?? null;

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
    const marker = overlayRef.current.querySelector<HTMLElement>(".reader-word-highlight-active")
      ?? overlayRef.current.querySelector<HTMLElement>(".reader-chunk-highlight-active");
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

  const handleJumpToOffset = useCallback((offset: number, positionSec?: number) => {
    const targetOffset = clamp(offset, 0, text.length);
    setNavigationTextOffset(targetOffset);
    if (typeof positionSec === "number" && totalDuration > 0) {
      onSeek(clamp(positionSec / totalDuration, 0, 1));
    } else {
      const targetSegment = segments.find((segment) => (
        typeof segment.textStart === "number"
        && typeof segment.textEnd === "number"
        && targetOffset >= segment.textStart
        && targetOffset < segment.textEnd
      )) ?? segments.find((segment) => typeof segment.textStart === "number" && segment.textStart >= targetOffset);
      if (targetSegment) onJumpToSegment(targetSegment.id);
    }

    const textarea = textareaRef.current;
    if (textarea) {
      textarea.focus();
      textarea.setSelectionRange(targetOffset, targetOffset);
      const ratio = text.length > 0 ? targetOffset / text.length : 0;
      const nextTop = Math.max(0, ratio * (textarea.scrollHeight - textarea.clientHeight));
      programmaticScrollRef.current = true;
      textarea.scrollTop = nextTop;
      if (overlayRef.current) overlayRef.current.scrollTop = nextTop;
    }
  }, [onJumpToSegment, onSeek, segments, text.length, totalDuration]);

  const handleFilePick = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void onImportFile?.(file);
  }, [onImportFile]);

  const handleUrlImport = useCallback(async () => {
    const url = urlInput.trim();
    if (!url || !onImportUrl || urlImportBusy) return;
    setUrlImportBusy(true);
    setUrlImportError(null);
    try {
      await onImportUrl(url);
      setUrlInput("");
      setUrlImportOpen(false);
      setLibraryOpen(true);
    } catch (error) {
      setUrlImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setUrlImportBusy(false);
    }
  }, [onImportUrl, urlImportBusy, urlInput]);

  const handleDeleteDocument = useCallback((id: string) => {
    const document = documents.find((entry) => entry.id === id);
    if (!document || !onDeleteDocument) return;
    if (window.confirm(`Delete “${document.title}” and its cached audio?`)) onDeleteDocument(id);
  }, [documents, onDeleteDocument]);

  return (
    <div className={`relative flex w-full flex-col gap-3 sm:gap-4 ${fullScreen ? "min-h-[calc(100vh-9.5rem)]" : "mt-6"}`}>

      <ReaderLibrarySidebar
        open={libraryOpen}
        documents={documents}
        activeDocument={activeDocument}
        currentTextOffset={currentTextOffset}
        currentTime={currentTime}
        loading={libraryLoading}
        persistent={libraryPersistent}
        onClose={() => setLibraryOpen(false)}
        onOpenDocument={(id) => onOpenDocument?.(id)}
        onNewDocument={() => onNewDocument?.()}
        onDeleteDocument={handleDeleteDocument}
        onUpdateMetadata={(patch) => onUpdateDocumentMetadata?.(patch)}
        onJumpToOffset={handleJumpToOffset}
        onAddBookmark={(input) => onAddBookmark?.(input)}
        onRemoveBookmark={(id) => onRemoveBookmark?.(id)}
        onAddNote={(input) => onAddNote?.(input)}
        onUpdateNote={(id, value) => onUpdateNote?.(id, value)}
        onRemoveNote={(id) => onRemoveNote?.(id)}
      />

      <input
        ref={fileInputRef}
        type="file"
        accept=".epub,.txt,.md,.html,.htm"
        onChange={handleFilePick}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
      />

      {/* ── Toolbar ─────────────────────────────────────────── */}
      {/* relative z-30 lifts the toolbar's stacking context above the document
          panel so the settings popover never paints behind the reader overlay */}
      <div className="glass relative z-30 flex flex-wrap items-center justify-between gap-2 rounded-2xl py-2 pr-2 pl-3 sm:gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-light">
            <BookOpen size={14} className="text-accent" />
          </div>
          <div className="min-w-0">
            <h2 className="truncate font-display text-lg leading-none font-semibold text-text-primary">
              {activeDocument?.title || "Reader"}
            </h2>
            <p className="mt-0.5 truncate font-mono text-xs tabular-nums text-text-muted">
              {activeDocument?.author ? `${activeDocument.author} · ` : ""}
              {Math.round(readingProgress)}% · {activeDocument?.chapters.length ?? previewChunks.length} chapter{(activeDocument?.chapters.length ?? previewChunks.length) !== 1 ? "s" : ""}
              {statusLabel ? ` · ${statusLabel}` : ""}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => setLibraryOpen(true)}
          aria-label="Open Reader library"
          className="flex items-center gap-2 rounded-xl border border-white/50 bg-white/40 px-3 py-2 text-sm text-text-primary shadow-glass-sm backdrop-blur-md transition-all duration-200 hover:-translate-y-px hover:bg-white/60 active:translate-y-0 active:scale-[0.98]"
        >
          <Library size={14} className="text-text-muted" />
          <span className="hidden font-medium lg:inline">Library</span>
          <span className="rounded-full bg-accent-light px-1.5 font-mono text-2xs text-accent">{documents.length}</span>
        </button>

        {onNewDocument && (
          <button
            type="button"
            onClick={onNewDocument}
            aria-label="New document"
            title="New document"
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/50 bg-white/40 text-text-muted shadow-glass-sm backdrop-blur-md transition-all duration-200 hover:-translate-y-px hover:bg-white/60 hover:text-accent active:translate-y-0 active:scale-[0.98]"
          >
            <Plus size={15} />
          </button>
        )}

        {(onImportDocument || onImportFile) && (
          <button
            type="button"
            onClick={() => onImportDocument ? onImportDocument() : fileInputRef.current?.click()}
            disabled={isImportingDocument}
            aria-label="Import document"
            title="Import EPUB, PDF, text, Office, or image documents"
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

        {onImportUrl && (
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setUrlImportOpen((open) => !open);
                setUrlImportError(null);
              }}
              aria-label="Import from URL"
              aria-expanded={urlImportOpen}
              title="Import article from URL"
              className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/50 bg-white/40 text-text-muted shadow-glass-sm backdrop-blur-md transition-all duration-200 hover:-translate-y-px hover:bg-white/60 hover:text-accent active:translate-y-0 active:scale-[0.98]"
            >
              <Link2 size={15} />
            </button>
            {urlImportOpen && (
              <div className="glass-pop absolute top-full right-0 z-50 mt-2 w-[min(25rem,calc(100vw-1.5rem))] rounded-2xl p-4">
                <label className="block text-xs font-semibold uppercase tracking-widest text-text-muted">
                  Article URL
                  <input
                    type="url"
                    value={urlInput}
                    onChange={(event) => setUrlInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void handleUrlImport();
                    }}
                    placeholder="https://example.com/article"
                    autoFocus
                    className="mt-2 w-full rounded-xl border border-white/55 bg-white/45 px-3 py-2.5 text-sm normal-case tracking-normal text-text-primary outline-none placeholder:text-text-muted focus:border-accent/40"
                  />
                </label>
                {urlImportError && <p className="mt-2 text-xs leading-5 text-danger">{urlImportError}</p>}
                <p className="mt-2 text-xs leading-5 text-text-muted">
                  Article text and headings are extracted locally after download.
                </p>
                <button
                  type="button"
                  disabled={!urlInput.trim() || urlImportBusy}
                  onClick={() => void handleUrlImport()}
                  className="glass-accent mt-3 flex w-full items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-semibold text-white transition-transform active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {urlImportBusy ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />}
                  {urlImportBusy ? "Importing article…" : "Import article"}
                </button>
              </div>
            )}
          </div>
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
            <span className="hidden font-medium sm:inline">{activeVoiceLabel}</span>
            <span className="hidden text-xs text-text-muted md:inline">{activeModelLabel}</span>
            <SlidersHorizontal size={13} className="text-text-muted sm:hidden" />
            <ChevronDown
              size={13}
              className={`hidden text-text-muted transition-transform duration-200 sm:block ${settingsOpen ? "rotate-180" : ""}`}
            />
          </button>

          {settingsOpen && (
            <div className="glass-pop animate-scale-in absolute top-full right-0 z-50 mt-2 max-h-[min(42rem,calc(100vh-8rem))] w-[min(28rem,calc(100vw-2rem))] origin-top-right overflow-y-auto rounded-2xl p-4">
              <div className="flex flex-col gap-4">
                <ModelToggle
                  activeModel={activeModel}
                  onModelChange={onModelChange}
                  desktopModelOptions={desktopModelOptions}
                  kokoroState={kokoroState}
                  supertonicState={supertonicState}
                  unavailableModels={unavailableModels}
                />

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

      {selectedDesktopModel && modelError && (
        <div className="flex flex-col gap-3 rounded-2xl border border-danger/20 bg-danger/[0.06] px-4 py-3 sm:flex-row sm:items-center sm:justify-between" role="status">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-text-primary">Qwen needs setup in Reader</p>
            <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-text-secondary">{modelError}</p>
          </div>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="shrink-0 rounded-xl border border-white/60 bg-white/50 px-3 py-2 text-sm font-semibold text-text-primary shadow-glass-sm transition-all hover:bg-white/70 active:scale-[0.98]"
          >
            Open Qwen settings
          </button>
        </div>
      )}

      {(libraryError || currentChapter) && (
        <div className="flex flex-col gap-2 px-1 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            {libraryError ? (
              <p className="text-xs text-danger" role="status">{libraryError}</p>
            ) : currentChapter ? (
              <button
                type="button"
                onClick={() => setLibraryOpen(true)}
                className="truncate text-left text-xs font-medium text-text-muted transition-colors hover:text-accent"
              >
                Chapter {currentChapter.order + 1} of {activeDocument?.chapters.length}: {currentChapter.title}
              </button>
            ) : null}
          </div>
          <div className="flex min-w-32 items-center gap-2 sm:w-56">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
              <div
                className="h-full rounded-full bg-accent transition-[transform] duration-300 origin-left"
                style={{ transform: `scaleX(${clamp(readingProgress / 100, 0, 1)})` }}
              />
            </div>
            <span className="w-9 text-right font-mono text-2xs text-text-muted tabular-nums">
              {Math.round(readingProgress)}%
            </span>
          </div>
        </div>
      )}

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
              const wordClass = part.isWordActive ? "reader-word-highlight-active" : "";
              const tintClass = part.sectionIndex >= 0
                ? part.sectionIndex % 2 === 0
                  ? "reader-section-even"
                  : "reader-section-odd"
                : "";
              const className = `${tintClass} ${activeClass} ${wordClass}`.trim();

              return (
                <span
                  key={`part-${index}`}
                  className={className || undefined}
                  data-reader-active-word={part.isWordActive ? "true" : undefined}
                >
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
