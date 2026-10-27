import {
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Check, Maximize2, Minimize2, Pencil } from "lucide-react";
import { MIN_TEXT_LENGTH } from "../constants";
import type { AudioSegment } from "../hooks/useAudioPlayer";
import { chunkTextForModelDetailed } from "../lib/chunking";
import type { PlaybackClock } from "../lib/playbackClock";
import { browserEnginePreviewChunks, browserEngineVoiceLabel, getEngine } from "../models/registry";
import { buildQwen3RequestSections, buildQwen3TextUnits } from "../lib/qwenChunking";
import {
  isReaderHighlightAnchored,
  type ReaderChapter,
  type ReaderDocumentRecord,
  type ReaderHighlightColor,
  type ReaderHighlightInput,
  type ReaderSection,
} from "../lib/readerDocument";
import {
  DEFAULT_READER_VIEW_PREFERENCES,
  readerColumnWidthRem,
  type ReaderViewPreferences,
} from "../lib/readerPreferences";
import { getMeaningfulTextLength } from "../lib/textValidation";
import type { GenerationStats, ModelState, ModelType } from "../types";
import type { AudiobookExport } from "../hooks/useAudiobookExport";
import { ReaderLibrarySidebar, type ReaderSidebarTab } from "./ReaderLibrarySidebar";
import { ReaderAppearanceMenu } from "./reader/ReaderAppearanceMenu";
import { ReaderChapterRail } from "./reader/ReaderChapterRail";
import { ReaderDesktopModelAlert } from "./reader/ReaderDesktopModelAlert";
import { ReaderExportMenu } from "./reader/ReaderExportMenu";
import { ReaderImportMenu } from "./reader/ReaderImportMenu";
import { ReaderPlayerDock } from "./reader/ReaderPlayerDock";
import type { SelectedPassage } from "./reader/ReaderSelectionToolbar";
import { ReaderShortcutsDialog } from "./reader/ReaderShortcutsDialog";
import { ReaderTextPane, type SectionHighlight } from "./reader/ReaderTextPane";
import { ReaderToolbar } from "./reader/ReaderToolbar";
import { ReaderVoiceMenu, type ReaderDesktopModelOption } from "./reader/ReaderVoiceMenu";
import { chapterStepLabel, contentsButtonLabel } from "./reader/readerLabels";
import {
  offsetAtTime,
  paragraphStarts,
  sentenceStarts,
  stepBoundary,
  timeAtOffset,
  type ReaderStepDirection,
  type ReaderStepUnit,
} from "./reader/readerNavigation";
import { findSegmentForTextOffset } from "./reader/readerSegments";
import { TOOL_BUTTON } from "./reader/readerStyles";
import { chapterHeadingBlockStart, clamp, splitTextBlocks } from "./reader/readerTextLayout";
import { useDockClearance } from "./reader/useDockClearance";
import { useReaderAutoFollow } from "./reader/useReaderAutoFollow";
import { useReaderKeyboard } from "./reader/useReaderKeyboard";
import { useReaderSectionEditor } from "./reader/useReaderSectionEditor";
import { useReaderSleepTimer } from "./reader/useReaderSleepTimer";
import { useStableCallback } from "./reader/useStableCallback";

interface AdvancedReaderPageProps {
  fullScreen?: boolean;
  text: string;
  onTextChange: (text: string) => void;
  onEditStart?: () => void;
  onEditEnd?: () => void;
  /** Desktop-only document import (PDF/DOCX/images via LiteParse); absent on web builds. */
  onImportDocument?: () => void;
  isImportingDocument?: boolean;
  onImportFile?: (file: File) => Promise<void> | void;
  onImportUrl?: (url: string) => Promise<void> | void;
  documents?: ReaderDocumentRecord[];
  activeDocument?: ReaderDocumentRecord | null;
  activeChapter?: ReaderChapter | null;
  activeSection?: ReaderSection | null;
  previousSection?: ReaderSection | null;
  nextSection?: ReaderSection | null;
  /** Whether the next part's audio is being prepared in the background, or is ready. */
  nextPartStatus?: "preparing" | "ready" | null;
  /** Exports the open book as an audiobook; the control is left out without it. */
  audiobook?: AudiobookExport;
  onNavigateToOffset?: (offset: number, positionSec?: number) => void;
  viewPreferences?: ReaderViewPreferences;
  onViewPreferencesChange?: (patch: Partial<ReaderViewPreferences>) => void;
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
  /**
   * Saves a highlight over the document range `[start, end)`; see
   * `createReaderHighlight`. The highlight controls are hidden without it.
   */
  onAddHighlight?: (input: ReaderHighlightInput) => void;
  /** Recolours a saved highlight. */
  onUpdateHighlight?: (id: string, patch: { color: ReaderHighlightColor }) => void;
  onRemoveHighlight?: (id: string) => void;
  activeModel: ModelType;
  onModelChange: (model: ModelType) => void;
  desktopModelOptions?: ReaderDesktopModelOption[];
  desktopQwenMode?: "customVoice" | "voiceClone" | "voiceDesign";
  /** False while a streaming model is still extending semantic segment durations. */
  estimatedWordTrackingStable?: boolean;
  desktopVoiceLabel?: string;
  desktopModelSettings?: ReactNode;
  kokoroState: ModelState;
  supertonicState: ModelState;
  /** The load state of the other browser engines (Kitten, Paradee, Piper). */
  modelStates?: Partial<Record<ModelType, ModelState>>;
  visibleModels?: readonly ModelType[];
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
  clock: PlaybackClock;
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
  /** Last generation failure; shown in the dock so a failed run never reads as "Ready". */
  generationError?: string | null;
  /** Focus layout hides the app header and page tabs above the Reader. */
  immersive?: boolean;
  onImmersiveChange?: (immersive: boolean) => void;
  /**
   * Called with `true` while the sleep timer forbids starting the next section
   * ("End of chapter" on a chapter's last section, or a timer that ran out as
   * the section ended) and with `false` once that no longer applies. While
   * held, auto-continuation must not start the next section: turn the page
   * without auto-play or auto-generation instead. Leaving the section releases
   * the hold, so a held page turn cannot start the following chapter.
   */
  onAutoAdvanceHoldChange?: (held: boolean) => void;
}

const BOOKMARK_LABEL_LIMIT = 40;
const NO_SECTION_HIGHLIGHTS: readonly SectionHighlight[] = [];

/**
 * The Reader page: a composition root that owns the cross-cutting session
 * state (library drawer, selection, pending jump, editor, sleep timer) and
 * hands each region of the page only what it renders.
 */
export function AdvancedReaderPage({
  fullScreen = false,
  text,
  onTextChange,
  onEditStart,
  onEditEnd,
  onImportDocument,
  isImportingDocument = false,
  onImportFile,
  onImportUrl,
  documents = [],
  activeDocument = null,
  activeChapter = null,
  activeSection = null,
  previousSection = null,
  nextSection = null,
  nextPartStatus = null,
  audiobook,
  onNavigateToOffset,
  viewPreferences = DEFAULT_READER_VIEW_PREFERENCES,
  onViewPreferencesChange,
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
  onAddHighlight,
  onUpdateHighlight,
  onRemoveHighlight,
  activeModel,
  onModelChange,
  desktopModelOptions = [],
  desktopQwenMode = "customVoice",
  estimatedWordTrackingStable = true,
  desktopVoiceLabel,
  desktopModelSettings,
  kokoroState,
  supertonicState,
  modelStates,
  visibleModels,
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
  clock,
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
  generationError = null,
  immersive = false,
  onImmersiveChange,
  onAutoAdvanceHoldChange,
}: AdvancedReaderPageProps) {
  const readingTextId = useId();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const dockHostRef = useRef<HTMLDivElement>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryTab, setLibraryTab] = useState<ReaderSidebarTab>("library");
  const [voiceMenuOpen, setVoiceMenuOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  /* ── Runtime labels ───────────────────────────────────────── */
  const selectedDesktopModel = desktopModelOptions.find((option) => option.selected);
  const browserModelState: ModelState = modelStates?.[activeModel]
    ?? (activeModel === "supertonic" ? supertonicState : kokoroState);
  const activeModelState = selectedDesktopModel
    ? { ready: modelReady, error: modelError }
    : browserModelState;
  const activeModelLabel = selectedDesktopModel?.label ?? getEngine(activeModel).label;
  const activeVoiceLabel = selectedDesktopModel
    ? desktopVoiceLabel ?? selectedDesktopModel.label
    : browserEngineVoiceLabel(activeModel, voice);

  /* ── View state ───────────────────────────────────────────── */
  // Transient view state — a jump target that playback has not reached yet
  // and the passage under the selection toolbar — belongs to what the pane
  // shows. Tagging it with this scope makes it lapse on a document, section or
  // text change by derivation, instead of an effect clearing it a frame late.
  const activeDocumentId = activeDocument?.id ?? null;
  const sectionStart = activeSection?.start ?? 0;
  const viewScope = `${activeDocumentId ?? ""}\u0000${activeSection?.id ?? ""}\u0000${sectionStart}\u0000${text.length}`;
  const [navigation, setNavigation] = useState<{ scope: string; textOffset: number } | null>(null);
  const navigationTextOffset = navigation?.scope === viewScope ? navigation.textOffset : null;
  const [selection, setSelection] = useState<(SelectedPassage & { scope: string }) | null>(null);
  const selectedPassage = selection?.scope === viewScope ? selection : null;
  const selectPassage = useCallback((passage: SelectedPassage | null) => {
    setSelection(passage ? { ...passage, scope: viewScope } : null);
  }, [viewScope]);

  const editor = useReaderSectionEditor({
    documentId: activeDocumentId,
    text,
    onTextChange,
    onEditStart,
    onEditEnd,
  });
  const { editing, finishEditing, startEditing: openEditor } = editor;
  const startEditing = useCallback(() => {
    // The selection lives in the rendered article, which the editor replaces.
    setSelection(null);
    openEditor();
  }, [openEditor]);

  const hasAudio = totalDuration > 0;
  const autoFollow = useReaderAutoFollow({
    scope: viewScope,
    documentId: activeDocumentId,
    sectionId: activeSection?.id ?? null,
    sectionStart: activeSection ? activeSection.start : null,
    editing,
    isPlaying,
    hasAudio,
    scrollerRef,
    articleRef,
    textareaRef,
  });
  const { release: releaseFollow, scrollAfterSectionChange, scrollToLocalOffset } = autoFollow;

  /* ── Text and playback position ───────────────────────────── */
  const runtimeBackend = browserModelState.backend;
  const previewChunks = useMemo(
    () => selectedDesktopModel?.key === "qwen3"
      ? desktopQwenMode === "voiceClone"
        ? buildQwen3RequestSections(text)
        : buildQwen3TextUnits(text)
      : selectedDesktopModel?.key === "supertonic3"
      ? chunkTextForModelDetailed(text, "supertonic", { runtime: { backend: runtimeBackend, quality } })
      : browserEnginePreviewChunks(activeModel, text, { backend: runtimeBackend, quality }),
    [activeModel, desktopQwenMode, quality, runtimeBackend, selectedDesktopModel?.key, text],
  );
  const textBlocks = useMemo(() => splitTextBlocks(text), [text]);

  const activeSegmentIndex = segments.findIndex((segment) => segment.id === activeSegmentId);
  const activeSegment = activeSegmentIndex >= 0 ? segments[activeSegmentIndex] : null;
  const segmentHasRange = activeSegment !== null
    && typeof activeSegment.textStart === "number"
    && typeof activeSegment.textEnd === "number";
  // A segment without text offsets falls back to the preview chunk at its index.
  const fallbackRange = activeSegmentIndex >= 0 ? previewChunks[activeSegmentIndex] : undefined;
  const activeRangeStart = segmentHasRange ? activeSegment.textStart : fallbackRange?.start;
  const activeRangeEnd = segmentHasRange ? activeSegment.textEnd : fallbackRange?.end;
  // Keyed on the offsets so the pane's memoised spans survive re-renders that
  // leave the spoken passage where it was.
  const activeRange = useMemo(
    () => (activeRangeStart === undefined || activeRangeEnd === undefined
      ? null
      : { start: activeRangeStart, end: activeRangeEnd }),
    [activeRangeEnd, activeRangeStart],
  );

  const charsRemaining = MIN_TEXT_LENGTH - getMeaningfulTextLength(text);
  const persistedLocalOffset = clamp(
    (activeDocument?.progress.textOffset ?? sectionStart) - sectionStart,
    0,
    text.length,
  );
  // Passage-level on purpose: only the reading pane follows the spoken word,
  // so the rest of the page does not re-render several times a second.
  const currentLocalTextOffset = activeRange?.start
    ?? (navigationTextOffset === null ? null : navigationTextOffset - sectionStart)
    ?? persistedLocalOffset;
  const currentTextOffset = sectionStart + clamp(currentLocalTextOffset, 0, text.length);
  const readingProgress = activeDocument && activeDocument.text.length > 0
    ? (currentTextOffset / activeDocument.text.length) * 100
    : text.length > 0 ? (currentLocalTextOffset / text.length) * 100 : 0;

  /* ── Chapter ──────────────────────────────────────────────── */
  const chapters = activeDocument?.chapters;
  const currentChapter = activeChapter ?? chapters?.find(
    (chapter) => currentTextOffset >= chapter.start && currentTextOffset < chapter.end,
  ) ?? chapters?.at(-1) ?? null;
  const partCount = activeSection?.chapterSectionCount ?? 1;
  const partIndex = activeSection?.chapterSectionIndex ?? 0;
  const isChapterStart = partIndex === 0;
  // Imported chapters usually open with their own title line, drawn as the
  // heading instead of a second copy above it. A plain document's only
  // "chapter" is named after the book, which the toolbar already shows, so it
  // gets no chapter heading at all.
  const showChapterHeading = currentChapter !== null && (
    (chapters?.length ?? 0) > 1 || currentChapter.title !== activeDocument?.title
  );
  const headingBlockStart = showChapterHeading && currentChapter && isChapterStart
    ? chapterHeadingBlockStart(text, textBlocks[0], currentChapter.title)
    : null;
  const chapterHeadingTitle = showChapterHeading && headingBlockStart === null ? currentChapter?.title : undefined;
  const chapterHeading = useMemo(
    () => (chapterHeadingTitle === undefined ? null : { title: chapterHeadingTitle, continued: !isChapterStart }),
    [chapterHeadingTitle, isChapterStart],
  );

  /* ── Navigation ───────────────────────────────────────────── */
  const handleJumpToOffset = useCallback((offset: number, positionSec?: number) => {
    finishEditing();
    releaseFollow();
    const documentLength = activeDocument?.text.length ?? sectionStart + text.length;
    const targetOffset = clamp(offset, 0, documentLength);
    setNavigation({ scope: viewScope, textOffset: targetOffset });
    onNavigateToOffset?.(targetOffset, positionSec);

    const sectionEnd = activeSection?.end ?? sectionStart + text.length;
    const isDocumentEnd = sectionEnd === documentLength && targetOffset === documentLength;
    const isCurrentSection = targetOffset >= sectionStart
      && (targetOffset < sectionEnd || isDocumentEnd);
    // Parking the offset only pays off if the section is actually going to
    // change; without a navigation handler nothing consumes it and it would
    // hijack the next unrelated section change instead.
    if (!isCurrentSection && onNavigateToOffset) {
      scrollAfterSectionChange(targetOffset);
      return;
    }
    const localOffset = clamp(targetOffset - sectionStart, 0, text.length);
    // Listening starts at the word itself, not at the start of the passage
    // the model generated it in.
    const targetSec = typeof positionSec === "number"
      ? positionSec
      : timeAtOffset(segments, localOffset, estimatedWordTrackingStable);
    if (targetSec !== null && totalDuration > 0) {
      onSeek(clamp(targetSec / totalDuration, 0, 1));
    } else {
      const targetSegment = findSegmentForTextOffset(segments, localOffset);
      if (targetSegment) onJumpToSegment(targetSegment.id);
    }
    scrollToLocalOffset(localOffset);
  }, [
    activeDocument?.text.length,
    activeSection?.end,
    estimatedWordTrackingStable,
    finishEditing,
    onJumpToSegment,
    onNavigateToOffset,
    onSeek,
    releaseFollow,
    scrollAfterSectionChange,
    scrollToLocalOffset,
    sectionStart,
    segments,
    text.length,
    totalDuration,
    viewScope,
  ]);

  const handleEditorSeek = useCallback((localOffset: number) => {
    const targetSegment = findSegmentForTextOffset(segments, localOffset);
    if (targetSegment) onJumpToSegment(targetSegment.id);
  }, [onJumpToSegment, segments]);

  // Sentence and paragraph steps start from the spoken word (read from the
  // clock when the step is taken, not subscribed to) or, without audio, from
  // where the reader last navigated. A step past the section's edge turns the
  // page like the arrow keys do.
  const documentLanguage = activeDocument?.language;
  const stepReading = useStableCallback((unit: ReaderStepUnit, direction: ReaderStepDirection) => {
    const nowSec = clock.getTime();
    const spokenOffset = hasAudio ? offsetAtTime(segments, nowSec, estimatedWordTrackingStable) : null;
    const currentOffset = clamp(spokenOffset ?? currentLocalTextOffset, 0, text.length);
    const boundaries = unit === "sentence"
      ? sentenceStarts(text, textBlocks, documentLanguage)
      : paragraphStarts(text, textBlocks);
    let target = stepBoundary(boundaries, currentOffset, direction);
    if (target !== null && direction === "next" && hasAudio && !estimatedWordTrackingStable) {
      // Without word timing a step seeks to its passage's start, which may be
      // behind the voice; step to the next passage instead of going back.
      const landingSec = timeAtOffset(segments, target, false);
      if (landingSec !== null && landingSec <= nowSec) {
        const nextPassage = segments.find((segment) => (
          segment.startSec > nowSec && typeof segment.textStart === "number"
        ));
        target = nextPassage?.textStart ?? null;
      }
    }
    if (target !== null) {
      handleJumpToOffset(sectionStart + target);
      return;
    }
    const section = direction === "next" ? nextSection : previousSection;
    if (section) handleJumpToOffset(section.start);
  });

  const goToPreviousSection = useMemo(
    () => (previousSection ? () => handleJumpToOffset(previousSection.start) : undefined),
    [handleJumpToOffset, previousSection],
  );
  const goToNextSection = useMemo(
    () => (nextSection ? () => handleJumpToOffset(nextSection.start) : undefined),
    [handleJumpToOffset, nextSection],
  );

  /* ── Library drawer ───────────────────────────────────────── */
  const openLibrary = useCallback(() => setLibraryOpen(true), []);
  const closeLibrary = useCallback(() => setLibraryOpen(false), []);
  const openContents = useCallback(() => {
    setLibraryTab("contents");
    setLibraryOpen(true);
  }, []);
  const openNotes = useCallback(() => {
    setLibraryTab("notes");
    setLibraryOpen(true);
  }, []);
  // Switching books from the drawer commits the draft into the book it was
  // typed in first, while that book is still the active one.
  const handleOpenDocument = useStableCallback((id: string) => {
    if (id !== activeDocumentId) finishEditing();
    onOpenDocument?.(id);
  });
  const handleNewDocument = useStableCallback(() => {
    finishEditing();
    onNewDocument?.();
  });
  const handleDeleteDocument = useStableCallback((id: string) => {
    if (id === activeDocumentId) finishEditing();
    onDeleteDocument?.(id);
  });
  const handleUpdateMetadata = useStableCallback(
    (patch: Pick<Partial<ReaderDocumentRecord>, "title" | "author">) => onUpdateDocumentMetadata?.(patch),
  );
  const handleAddBookmark = useStableCallback(
    (input: { label: string; textOffset: number; positionSec: number }) => onAddBookmark?.(input),
  );
  const handleRemoveBookmark = useStableCallback((id: string) => onRemoveBookmark?.(id));
  const handleAddNote = useStableCallback(
    (input: { text: string; quote: string; textOffset: number }) => onAddNote?.(input),
  );
  const handleUpdateNote = useStableCallback((id: string, value: string) => onUpdateNote?.(id, value));
  const handleRemoveNote = useStableCallback((id: string) => onRemoveNote?.(id));

  const handleBookmarkPassage = useCallback((passage: SelectedPassage) => {
    onAddBookmark?.({
      label: passage.quote.length > BOOKMARK_LABEL_LIMIT
        ? `${passage.quote.slice(0, BOOKMARK_LABEL_LIMIT).trimEnd()}…`
        : passage.quote,
      textOffset: passage.textOffset,
      positionSec: findSegmentForTextOffset(segments, passage.textOffset - sectionStart)?.startSec ?? 0,
    });
  }, [onAddBookmark, sectionStart, segments]);

  /* ── Highlights ───────────────────────────────────────────── */
  const documentText = activeDocument?.text;
  const documentHighlights = activeDocument?.highlights;
  // Only a highlight whose words still sit where it says marks the page; one
  // left behind by an edit waits for the library to find its words again.
  const sectionHighlights = useMemo(() => {
    if (!documentHighlights?.length || documentText === undefined) return NO_SECTION_HIGHLIGHTS;
    const sectionEnd = sectionStart + text.length;
    return documentHighlights
      .filter((highlight) => (
        highlight.start < sectionEnd
        && highlight.end > sectionStart
        && isReaderHighlightAnchored(documentText, highlight)
      ))
      .map((highlight) => ({
        id: highlight.id,
        color: highlight.color,
        start: Math.max(0, highlight.start - sectionStart),
        end: Math.min(text.length, highlight.end - sectionStart),
      }));
  }, [documentHighlights, documentText, sectionStart, text.length]);
  const handleHighlightPassage = useStableCallback((
    passage: SelectedPassage,
    color: ReaderHighlightColor,
    highlightId?: string,
  ) => {
    if (highlightId && onUpdateHighlight) onUpdateHighlight(highlightId, { color });
    else onAddHighlight?.({ start: passage.textOffset, end: passage.endOffset, color });
  });
  const handleUpdateHighlight = useStableCallback(
    (id: string, patch: { color: ReaderHighlightColor }) => onUpdateHighlight?.(id, patch),
  );
  const handleRemoveHighlight = useStableCallback((id: string) => onRemoveHighlight?.(id));
  const handleExportChapter = useStableCallback((chapterId: string) => {
    audiobook?.start({ kind: "chapter", chapterId }, "mp3");
    closeLibrary();
  });

  /* ── Sleep timer and keyboard ─────────────────────────────── */
  const sleepTimer = useReaderSleepTimer({
    sectionKey: `${activeDocumentId ?? ""}\u0000${activeSection?.id ?? ""}`,
    atChapterEnd: !nextSection || nextSection.chapterId !== activeSection?.chapterId,
    hasNextSection: nextSection !== null,
    clock,
    totalDuration,
    isPlaying,
    isGenerating,
    onPause: onTogglePlay,
    onStopGeneration: onStop,
    onHoldChange: onAutoAdvanceHoldChange,
  });
  const { start: startSleepTimer } = sleepTimer;
  const cancelSleepTimer = useCallback(() => startSleepTimer("off"), [startSleepTimer]);

  const toggleShortcuts = useCallback(() => setShortcutsOpen((open) => !open), []);
  const showShortcuts = useCallback(() => setShortcutsOpen(true), []);
  useReaderKeyboard({
    editing,
    scrollerRef,
    previousSection,
    nextSection,
    onJumpToOffset: handleJumpToOffset,
    onStep: stepReading,
    onToggleShortcuts: toggleShortcuts,
    immersive,
    onImmersiveChange,
  });

  // The parent passes these as inline arrows; a stable identity keeps the
  // memoised dock from re-rendering with every parent render.
  const skipBackward = useStableCallback(onSkipBackward);
  const skipForward = useStableCallback(onSkipForward);

  // The full-screen dock floats over the reading pane; overlays in the pane
  // read its height to stay clear of it.
  useDockClearance(pageRef, dockHostRef, fullScreen);

  return (
    // On wide windows the open library pushes the page aside instead of
    // covering the text column, so the reader keeps their place in view.
    <div ref={pageRef} className={`relative flex w-full flex-col gap-3 transition-[padding] duration-300 sm:gap-4 ${
      libraryOpen ? "lg:pl-[23rem]" : ""
    } ${fullScreen ? immersive ? "min-h-[calc(100vh-2.5rem)]" : "min-h-[calc(100vh-9.5rem)]" : "mt-6"}`}>

      <ReaderLibrarySidebar
        open={libraryOpen}
        documents={documents}
        activeDocument={activeDocument}
        currentTextOffset={currentTextOffset}
        clock={clock}
        loading={libraryLoading}
        persistent={libraryPersistent}
        onClose={closeLibrary}
        onOpenDocument={handleOpenDocument}
        onNewDocument={handleNewDocument}
        onDeleteDocument={handleDeleteDocument}
        onUpdateMetadata={handleUpdateMetadata}
        onJumpToOffset={handleJumpToOffset}
        onAddBookmark={handleAddBookmark}
        onRemoveBookmark={handleRemoveBookmark}
        onAddNote={handleAddNote}
        onUpdateNote={handleUpdateNote}
        onRemoveNote={handleRemoveNote}
        onUpdateHighlight={onUpdateHighlight ? handleUpdateHighlight : undefined}
        onRemoveHighlight={onRemoveHighlight ? handleRemoveHighlight : undefined}
        onExportChapter={audiobook ? handleExportChapter : undefined}
        selectedPassage={selectedPassage}
        tab={libraryTab}
        onTabChange={setLibraryTab}
      />

      <ReaderToolbar
        title={activeDocument?.title || "Reader"}
        subtitle={activeDocument
          ? activeDocument.author
            || (activeDocument.chapters.length > 1 ? `${activeDocument.chapters.length} chapters` : "Reading")
          : "No book open"}
        documentCount={documents.length}
        onOpenLibrary={openLibrary}
        voiceMenu={(
          <ReaderVoiceMenu
            open={voiceMenuOpen}
            onOpenChange={setVoiceMenuOpen}
            modelState={activeModelState}
            voiceLabel={activeVoiceLabel}
            modelLabel={activeModelLabel}
            activeModel={activeModel}
            onModelChange={onModelChange}
            desktopModelOptions={desktopModelOptions}
            selectedDesktopModel={selectedDesktopModel}
            desktopModelSettings={desktopModelSettings}
            kokoroState={kokoroState}
            supertonicState={supertonicState}
            modelStates={modelStates}
            browserModelState={browserModelState}
            visibleModels={visibleModels}
            unavailableModels={unavailableModels}
            kokoroVoices={kokoroVoices}
            voice={voice}
            onVoiceChange={onVoiceChange}
            quality={quality}
            onQualityChange={onQualityChange}
          />
        )}
      >
        <ReaderAppearanceMenu
          viewPreferences={viewPreferences}
          onViewPreferencesChange={onViewPreferencesChange}
          sleepTimerChoice={sleepTimer.choice}
          onSleepTimerChange={startSleepTimer}
          onShowShortcuts={showShortcuts}
        />
        {audiobook && activeDocument && (
          <ReaderExportMenu
            audiobook={audiobook}
            chapterId={currentChapter?.id ?? null}
            chapterTitle={currentChapter?.title ?? null}
            chapterCount={activeDocument.chapters.length}
          />
        )}
        <button
          type="button"
          onClick={editing ? finishEditing : startEditing}
          aria-label={editing ? "Finish editing section" : "Edit current section"}
          title={editing ? "Finish editing" : "Edit current section"}
          className={editing
            ? `${TOOL_BUTTON} bg-accent-light text-accent hover:bg-accent-light hover:text-accent`
            : TOOL_BUTTON}
        >
          {editing ? <Check size={16} /> : <Pencil size={15} />}
        </button>
        {(onImportDocument || onImportFile || onImportUrl) && (
          <ReaderImportMenu
            onImportDocument={onImportDocument}
            onImportFile={onImportFile}
            onImportUrl={onImportUrl}
            isImportingDocument={isImportingDocument}
            onArticleImported={openLibrary}
          />
        )}
        {onImmersiveChange && (
          <button
            type="button"
            onClick={() => onImmersiveChange(!immersive)}
            aria-label={immersive ? "Exit focus layout" : "Focus layout"}
            aria-pressed={immersive}
            title={immersive ? "Show app header (F)" : "Hide app header (F)"}
            // Hidden on phones to save room, except when it is the only way
            // back out of the focus layout.
            className={`${immersive ? "" : "max-sm:hidden"} ${TOOL_BUTTON}`}
          >
            {immersive ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
        )}
      </ReaderToolbar>

      {selectedDesktopModel && modelError && (
        <ReaderDesktopModelAlert
          title={selectedDesktopModel.key === "qwen3"
            ? `${activeModelLabel} needs setup in Reader`
            : `${activeModelLabel} is unavailable`}
          message={modelError}
          actionLabel={selectedDesktopModel.key === "qwen3" ? "Open Qwen settings" : "Retry"}
          onAction={selectedDesktopModel.key === "qwen3" ? () => setVoiceMenuOpen(true) : onRetryLoad}
        />
      )}

      {libraryError && (
        <p className="px-1 text-xs text-danger" role="status">{libraryError}</p>
      )}

      {audiobook?.state.status === "failed" && audiobook.state.error && (
        <p className="px-1 text-xs text-danger" role="status">
          Audiobook export failed: {audiobook.state.error} Open Export audiobook to try again.
        </p>
      )}

      <section
        className={`surface reader-tone-${viewPreferences.tone} relative flex flex-col overflow-hidden rounded-[28px] ${fullScreen ? "flex-1" : ""}`}
        style={{
          "--reader-column-width": `${readerColumnWidthRem(viewPreferences.columnWidth)}rem`,
        } as CSSProperties}
      >
        {currentChapter && (
          <ReaderChapterRail
            previousLabel={chapterStepLabel(previousSection, false, currentChapter.id, chapters ?? [])}
            nextLabel={chapterStepLabel(nextSection, true, currentChapter.id, chapters ?? [])}
            onPrevious={goToPreviousSection}
            onNext={goToNextSection}
            // A one-chapter document would just repeat the book title from
            // the header, so the rail names the destination instead.
            title={(chapters?.length ?? 0) > 1 ? currentChapter.title : "Contents"}
            contentsLabel={contentsButtonLabel(currentChapter, chapters?.length ?? 1, partIndex, partCount)}
            onOpenContents={openContents}
            partIndex={partIndex}
            partCount={partCount}
            readingProgress={readingProgress}
            clock={clock}
            totalDuration={totalDuration}
            sleepTimerLabel={sleepTimer.label}
            onCancelSleepTimer={cancelSleepTimer}
            nextPartStatus={nextPartStatus}
          />
        )}

        <ReaderTextPane
          readingTextId={readingTextId}
          fullScreen={fullScreen}
          fontSize={viewPreferences.fontSize}
          lineHeight={viewPreferences.lineHeight}
          focusMode={viewPreferences.focusMode && isPlaying && activeRange !== null}
          text={text}
          blocks={textBlocks}
          activeRange={activeRange}
          highlights={sectionHighlights}
          sectionStart={sectionStart}
          language={documentLanguage}
          chapterHeading={chapterHeading}
          headingBlockStart={headingBlockStart}
          clock={clock}
          activeSegment={activeSegment}
          estimatedWordTrackingStable={estimatedWordTrackingStable}
          isPlaying={isPlaying}
          editing={editing}
          draft={editor.draft}
          onDraftChange={editor.changeDraft}
          onDraftCommit={editor.commitDraft}
          onEditorSeek={handleEditorSeek}
          onStartEditing={startEditing}
          scrollerRef={scrollerRef}
          articleRef={articleRef}
          textareaRef={textareaRef}
          followPaused={autoFollow.followPaused}
          onScroll={autoFollow.handleScroll}
          onResumeFollow={autoFollow.resume}
          scrollMarkerIntoView={autoFollow.scrollMarkerIntoView}
          selectedPassage={selectedPassage}
          onSelectPassage={selectPassage}
          onListenFrom={handleJumpToOffset}
          onBookmarkPassage={onAddBookmark ? handleBookmarkPassage : undefined}
          onNotePassage={openNotes}
          onHighlightPassage={onAddHighlight ? handleHighlightPassage : undefined}
          onRemoveHighlight={onRemoveHighlight ? handleRemoveHighlight : undefined}
        />
      </section>

      {shortcutsOpen && (
        <ReaderShortcutsDialog onClose={() => setShortcutsOpen(false)} />
      )}

      {/* `contents` keeps the dock in the page's flow (or fixed to the
          viewport) exactly as before; the wrapper only lets the page find the
          dock to measure it. */}
      <div ref={dockHostRef} className="contents">
        <ReaderPlayerDock
          fullScreen={fullScreen}
          tone={viewPreferences.tone}
          isPlaying={isPlaying}
          clock={clock}
          totalDuration={totalDuration}
          segments={segments}
          activeSegmentId={activeSegmentId}
          sectionPreviewCount={previewChunks.length}
          stats={stats}
          isGenerating={isGenerating}
          generationProgress={generationProgress}
          generationError={generationError}
          modelReady={modelReady}
          modelError={modelError}
          loadingProgress={loadingProgress}
          canGenerate={canGenerate}
          charsRemaining={charsRemaining}
          playbackRate={playbackRate}
          onPlaybackRateChange={onPlaybackRateChange}
          isRetaking={isRetaking}
          canRetakeSegments={canRetakeSegments}
          onRetakeSegment={onRetakeSegment}
          onJumpToSegment={onJumpToSegment}
          onGenerate={onGenerate}
          onRetryLoad={onRetryLoad}
          onTogglePlay={onTogglePlay}
          onSeek={onSeek}
          onSkipBackward={skipBackward}
          onSkipForward={skipForward}
          onDownload={onDownload}
          onStop={onStop}
          onStep={text.length > 0 ? stepReading : undefined}
        />
      </div>
    </div>
  );
}
