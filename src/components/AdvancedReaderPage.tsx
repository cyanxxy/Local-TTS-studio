import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from "react";
import {
  BookmarkPlus,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileUp,
  Keyboard,
  Library,
  Link2,
  Loader2,
  Maximize2,
  Minimize2,
  Moon,
  NotebookPen,
  Pencil,
  Play,
  SlidersHorizontal,
  Type,
  X,
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
import { buildQwen3RequestSections, buildQwen3TextUnits } from "../lib/qwenChunking";
import {
  estimateWordRanges,
  type ReaderChapter,
  type ReaderDocumentRecord,
  type ReaderSection,
} from "../lib/readerDocument";
import {
  DEFAULT_READER_VIEW_PREFERENCES,
  readerColumnWidthRem,
  type ReaderColumnWidth,
  type ReaderTone,
  type ReaderViewPreferences,
} from "../lib/readerPreferences";
import { usePlaybackSelector, type PlaybackClock } from "../lib/playbackClock";
import { AudioPlayer, type AudioPlayerPrimaryAction } from "./AudioPlayer";
import { ModelToggle } from "./ModelToggle";
import { ReaderLibrarySidebar, type ReaderSidebarTab } from "./ReaderLibrarySidebar";
import { VoiceSelector } from "./VoiceSelector";
import { ReaderParagraph } from "./reader/ReaderParagraph";
import { ReaderShortcutsDialog } from "./reader/ReaderShortcutsDialog";
import { RemainingTime } from "./reader/RemainingTime";
import { SegmentedChoice, SwitchRow } from "./reader/ReaderControls";
import { ViewportPopover } from "./reader/ViewportPopover";
import { deriveReaderDockState } from "./reader/readerDockState";
import { chapterStepLabel, contentsButtonLabel, formatVoiceName } from "./reader/readerLabels";
import { findSegmentForTextOffset } from "./reader/readerSegments";
import {
  buildOverlayParts,
  chapterHeadingBlockStart,
  clamp,
  groupPartsByBlock,
  splitTextBlocks,
} from "./reader/readerTextLayout";

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
}

interface ReaderDesktopModelOption {
  key: string;
  label: string;
  badge: string;
  detail: string;
  selected?: boolean;
  onSelect: () => void;
}

/* Shared metrics for the overlay and the transparent textarea beneath it.
   Both must be glyph-for-glyph identical, so they always use this one string. */
const DOCUMENT_TEXT_CLASSES =
  "whitespace-pre-wrap break-words font-reading";

/* Horizontal padding comes from .reader-doc-pad, which centers a readable
   text column inside the full-bleed panel at any window size. */
function documentPadding(fullScreen: boolean): string {
  return fullScreen
    ? "reader-doc-pad pt-8 pb-44 sm:pt-12 sm:pb-48"
    : "reader-doc-pad py-8";
}

/** Auto-follow leaves the page alone while the spoken word sits in this band. */
const FOLLOW_BAND_TOP = 0.12;
const FOLLOW_BAND_BOTTOM = 0.62;
/** How long scroll events after our own scroll are not treated as the user's. */
const INSTANT_SCROLL_GRACE_MS = 120;
const SMOOTH_SCROLL_GRACE_MS = 800;

function prefersReducedMotion(): boolean {
  if (document.documentElement.dataset.motion === "reduced") return true;
  return typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/* Icon buttons that live inside a glass capsule: no material of their own
   (glass never sits on glass), just a fill on hover and a give on press. A
   40px circle in a capsule with 4px padding keeps the corners concentric. */
const TOOL_BUTTON =
  "flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-text-secondary transition-[background-color,color,transform] duration-200 hover:bg-text-primary/[0.07] hover:text-text-primary active:scale-95";

const READER_TONE_OPTIONS: ReadonlyArray<{ value: ReaderTone; label: string }> = [
  { value: "paper", label: "Paper" },
  { value: "sepia", label: "Sepia" },
  { value: "night", label: "Night" },
];

const COLUMN_WIDTH_OPTIONS: ReadonlyArray<{ value: ReaderColumnWidth; label: string }> = [
  { value: "narrow", label: "narrow" },
  { value: "comfortable", label: "Standard" },
  { value: "wide", label: "wide" },
];

type SleepTimerChoice = "off" | "15" | "30" | "60" | "chapter";

const SLEEP_TIMER_OPTIONS: ReadonlyArray<{ value: SleepTimerChoice; label: string }> = [
  { value: "off", label: "Off" },
  { value: "15", label: "15m" },
  { value: "30", label: "30m" },
  { value: "60", label: "60m" },
  { value: "chapter", label: "Chapter" },
];

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
  activeModel,
  onModelChange,
  desktopModelOptions = [],
  desktopQwenMode = "customVoice",
  estimatedWordTrackingStable = true,
  desktopVoiceLabel,
  desktopModelSettings,
  kokoroState,
  supertonicState,
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
  const documentScrollerRef = useRef<HTMLDivElement>(null);
  const readerTextRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const readingTextId = useId();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(text);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryTab, setLibraryTab] = useState<ReaderSidebarTab>("library");
  const [importOpen, setImportOpen] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [urlImportError, setUrlImportError] = useState<string | null>(null);
  const [urlImportBusy, setUrlImportBusy] = useState(false);
  const [navigationTextOffset, setNavigationTextOffset] = useState<number | null>(null);
  const [selectedPassage, setSelectedPassage] = useState<{ quote: string; textOffset: number } | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [sleepTimer, setSleepTimer] = useState<{
    choice: SleepTimerChoice;
    endsAt: number | null;
    chapterId: string | null;
  }>({ choice: "off", endsAt: null, chapterId: null });
  const [sleepNow, setSleepNow] = useState(() => Date.now());
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const settingsPopoverRef = useRef<HTMLDivElement>(null);
  const appearanceButtonRef = useRef<HTMLButtonElement>(null);
  const appearancePopoverRef = useRef<HTMLDivElement>(null);
  const importButtonRef = useRef<HTMLButtonElement>(null);
  const importPopoverRef = useRef<HTMLDivElement>(null);
  const editingRef = useRef(editing);
  const editDraftRef = useRef(editDraft);
  const onEditEndRef = useRef(onEditEnd);
  const onTextChangeRef = useRef(onTextChange);
  const previousDocumentIdRef = useRef(activeDocument?.id);
  const editCommitTimerRef = useRef<number | null>(null);
  // Cross-section jumps land after the new section's text renders; this holds
  // the document-absolute offset to scroll to once that happens.
  const pendingScrollOffsetRef = useRef<number | null>(null);
  const programmaticScrollUntilRef = useRef(0);
  const [followPaused, setFollowPaused] = useState(false);
  const followPausedRef = useRef(false);

  const cancelEditCommit = useCallback(() => {
    if (editCommitTimerRef.current !== null) {
      window.clearTimeout(editCommitTimerRef.current);
      editCommitTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    editingRef.current = editing;
    editDraftRef.current = editDraft;
    onEditEndRef.current = onEditEnd;
    onTextChangeRef.current = onTextChange;
  }, [editDraft, editing, onEditEnd, onTextChange]);

  useEffect(() => {
    if (previousDocumentIdRef.current !== activeDocument?.id) {
      // A pending debounced commit belongs to the previous document; letting it
      // fire now would write stale text into the newly opened one.
      cancelEditCommit();
      if (editingRef.current) onEditEndRef.current?.();
    }
    previousDocumentIdRef.current = activeDocument?.id;
    setNavigationTextOffset(null);
    setSelectedPassage(null);
    setEditing(false);
  }, [activeDocument?.id, cancelEditCommit]);

  useEffect(() => () => {
    if (editCommitTimerRef.current !== null) {
      window.clearTimeout(editCommitTimerRef.current);
      editCommitTimerRef.current = null;
      if (editingRef.current) onTextChangeRef.current(editDraftRef.current);
    }
    if (editingRef.current) onEditEndRef.current?.();
  }, []);

  useEffect(() => {
    if (editing) return;
    setNavigationTextOffset(null);
    setSelectedPassage(null);
    setEditDraft(text);
  }, [activeSection?.id, editing, text]);

  useEffect(() => {
    followPausedRef.current = false;
    setFollowPaused(false);
  }, [activeDocument?.id, activeSection?.id]);

  /** Scroll the reading pane so the given local text offset sits in the upper third. */
  const scrollToLocalOffset = useCallback((localOffset: number) => {
    const scroller = documentScrollerRef.current;
    const root = readerTextRef.current;
    if (!scroller || !root) return;
    const paragraphs = [...root.querySelectorAll<HTMLElement>("[data-block-start]")];
    if (paragraphs.length === 0) return;
    let paragraph = paragraphs[0];
    for (const element of paragraphs) {
      if (Number(element.dataset.blockStart) > localOffset) break;
      paragraph = element;
    }

    let remaining = Math.max(0, localOffset - Number(paragraph.dataset.blockStart));
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode() as Text | null;
    while (node && remaining > node.length) {
      remaining -= node.length;
      node = walker.nextNode() as Text | null;
    }
    const range = document.createRange();
    if (node) {
      range.setStart(node, Math.min(node.length, remaining));
      range.collapse(true);
    } else {
      range.selectNodeContents(paragraph);
      range.collapse(true);
    }
    const rangeRect = typeof range.getBoundingClientRect === "function"
      ? range.getBoundingClientRect()
      : null;
    const anchorRect = rangeRect && (rangeRect.height > 0 || rangeRect.top !== 0)
      ? rangeRect
      : paragraph.getBoundingClientRect();
    const lead = Math.max(32, scroller.clientHeight * 0.28);
    const nextTop = Math.max(
      0,
      scroller.scrollTop + anchorRect.top - scroller.getBoundingClientRect().top - lead,
    );
    if (Math.abs(scroller.scrollTop - nextTop) < 1) return;
    programmaticScrollUntilRef.current = performance.now() + INSTANT_SCROLL_GRACE_MS;
    scroller.scrollTop = nextTop;
  }, []);

  useLayoutEffect(() => {
    if (editing) return;
    // A grace window opened just before this section change has nothing left to cover.
    programmaticScrollUntilRef.current = 0;
    const pending = pendingScrollOffsetRef.current;
    pendingScrollOffsetRef.current = null;
    if (pending !== null && activeSection && pending >= activeSection.start) {
      scrollToLocalOffset(pending - activeSection.start);
      return;
    }
    if (documentScrollerRef.current) documentScrollerRef.current.scrollTop = 0;
    if (textareaRef.current) textareaRef.current.scrollTop = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only on document/section change
  }, [activeDocument?.id, activeSection?.id, editing]);

  const previewChunks = useMemo(
    () => selectedDesktopModel?.key === "qwen3"
      ? desktopQwenMode === "voiceClone"
        ? buildQwen3RequestSections(text)
        : buildQwen3TextUnits(text)
      : chunkTextForModelDetailed(
          text,
          selectedDesktopModel?.key === "supertonic3" ? "supertonic" : activeModel,
          { runtime: { backend: runtimeBackend, quality } },
        ),
    [activeModel, desktopQwenMode, quality, runtimeBackend, selectedDesktopModel?.key, text],
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
    if (
      !estimatedWordTrackingStable
      || !activeSegment
      || typeof activeSegment.textStart !== "number"
    ) return [];
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
  }, [activeSegment, estimatedWordTrackingStable]);

  // Selecting an *index* rather than the position itself is what keeps this page
  // off the animation-frame path: the value only changes when the spoken word
  // changes, a few times a second, so everything below re-renders at that rate.
  const selectActiveWordIndex = useCallback(
    (timeSec: number) => estimatedWords.findIndex(
      (word) => timeSec >= word.startSec && timeSec < word.endSec,
    ),
    [estimatedWords],
  );
  const activeWordIndex = usePlaybackSelector(clock, selectActiveWordIndex);
  const activeWordRange = useMemo(() => {
    const activeWord = activeWordIndex >= 0 ? estimatedWords[activeWordIndex] : undefined;
    return activeWord ? { start: activeWord.start, end: activeWord.end } : null;
  }, [activeWordIndex, estimatedWords]);

  const textBlocks = useMemo(() => splitTextBlocks(text), [text]);

  const overlayParts = useMemo(
    () => buildOverlayParts(text, textBlocks, activeRange),
    [text, textBlocks, activeRange],
  );

  const paragraphs = useMemo(
    () => groupPartsByBlock(textBlocks, overlayParts),
    [overlayParts, textBlocks],
  );

  const hasGeneratedSegments = segments.length > 0;
  const meaningfulLength = getMeaningfulTextLength(text);
  const charsRemaining = MIN_TEXT_LENGTH - meaningfulLength;
  const hasAudio = totalDuration > 0;
  const focusMode = viewPreferences.focusMode && isPlaying && activeRange !== null;
  const sectionStart = activeSection?.start ?? 0;
  const persistedLocalOffset = clamp(
    (activeDocument?.progress.textOffset ?? sectionStart) - sectionStart,
    0,
    text.length,
  );
  const currentLocalTextOffset = activeWordRange?.start
    ?? activeRange?.start
    ?? (navigationTextOffset === null ? null : navigationTextOffset - sectionStart)
    ?? persistedLocalOffset;
  const currentTextOffset = sectionStart + clamp(currentLocalTextOffset, 0, text.length);
  const readingProgress = activeDocument && activeDocument.text.length > 0
    ? (currentTextOffset / activeDocument.text.length) * 100
    : text.length > 0 ? (currentLocalTextOffset / text.length) * 100 : 0;
  const currentChapter = activeChapter ?? activeDocument?.chapters.find(
    (chapter) => currentTextOffset >= chapter.start && currentTextOffset < chapter.end,
  ) ?? activeDocument?.chapters.at(-1) ?? null;

  /* ── Chapter rail labels ──────────────────────────────────── */
  const partCount = activeSection?.chapterSectionCount ?? 1;
  const partIndex = activeSection?.chapterSectionIndex ?? 0;
  const isChapterStart = partIndex === 0;
  const chapters = activeDocument?.chapters ?? [];
  // Imported chapters usually open with their own title line, drawn as the
  // heading instead of a second copy above it. A plain document's only
  // "chapter" is named after the book, which the toolbar already shows, so it
  // gets no chapter heading at all.
  const showChapterHeading = currentChapter !== null && (
    chapters.length > 1 || currentChapter.title !== activeDocument?.title
  );
  const headingBlockStart = showChapterHeading && currentChapter && isChapterStart
    ? chapterHeadingBlockStart(text, textBlocks[0], currentChapter.title)
    : null;
  const previousStepLabel = chapterStepLabel(previousSection, false, currentChapter?.id ?? null, chapters);
  const nextStepLabel = chapterStepLabel(nextSection, true, currentChapter?.id ?? null, chapters);
  const contentsLabel = contentsButtonLabel(
    currentChapter,
    activeDocument?.chapters.length ?? 1,
    partIndex,
    partCount,
  );
  const openContents = useCallback(() => {
    setLibraryTab("contents");
    setLibraryOpen(true);
  }, []);

  /* ── Sleep timer ──────────────────────────────────────────── */
  const isPlayingRef = useRef(isPlaying);
  const onTogglePlayRef = useRef(onTogglePlay);
  useEffect(() => {
    isPlayingRef.current = isPlaying;
    onTogglePlayRef.current = onTogglePlay;
  }, [isPlaying, onTogglePlay]);
  const currentChapterId = currentChapter?.id ?? null;

  const startSleepTimer = useCallback((choice: SleepTimerChoice) => {
    const now = Date.now();
    setSleepNow(now);
    setSleepTimer({
      choice,
      endsAt: choice === "off" || choice === "chapter" ? null : now + Number(choice) * 60_000,
      chapterId: choice === "chapter" ? currentChapterId : null,
    });
  }, [currentChapterId]);

  const fallAsleep = useCallback(() => {
    if (isPlayingRef.current) onTogglePlayRef.current();
    setSleepTimer({ choice: "off", endsAt: null, chapterId: null });
  }, []);

  useEffect(() => {
    if (sleepTimer.endsAt === null) return;
    const timeout = window.setTimeout(fallAsleep, Math.max(0, sleepTimer.endsAt - Date.now()));
    // The rail shows minutes left; a half-minute tick keeps it honest.
    const tick = window.setInterval(() => setSleepNow(Date.now()), 30_000);
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(tick);
    };
  }, [fallAsleep, sleepTimer.endsAt]);

  // "End of chapter" fires as playback carries the reader into the next one.
  useEffect(() => {
    if (sleepTimer.choice !== "chapter" || sleepTimer.chapterId === null) return;
    if (currentChapterId !== sleepTimer.chapterId) fallAsleep();
  }, [currentChapterId, fallAsleep, sleepTimer.chapterId, sleepTimer.choice]);

  const sleepTimerLabel = sleepTimer.choice === "off"
    ? null
    : sleepTimer.choice === "chapter"
      ? "End of chapter"
      : `${Math.max(1, Math.ceil(((sleepTimer.endsAt ?? sleepNow) - sleepNow) / 60_000))}m`;

  // Auto-follow hands control back the moment the user scrolls during playback,
  // and stays paused until they resume it deliberately (pill, jump, or replay).
  // Our own scrolls open a short grace window instead of a one-shot flag: a
  // smooth scroll fires many `scroll` events, and a flag left armed by a
  // no-op scroll would swallow the user's next real one.
  const handleDocumentScroll = () => {
    if (performance.now() < programmaticScrollUntilRef.current) return;
    if (isPlaying && hasAudio && !followPausedRef.current) {
      followPausedRef.current = true;
      setFollowPaused(true);
    }
  };

  const scrollMarkerIntoView = useCallback((recenter = false) => {
    const scroller = documentScrollerRef.current;
    if (!scroller) return;
    const marker = scroller.querySelector<HTMLElement>(".reader-word-highlight-active")
      ?? scroller.querySelector<HTMLElement>(".reader-chunk-highlight-active");
    if (!marker) return;

    const height = scroller.clientHeight;
    const markerTop = marker.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    // The page holds still while the spoken word stays in a comfortable band;
    // re-pinning it on every new line made the text lurch every few seconds.
    if (!recenter && markerTop >= height * FOLLOW_BAND_TOP && markerTop <= height * FOLLOW_BAND_BOTTOM) return;

    // When it leaves the band, glide it back to the upper third, book-style.
    const lead = Math.max(32, height * 0.28);
    const nextTop = Math.max(0, scroller.scrollTop + markerTop - lead);
    if (Math.abs(scroller.scrollTop - nextTop) < 1) return;
    const smooth = !recenter && !prefersReducedMotion() && typeof scroller.scrollTo === "function";
    programmaticScrollUntilRef.current = performance.now()
      + (smooth ? SMOOTH_SCROLL_GRACE_MS : INSTANT_SCROLL_GRACE_MS);
    if (smooth) scroller.scrollTo({ top: nextTop, behavior: "smooth" });
    else scroller.scrollTop = nextTop;
  }, []);

  const resumeFollowing = useCallback(() => {
    followPausedRef.current = false;
    setFollowPaused(false);
    scrollMarkerIntoView(true);
  }, [scrollMarkerIntoView]);

  useEffect(() => {
    if (!isPlaying) return;
    followPausedRef.current = false;
    setFollowPaused(false);
  }, [isPlaying]);

  useEffect(() => {
    if (!isPlaying || followPaused) return;
    scrollMarkerIntoView();
  }, [activeRange, activeWordIndex, followPaused, isPlaying, scrollMarkerIntoView]);

  /* ── Player dock actions ──────────────────────────────────── */
  const dockState = deriveReaderDockState({
    hasAudio,
    isGenerating,
    generationProgress,
    modelReady,
    modelError,
    generationError,
    canGenerate,
    charsRemaining,
    loadingProgress,
  });
  const { showRetry, isPreparing, statusLabel } = dockState;
  const handlePrimaryAction = useCallback(() => {
    if (showRetry) {
      onRetryLoad();
      return;
    }
    if (isGenerating || isPreparing) return;
    if (canGenerate) onGenerate();
  }, [canGenerate, isGenerating, isPreparing, onGenerate, onRetryLoad, showRetry]);

  const primaryAction: AudioPlayerPrimaryAction | undefined = dockState.primaryAction
    ? { ...dockState.primaryAction, onClick: handlePrimaryAction }
    : undefined;

  const canPreviousSegment = activeSegmentIndex > 0;
  const canNextSegment = activeSegmentIndex >= 0 && activeSegmentIndex < segments.length - 1;
  const activeSegmentNumber = activeSegmentIndex >= 0 ? activeSegmentIndex + 1 : null;
  const canRetakeCurrentSegment = hasGeneratedSegments && canRetakeSegments && activeSegmentIndex >= 0 && !isRetaking;

  const startEditing = useCallback(() => {
    setEditDraft(text);
    onEditStart?.();
    setEditing(true);
  }, [onEditStart, text]);

  const finishEditing = useCallback(() => {
    if (!editing) return;
    cancelEditCommit();
    onTextChange(editDraft);
    onEditEnd?.();
    setEditing(false);
  }, [cancelEditCommit, editDraft, editing, onEditEnd, onTextChange]);

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
    finishEditing();
    followPausedRef.current = false;
    setFollowPaused(false);
    const documentLength = activeDocument?.text.length ?? sectionStart + text.length;
    const targetOffset = clamp(offset, 0, documentLength);
    setNavigationTextOffset(targetOffset);
    onNavigateToOffset?.(targetOffset, positionSec);

    const sectionEnd = activeSection?.end ?? sectionStart + text.length;
    const isDocumentEnd = sectionEnd === documentLength && targetOffset === documentLength;
    const isCurrentSection = targetOffset >= sectionStart
      && (targetOffset < sectionEnd || isDocumentEnd);
    // Parking the offset only pays off if the section is actually going to
    // change; without a navigation handler nothing consumes it and it would
    // hijack the next unrelated section change instead.
    if (!isCurrentSection && onNavigateToOffset) {
      pendingScrollOffsetRef.current = targetOffset;
      return;
    }
    const localOffset = clamp(targetOffset - sectionStart, 0, text.length);
    if (typeof positionSec === "number" && totalDuration > 0) {
      onSeek(clamp(positionSec / totalDuration, 0, 1));
    } else {
      const targetSegment = findSegmentForTextOffset(segments, localOffset);
      if (targetSegment) onJumpToSegment(targetSegment.id);
    }

    scrollToLocalOffset(localOffset);
  }, [
    activeDocument?.text.length,
    activeSection?.end,
    finishEditing,
    onJumpToSegment,
    onNavigateToOffset,
    onSeek,
    scrollToLocalOffset,
    sectionStart,
    segments,
    text.length,
    totalDuration,
  ]);

  /**
   * Maps the current DOM selection back to a local text offset. Paragraph
   * elements carry their block's character offset, so the prefix length inside
   * the containing paragraph plus that offset is exact even though newline
   * glyphs are never rendered.
   */
  const getArticleSelectionOffset = useCallback((): {
    local: number;
    collapsed: boolean;
    quote: string;
  } | null => {
    const root = readerTextRef.current;
    const selection = window.getSelection();
    if (!root || !selection || selection.rangeCount === 0) return null;
    const selectedRange = selection.getRangeAt(0);
    if (!root.contains(selectedRange.startContainer) || !root.contains(selectedRange.endContainer)) return null;
    const startElement = selectedRange.startContainer instanceof Element
      ? selectedRange.startContainer
      : selectedRange.startContainer.parentElement;
    const paragraph = startElement?.closest<HTMLElement>("[data-block-start]");
    if (!paragraph || !root.contains(paragraph)) return null;

    const prefix = document.createRange();
    prefix.selectNodeContents(paragraph);
    prefix.setEnd(selectedRange.startContainer, selectedRange.startOffset);
    const local = clamp(
      Number(paragraph.dataset.blockStart) + prefix.toString().length,
      0,
      text.length,
    );
    return { local, collapsed: selection.isCollapsed, quote: selection.toString() };
  }, [text.length]);

  const handleReaderTextMouseUp = useCallback((event: React.MouseEvent) => {
    // The second mouseup of a double-click lands after the browser has selected
    // the word under the cursor, which would flash the note pill for a frame
    // before `dblclick` seeks and clears it. Only a deliberate drag opens it.
    if (event.detail > 1) return;
    const info = getArticleSelectionOffset();
    if (!info) return;
    if (!info.collapsed) {
      const quote = info.quote.trim().replace(/\s+/g, " ").slice(0, 500);
      if (quote) setSelectedPassage({ quote, textOffset: sectionStart + info.local });
      return;
    }
    // A plain click only dismisses the note pill — seeking is double-click.
    setSelectedPassage(null);
  }, [getArticleSelectionOffset, sectionStart]);

  const handleReaderTextDoubleClick = useCallback(() => {
    const info = getArticleSelectionOffset();
    if (!info) return;
    window.getSelection()?.removeAllRanges();
    setSelectedPassage(null);
    handleJumpToOffset(sectionStart + info.local);
  }, [getArticleSelectionOffset, handleJumpToOffset, sectionStart]);

  // Arrow keys page through reading sections while the reader itself has focus —
  // the book-reader equivalent of turning pages.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      // Each page turn flushes, saves, and re-sections upstream, so a held key
      // must not fire one per repeat.
      if (event.repeat) return;
      if (editingRef.current) return;
      const target = event.target;
      if (
        target instanceof HTMLElement
        && target.closest("input, textarea, select, [contenteditable='true'], [role='dialog']")
      ) return;
      // Toolbar buttons keep focus after use; paging from there is surprising.
      // Only the unfocused page and the reading pane itself turn pages.
      const inReader = target === document.body
        || (target instanceof Node && !!documentScrollerRef.current?.contains(target));
      if (!inReader) return;
      const section = event.key === "ArrowRight" ? nextSection : previousSection;
      if (!section) return;
      event.preventDefault();
      handleJumpToOffset(section.start);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [handleJumpToOffset, nextSection, previousSection]);

  // Reader-level keys: "?" lists the shortcuts, "F" toggles the focus layout.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement
        && target.closest("input, textarea, select, [contenteditable='true']")
      ) return;
      if (event.key === "?") {
        event.preventDefault();
        setShortcutsOpen((open) => !open);
      } else if ((event.key === "f" || event.key === "F") && !event.shiftKey && onImmersiveChange) {
        if (target instanceof HTMLElement && target.closest("[role='dialog']")) return;
        event.preventDefault();
        onImmersiveChange(!immersive);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [immersive, onImmersiveChange]);

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
      setImportOpen(false);
      setLibraryOpen(true);
    } catch (error) {
      setUrlImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setUrlImportBusy(false);
    }
  }, [onImportUrl, urlImportBusy, urlInput]);


  return (
    // On wide windows the open library pushes the page aside instead of
    // covering the text column, so the reader keeps their place in view.
    <div className={`relative flex w-full flex-col gap-3 transition-[padding] duration-300 sm:gap-4 ${
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
        onClose={() => setLibraryOpen(false)}
        onOpenDocument={(id) => onOpenDocument?.(id)}
        onNewDocument={() => onNewDocument?.()}
        onDeleteDocument={(id) => onDeleteDocument?.(id)}
        onUpdateMetadata={(patch) => onUpdateDocumentMetadata?.(patch)}
        onJumpToOffset={handleJumpToOffset}
        onAddBookmark={(input) => onAddBookmark?.(input)}
        onRemoveBookmark={(id) => onRemoveBookmark?.(id)}
        onAddNote={(input) => onAddNote?.(input)}
        onUpdateNote={(id, value) => onUpdateNote?.(id, value)}
        onRemoveNote={(id) => onRemoveNote?.(id)}
        selectedPassage={selectedPassage}
        tab={libraryTab}
        onTabChange={setLibraryTab}
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
      {/* No bar slab behind the controls: Apple's toolbars express hierarchy
          by grouping, so the tools float as glass capsules beside the title. */}
      <div className="relative z-30 flex flex-wrap items-center justify-between gap-2 sm:gap-3">
        {/* The library drawer opens from the left edge, so the button that
            opens it sits on the left too, beside the book it replaces. */}
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <button
            type="button"
            onClick={() => setLibraryOpen(true)}
            aria-label="Open Reader library"
            title="Library"
            className="glass-control relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-text-secondary"
          >
            <Library size={16} />
            <span className="absolute -top-1 -right-1 min-w-4 rounded-full bg-accent px-1 text-center font-mono text-2xs leading-4 text-white">
              {documents.length}
            </span>
          </button>
          <div className="min-w-0">
            <h2 className="truncate font-display text-xl leading-tight font-semibold text-text-primary">
              {activeDocument?.title || "Reader"}
            </h2>
            {/* Generation status lives in the player dock; the header only
                identifies the book so long titles keep their room. */}
            <p className="mt-0.5 truncate font-mono text-xs tabular-nums text-text-muted">
              {activeDocument
                ? activeDocument.author
                  || (activeDocument.chapters.length > 1 ? `${activeDocument.chapters.length} chapters` : "Reading")
                : "No book open"}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
        {/* One capsule for the icon tools; the voice button, which carries
            text, gets a container of its own so the two never read as one. */}
        <div className="glass flex items-center gap-0.5 rounded-full p-1">
        <div className="relative">
          <button
            ref={appearanceButtonRef}
            type="button"
            onClick={() => setAppearanceOpen((open) => !open)}
            aria-label="Reading appearance"
            aria-expanded={appearanceOpen}
            title="Reading appearance"
            className={TOOL_BUTTON}
          >
            <Type size={16} />
          </button>
          {appearanceOpen && (
            <ViewportPopover
              anchorRef={appearanceButtonRef}
              popoverRef={appearancePopoverRef}
              maxWidth={360}
              className="glass-pop animate-scale-in origin-top-right rounded-[26px] p-4"
              ariaLabel="Reading appearance"
              onClose={() => setAppearanceOpen(false)}
            >
              <div className="space-y-4">
                <SegmentedChoice
                  legend="Page"
                  value={viewPreferences.tone}
                  options={READER_TONE_OPTIONS}
                  onChange={(tone) => onViewPreferencesChange?.({ tone })}
                />
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <label htmlFor={`${readingTextId}-font-size`} className="text-sm font-semibold text-text-secondary">
                      Text size
                    </label>
                    <span className="font-mono text-xs text-text-secondary">{viewPreferences.fontSize}px</span>
                  </div>
                  <input
                    id={`${readingTextId}-font-size`}
                    type="range"
                    min={15}
                    max={26}
                    step={1}
                    value={viewPreferences.fontSize}
                    onChange={(event) => onViewPreferencesChange?.({ fontSize: Number(event.target.value) })}
                  />
                </div>
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <label htmlFor={`${readingTextId}-line-height`} className="text-sm font-semibold text-text-secondary">
                      Line spacing
                    </label>
                    <span className="font-mono text-xs text-text-secondary">{viewPreferences.lineHeight.toFixed(2)}</span>
                  </div>
                  <input
                    id={`${readingTextId}-line-height`}
                    type="range"
                    min={1.4}
                    max={2.2}
                    step={0.05}
                    value={viewPreferences.lineHeight}
                    onChange={(event) => onViewPreferencesChange?.({ lineHeight: Number(event.target.value) })}
                  />
                </div>
                <SegmentedChoice
                  legend="Column width"
                  value={viewPreferences.columnWidth}
                  options={COLUMN_WIDTH_OPTIONS}
                  onChange={(columnWidth) => onViewPreferencesChange?.({ columnWidth })}
                />
                <SegmentedChoice
                  legend="Sleep timer"
                  value={sleepTimer.choice}
                  options={SLEEP_TIMER_OPTIONS}
                  onChange={startSleepTimer}
                />
                <SwitchRow
                  label="Focus spoken text"
                  checked={viewPreferences.focusMode}
                  onChange={(focusMode) => onViewPreferencesChange?.({ focusMode })}
                />
                <SwitchRow
                  label="Continue automatically"
                  checked={viewPreferences.autoAdvance}
                  onChange={(autoAdvance) => onViewPreferencesChange?.({ autoAdvance })}
                />
                <button
                  type="button"
                  onClick={() => {
                    setAppearanceOpen(false);
                    setShortcutsOpen(true);
                  }}
                  className="flex w-full items-center gap-2 rounded-xl px-1 py-1 text-xs text-text-muted transition-colors hover:text-accent"
                >
                  <Keyboard size={13} aria-hidden />
                  Keyboard shortcuts
                  <kbd className="ml-auto rounded border border-border px-1.5 font-mono text-2xs">?</kbd>
                </button>
              </div>
            </ViewportPopover>
          )}
        </div>

        <button
          type="button"
          onClick={() => {
            if (editing) finishEditing();
            else startEditing();
          }}
          aria-label={editing ? "Finish editing section" : "Edit current section"}
          title={editing ? "Finish editing" : "Edit current section"}
          className={editing
            ? `${TOOL_BUTTON} bg-accent-light text-accent hover:bg-accent-light hover:text-accent`
            : TOOL_BUTTON}
        >
          {editing ? <Check size={16} /> : <Pencil size={15} />}
        </button>

        {(onImportDocument || onImportFile || onImportUrl) && (
          <div className="relative">
            <button
              ref={importButtonRef}
              type="button"
              onClick={() => {
                setImportOpen((open) => !open);
                setUrlImportError(null);
              }}
              disabled={isImportingDocument && !importOpen}
              aria-label="Import document"
              aria-expanded={importOpen}
              title="Import a file or an article URL"
              className={`${TOOL_BUTTON} disabled:cursor-default disabled:opacity-60`}
            >
              {isImportingDocument
                ? <Loader2 size={15} className="animate-spin" />
                : <FileUp size={15} />}
            </button>
            {importOpen && (
              <ViewportPopover
                anchorRef={importButtonRef}
                popoverRef={importPopoverRef}
                maxWidth={400}
                className="glass-pop animate-scale-in origin-top-right rounded-[26px] p-4"
                ariaLabel="Import document"
                onClose={() => setImportOpen(false)}
              >
                {(onImportDocument || onImportFile) && (
                  <button
                    type="button"
                    disabled={isImportingDocument}
                    onClick={() => {
                      setImportOpen(false);
                      if (onImportDocument) onImportDocument();
                      else fileInputRef.current?.click();
                    }}
                    className="flex w-full items-center gap-3 rounded-xl border border-border bg-text-primary/[0.04] px-3 py-2.5 text-left text-sm text-text-primary transition-colors hover:bg-text-primary/[0.07] disabled:cursor-default disabled:opacity-60"
                  >
                    <FileUp size={15} className="shrink-0 text-accent" />
                    <span className="min-w-0">
                      <span className="block font-semibold">Choose a file…</span>
                      <span className="block text-xs text-text-muted">
                        {onImportDocument
                          ? "EPUB, PDF, text, Markdown, Office, or images"
                          : "EPUB, text, Markdown, or HTML"}
                      </span>
                    </span>
                  </button>
                )}
                {onImportUrl && (
                  <div className={onImportDocument || onImportFile ? "mt-4 border-t border-border/50 pt-4" : undefined}>
                    <label className="block text-sm font-semibold text-text-secondary">
                      Article URL
                      <input
                        type="url"
                        value={urlInput}
                        onChange={(event) => setUrlInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void handleUrlImport();
                        }}
                        placeholder="https://example.com/article"
                        className="mt-2 w-full rounded-xl border border-border bg-text-primary/[0.04] px-3 py-2.5 text-sm normal-case tracking-normal text-text-primary outline-none placeholder:text-text-muted focus:border-accent/40"
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
              </ViewportPopover>
            )}
          </div>
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

        </div>

        {/* Voice & model settings popover */}
        <div className="relative">
          <button
            ref={settingsButtonRef}
            type="button"
            onClick={() => setSettingsOpen((o) => !o)}
            aria-expanded={settingsOpen}
            aria-label="Voice settings"
            className="glass-control flex h-12 min-w-12 items-center justify-center gap-2 rounded-full px-4 text-sm text-text-primary"
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
            <ViewportPopover
              anchorRef={settingsButtonRef}
              popoverRef={settingsPopoverRef}
              maxWidth={448}
              className="glass-pop animate-scale-in origin-top-right rounded-[26px] p-4"
              ariaLabel="Voice settings"
              onClose={() => setSettingsOpen(false)}
              // ModelToggle portals its menu to document.body so it can escape
              // this scrollable popover. A press inside that menu must not close
              // and unmount the settings tree before the option's click selects
              // the new runtime.
              keepOpenWithin="[data-model-picker-menu]"
            >
              <div className="flex flex-col gap-4">
                <ModelToggle
                  activeModel={activeModel}
                  onModelChange={onModelChange}
                  desktopModelOptions={desktopModelOptions}
                  kokoroState={kokoroState}
                  supertonicState={supertonicState}
                  visibleModels={visibleModels}
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
                        className="text-sm font-semibold text-text-secondary"
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
            </ViewportPopover>
          )}
        </div>
        </div>
      </div>

      {selectedDesktopModel && modelError && (
        <div className="flex flex-col gap-3 rounded-2xl border border-danger/20 bg-danger/[0.06] px-4 py-3 sm:flex-row sm:items-center sm:justify-between" role="status">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-text-primary">
              {selectedDesktopModel.key === "qwen3"
                ? `${activeModelLabel} needs setup in Reader`
                : `${activeModelLabel} is unavailable`}
            </p>
            <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-text-secondary">{modelError}</p>
          </div>
          <button
            type="button"
            onClick={selectedDesktopModel.key === "qwen3" ? () => setSettingsOpen(true) : onRetryLoad}
            className="shrink-0 rounded-xl border border-border bg-text-primary/[0.04] px-3 py-2 text-sm font-semibold text-text-primary transition-all hover:bg-text-primary/[0.07] active:scale-[0.98]"
          >
            {selectedDesktopModel.key === "qwen3" ? "Open Qwen settings" : "Retry"}
          </button>
        </div>
      )}

      {libraryError && (
        <p className="px-1 text-xs text-danger" role="status">{libraryError}</p>
      )}

      {/* ── Document ────────────────────────────────────────── */}
      <section
        className={`surface reader-tone-${viewPreferences.tone} relative flex flex-col overflow-hidden rounded-[28px] ${fullScreen ? "flex-1" : ""}`}
        style={{
          "--reader-column-width": `${readerColumnWidthRem(viewPreferences.columnWidth)}rem`,
        } as CSSProperties}
      >
        {/* Running head: where you are, one tap to the contents, and the two
            page turns — the only chapter chrome the reader needs. */}
        {currentChapter && (
          <nav
            aria-label="Chapter navigation"
            className="flex shrink-0 items-center gap-2 border-b border-border/40 px-2.5 py-2 sm:gap-3 sm:px-3"
          >
            {/* Both page turns sit together on the left, the way a reader's
                thumb expects them, instead of straddling the title. */}
            <div className="flex shrink-0 items-center rounded-full bg-text-primary/[0.05] p-0.5">
              <button
                type="button"
                disabled={!previousSection}
                onClick={() => previousSection && handleJumpToOffset(previousSection.start)}
                aria-label={previousStepLabel}
                title={`${previousStepLabel} (←)`}
                className="flex h-7 w-7 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-text-primary/[0.08] hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
              >
                <ChevronLeft size={15} />
              </button>
              <span className="h-4 w-px bg-border/70" aria-hidden />
              <button
                type="button"
                disabled={!nextSection}
                onClick={() => nextSection && handleJumpToOffset(nextSection.start)}
                aria-label={nextStepLabel}
                title={`${nextStepLabel} (→)`}
                className="flex h-7 w-7 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-text-primary/[0.08] hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
              >
                <ChevronRight size={15} />
              </button>
            </div>

            {/* Hugging its own text keeps the hover and focus ring on the
                title instead of stretching a highlight across the whole rail. */}
            <button
              type="button"
              onClick={openContents}
              aria-label={contentsLabel}
              aria-haspopup="dialog"
              title="Open contents"
              className="group -ml-1 mr-auto flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left transition-colors hover:bg-text-primary/[0.07]"
            >
              {/* A one-chapter document would just repeat the book title from
                  the header, so the rail names the destination instead. */}
              <span className="truncate text-sm font-medium text-text-secondary transition-colors group-hover:text-accent">
                {(activeDocument?.chapters.length ?? 0) > 1 ? currentChapter.title : "Contents"}
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
                  onClick={() => startSleepTimer("off")}
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
        )}

        <div className={`relative ${fullScreen ? "min-h-[55vh] flex-1" : "min-h-72"}`}>
          {editing ? (
            <textarea
              id={readingTextId}
              ref={textareaRef}
              aria-label="Reading Text"
              value={editDraft}
              onChange={(event) => {
                const value = event.target.value;
                setEditDraft(value);
                // Re-sectioning the document on every keystroke is expensive;
                // debounce the upstream commit and flush on blur/finish.
                cancelEditCommit();
                editCommitTimerRef.current = window.setTimeout(() => {
                  editCommitTimerRef.current = null;
                  onTextChange(value);
                }, 400);
              }}
              onBlur={() => {
                cancelEditCommit();
                onTextChange(editDraft);
              }}
              onScroll={handleDocumentScroll}
              onDoubleClick={(event) => {
                if (!hasGeneratedSegments) return;
                const targetSegment = findSegmentForTextOffset(segments, event.currentTarget.selectionStart);
                if (targetSegment) onJumpToSegment(targetSegment.id);
              }}
              placeholder="Type or paste text for this reading section…"
              className={`absolute inset-0 h-full w-full resize-none overflow-auto bg-transparent text-text-primary caret-text-primary placeholder:font-sans placeholder:text-text-muted focus:outline-none ${DOCUMENT_TEXT_CLASSES} ${documentPadding(fullScreen)}`}
              style={{ fontSize: viewPreferences.fontSize, lineHeight: viewPreferences.lineHeight }}
            />
          ) : (
            <div
              id={readingTextId}
              ref={documentScrollerRef}
              role="document"
              aria-label="Reading Text"
              tabIndex={0}
              onScroll={handleDocumentScroll}
              className={`absolute inset-0 overflow-auto text-text-primary outline-none ${documentPadding(fullScreen)} ${fullScreen ? "reader-scroll-edge" : ""} ${focusMode ? "reader-focus" : ""}`}
              style={{ fontSize: viewPreferences.fontSize, lineHeight: viewPreferences.lineHeight }}
            >
              {/* A chapter opens like a printed chapter opens; the parts after
                  it pick up mid-flow with a quiet continuation marker instead
                  of restating the title at full size. */}
              {currentChapter && showChapterHeading && headingBlockStart === null && (isChapterStart ? (
                <header className="mb-7 border-b border-border/50 pb-5">
                  <h3 className="font-display text-[1.45em] leading-tight font-semibold text-text-primary">
                    {currentChapter.title}
                  </h3>
                </header>
              ) : (
                <p className="mb-6 truncate font-mono text-xs text-text-secondary">
                  {currentChapter.title} · continued
                </p>
              ))}
              <article
                ref={readerTextRef}
                onMouseUp={handleReaderTextMouseUp}
                onDoubleClick={handleReaderTextDoubleClick}
                title="Double-click to listen from here"
                className={`${DOCUMENT_TEXT_CLASSES} reader-article`}
              >
                {paragraphs.map(({ block, parts }) => {
                  // Hand the word offsets only to the paragraph that contains
                  // them; every other paragraph keeps its memoised output.
                  const holdsActiveWord = activeWordRange !== null
                    && activeWordRange.start < block.end
                    && activeWordRange.end > block.start;
                  return (
                    <ReaderParagraph
                      key={`block-${block.start}`}
                      block={block}
                      parts={parts}
                      wordStart={holdsActiveWord ? activeWordRange.start : -1}
                      wordEnd={holdsActiveWord ? activeWordRange.end : -1}
                      heading={block.start === headingBlockStart}
                    />
                  );
                })}
              </article>
              {paragraphs.length === 0 && (
                <div className="rounded-2xl border border-dashed border-border p-5 text-center font-sans text-sm text-text-muted">
                  <p>This section is empty.</p>
                  <button
                    type="button"
                    onClick={startEditing}
                    className="mt-3 rounded-xl border border-border bg-text-primary/[0.04] px-3 py-2 text-sm font-medium text-text-primary transition-all duration-200 hover:bg-text-primary/[0.07] hover:text-accent active:scale-[0.98]"
                  >
                    Add text
                  </button>
                </div>
              )}
              {selectedPassage && (
                <div
                  role="toolbar"
                  aria-label="Selected passage"
                  className="sticky bottom-44 left-1/2 mt-8 flex w-max -translate-x-1/2 items-center gap-0.5 glass rounded-full p-1 font-sans text-xs font-semibold text-accent"
                >
                  <button
                    type="button"
                    onClick={() => {
                      const offset = selectedPassage.textOffset;
                      window.getSelection()?.removeAllRanges();
                      setSelectedPassage(null);
                      handleJumpToOffset(offset);
                    }}
                    className="flex items-center gap-1.5 rounded-full px-3 py-1.5 transition-colors hover:bg-accent-light"
                  >
                    <Play size={12} aria-hidden />
                    Listen from here
                  </button>
                  {onAddBookmark && (
                    <button
                      type="button"
                      onClick={() => {
                        const local = selectedPassage.textOffset - sectionStart;
                        onAddBookmark({
                          label: selectedPassage.quote.length > 40
                            ? `${selectedPassage.quote.slice(0, 40).trimEnd()}…`
                            : selectedPassage.quote,
                          textOffset: selectedPassage.textOffset,
                          positionSec: findSegmentForTextOffset(segments, local)?.startSec ?? 0,
                        });
                        window.getSelection()?.removeAllRanges();
                        setSelectedPassage(null);
                      }}
                      className="flex items-center gap-1.5 rounded-full px-3 py-1.5 transition-colors hover:bg-accent-light"
                    >
                      <BookmarkPlus size={12} aria-hidden />
                      Bookmark
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label="Add note to selection"
                    onClick={() => {
                      setLibraryTab("notes");
                      setLibraryOpen(true);
                    }}
                    className="flex items-center gap-1.5 rounded-full px-3 py-1.5 transition-colors hover:bg-accent-light"
                  >
                    <NotebookPen size={12} aria-hidden />
                    Note
                  </button>
                  <button
                    type="button"
                    aria-label="Dismiss"
                    onClick={() => {
                      window.getSelection()?.removeAllRanges();
                      setSelectedPassage(null);
                    }}
                    className="flex h-7 w-7 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-accent-light hover:text-accent"
                  >
                    <X size={12} />
                  </button>
                </div>
              )}
            </div>
          )}
          {followPaused && isPlaying && !editing && (
            <button
              type="button"
              onClick={resumeFollowing}
              className="absolute bottom-5 left-1/2 z-10 -translate-x-1/2 glass rounded-full px-4 py-2 text-xs font-semibold text-accent transition-transform active:scale-[0.98]"
            >
              Resume auto-follow
            </button>
          )}
        </div>
      </section>

      {shortcutsOpen && (
        <ReaderShortcutsDialog onClose={() => setShortcutsOpen(false)} />
      )}

      {/* ── Player dock ─────────────────────────────────────── */}
      <div
        className={`reader-tone-${viewPreferences.tone} ${
          fullScreen
            ? "fixed bottom-4 left-1/2 z-40 w-[min(44rem,calc(100vw-1.5rem))] -translate-x-1/2 sm:bottom-6"
            : "w-full"
        }`}
      >
        <AudioPlayer
          variant="dock"
          embedded
          isPlaying={isPlaying}
          clock={clock}
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
