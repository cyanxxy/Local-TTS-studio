import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileUp,
  Library,
  Link2,
  Loader2,
  Plus,
  Pencil,
  SlidersHorizontal,
  Type,
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
  type ReaderViewPreferences,
} from "../lib/readerPreferences";
import { AudioPlayer, type AudioPlayerPrimaryAction } from "./AudioPlayer";
import { ModelToggle } from "./ModelToggle";
import { ReaderLibrarySidebar, type ReaderSidebarTab } from "./ReaderLibrarySidebar";
import { VoiceSelector } from "./VoiceSelector";

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
  totalSectionCount?: number;
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
  start: number;
  sectionIndex: number;
  isActive: boolean;
  isWordActive: boolean;
}

interface SectionBoundary {
  start: number;
  end: number;
}

interface TextBlock {
  start: number;
  end: number;
  blankLineBefore: boolean;
}

/**
 * Splits section text into paragraph blocks, one per non-empty line. Newline
 * separators live between blocks and are never rendered as glyphs; every block
 * records its character offset so DOM positions map back to text offsets.
 */
function splitTextBlocks(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  const lineMatcher = /[^\n]+/g;
  let previousEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = lineMatcher.exec(text)) !== null) {
    blocks.push({
      start: match.index,
      end: match.index + match[0].length,
      blankLineBefore: text.slice(previousEnd, match.index).split("\n").length > 2,
    });
    previousEnd = match.index + match[0].length;
  }
  return blocks;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function findSegmentForTextOffset(
  segments: readonly AudioSegment[],
  targetOffset: number,
): AudioSegment | undefined {
  return segments.find((segment) => (
    typeof segment.textStart === "number"
    && typeof segment.textEnd === "number"
    && targetOffset >= segment.textStart
    && targetOffset < segment.textEnd
  ))
    ?? segments.find((segment) => (
      typeof segment.textStart === "number" && segment.textStart >= targetOffset
    ))
    ?? [...segments].reverse().find((segment) => (
      typeof segment.textEnd === "number" && segment.textEnd <= targetOffset
    ));
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
  blocks: TextBlock[],
  boundaries: SectionBoundary[],
  activeRange: { start: number; end: number } | null,
  activeWordRange: { start: number; end: number } | null,
): OverlayPart[] {
  if (!text) return [];

  const offsets = new Set<number>([0, text.length]);
  for (const block of blocks) {
    offsets.add(block.start);
    offsets.add(block.end);
  }
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
      start: partStart,
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
  "whitespace-pre-wrap break-words font-reading";

/* Horizontal padding comes from .reader-doc-pad, which centers a readable
   text column inside the full-bleed panel at any window size. */
function documentPadding(fullScreen: boolean): string {
  return fullScreen
    ? "reader-doc-pad pt-8 pb-44 sm:pt-12 sm:pb-48"
    : "reader-doc-pad py-8";
}

interface ViewportPopoverProps {
  anchorRef: RefObject<HTMLElement | null>;
  popoverRef: RefObject<HTMLDivElement | null>;
  maxWidth: number;
  className: string;
  ariaLabel: string;
  onClose: () => void;
  children: ReactNode;
}

const POPOVER_FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function ViewportPopover({
  anchorRef,
  popoverRef,
  maxWidth,
  className,
  ariaLabel,
  onClose,
  children,
}: ViewportPopoverProps) {
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useLayoutEffect(() => {
    const updatePosition = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;

      const rect = anchor.getBoundingClientRect();
      const viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const viewportRight = viewportLeft + viewportWidth;
      const viewportBottom = viewportTop + viewportHeight;
      const gutter = 12;
      const gap = 8;
      const width = Math.min(maxWidth, Math.max(0, viewportWidth - gutter * 2));
      const left = Math.min(
        Math.max(rect.right - width, viewportLeft + gutter),
        viewportRight - width - gutter,
      );
      const availableBelow = viewportBottom - rect.bottom - gap - gutter;
      const availableAbove = rect.top - viewportTop - gap - gutter;
      const openAbove = availableBelow < 220 && availableAbove > availableBelow;
      const maxHeight = Math.max(96, Math.min(672, openAbove ? availableAbove : availableBelow));
      const top = openAbove
        ? Math.max(viewportTop + gutter, rect.top - gap - maxHeight)
        : rect.bottom + gap;

      setPosition({ top, left, width, maxHeight });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    window.visualViewport?.addEventListener("resize", updatePosition);
    window.visualViewport?.addEventListener("scroll", updatePosition);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      window.visualViewport?.removeEventListener("resize", updatePosition);
      window.visualViewport?.removeEventListener("scroll", updatePosition);
    };
  }, [anchorRef, maxWidth]);

  const ready = position !== null;
  useEffect(() => {
    if (!ready) return;
    const anchor = anchorRef.current;
    const frame = window.requestAnimationFrame(() => {
      const focusable = popoverRef.current?.querySelector<HTMLElement>(POPOVER_FOCUSABLE_SELECTOR);
      (focusable ?? popoverRef.current)?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !popoverRef.current) return;
      const focusable = [...popoverRef.current.querySelectorAll<HTMLElement>(POPOVER_FOCUSABLE_SELECTOR)]
        .filter((element) => !element.hasAttribute("disabled"));
      if (focusable.length === 0) {
        event.preventDefault();
        popoverRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      if (anchor?.isConnected) anchor.focus();
    };
  }, [anchorRef, popoverRef, ready]);

  if (!position) return null;

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      tabIndex={-1}
      className={`fixed z-[120] overflow-y-auto ${className}`}
      style={position}
    >
      {children}
    </div>,
    document.body,
  );
}

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
  totalSectionCount = 0,
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
  const [urlImportOpen, setUrlImportOpen] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [urlImportError, setUrlImportError] = useState<string | null>(null);
  const [urlImportBusy, setUrlImportBusy] = useState(false);
  const [navigationTextOffset, setNavigationTextOffset] = useState<number | null>(null);
  const [selectedPassage, setSelectedPassage] = useState<{ quote: string; textOffset: number } | null>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const settingsPopoverRef = useRef<HTMLDivElement>(null);
  const appearanceButtonRef = useRef<HTMLButtonElement>(null);
  const appearancePopoverRef = useRef<HTMLDivElement>(null);
  const urlButtonRef = useRef<HTMLButtonElement>(null);
  const urlPopoverRef = useRef<HTMLDivElement>(null);
  const settingsOpenRef = useRef(settingsOpen);
  const appearanceOpenRef = useRef(appearanceOpen);
  const urlImportOpenRef = useRef(urlImportOpen);
  const editingRef = useRef(editing);
  const editDraftRef = useRef(editDraft);
  const onEditEndRef = useRef(onEditEnd);
  const onTextChangeRef = useRef(onTextChange);
  const previousDocumentIdRef = useRef(activeDocument?.id);
  const editCommitTimerRef = useRef<number | null>(null);
  // Cross-section jumps land after the new section's text renders; this holds
  // the document-absolute offset to scroll to once that happens.
  const pendingScrollOffsetRef = useRef<number | null>(null);
  const [followPaused, setFollowPaused] = useState(false);
  const followPausedRef = useRef(false);

  const cancelEditCommit = useCallback(() => {
    if (editCommitTimerRef.current !== null) {
      window.clearTimeout(editCommitTimerRef.current);
      editCommitTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    settingsOpenRef.current = settingsOpen;
  }, [settingsOpen]);

  useEffect(() => {
    appearanceOpenRef.current = appearanceOpen;
  }, [appearanceOpen]);

  useEffect(() => {
    urlImportOpenRef.current = urlImportOpen;
  }, [urlImportOpen]);

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
    programmaticScrollRef.current = true;
    scroller.scrollTop = Math.max(
      0,
      scroller.scrollTop + anchorRect.top - scroller.getBoundingClientRect().top - lead,
    );
  }, []);

  useLayoutEffect(() => {
    if (editing) return;
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

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        settingsOpenRef.current
        && !settingsRef.current?.contains(target)
        && !settingsPopoverRef.current?.contains(target)
      ) {
        setSettingsOpen(false);
      }
      if (
        appearanceOpenRef.current
        && !appearanceButtonRef.current?.contains(target)
        && !appearancePopoverRef.current?.contains(target)
      ) {
        setAppearanceOpen(false);
      }
      if (
        urlImportOpenRef.current
        && !urlButtonRef.current?.contains(target)
        && !urlPopoverRef.current?.contains(target)
      ) {
        setUrlImportOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

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

  // Visual sections must remain stable while audio streams in. Generated
  // segments are a partial, time-based view and may also be transport-split;
  // using them as document boundaries makes future sections disappear or
  // flicker. Click-to-seek resolves against `segments` separately below.
  const sectionBoundaries = useMemo((): SectionBoundary[] => (
    previewChunks.map((chunk) => ({
      start: chunk.start,
      end: chunk.end,
    }))
  ), [previewChunks]);

  const textBlocks = useMemo(() => splitTextBlocks(text), [text]);

  const overlayParts = useMemo(
    () => buildOverlayParts(text, textBlocks, sectionBoundaries, activeRange, activeWordRange),
    [text, textBlocks, sectionBoundaries, activeRange, activeWordRange],
  );

  const paragraphs = useMemo(() => {
    const groups = textBlocks.map((block) => ({ block, parts: [] as OverlayPart[] }));
    let blockIndex = 0;
    for (const part of overlayParts) {
      while (blockIndex < textBlocks.length && part.start >= textBlocks[blockIndex].end) {
        blockIndex += 1;
      }
      if (blockIndex >= textBlocks.length) break;
      // Parts that fall between blocks are newline separators; they carry no glyphs.
      if (part.start >= textBlocks[blockIndex].start) groups[blockIndex].parts.push(part);
    }
    return groups;
  }, [overlayParts, textBlocks]);

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
  const remainingSeconds = Math.max(0, totalDuration - currentTime);
  const remainingLabel = totalDuration > 0
    ? remainingSeconds < 60
      ? `${Math.ceil(remainingSeconds)} sec left`
      : `${Math.ceil(remainingSeconds / 60)} min left`
    : null;

  // Auto-follow hands control back the moment the user scrolls during playback,
  // and stays paused until they resume it deliberately (pill, jump, or replay).
  const programmaticScrollRef = useRef(false);

  const handleDocumentScroll = () => {
    if (programmaticScrollRef.current) {
      programmaticScrollRef.current = false;
      return;
    }
    if (isPlaying && hasAudio && !followPausedRef.current) {
      followPausedRef.current = true;
      setFollowPaused(true);
    }
  };

  const scrollMarkerIntoView = useCallback(() => {
    const scroller = documentScrollerRef.current;
    if (!scroller) return;
    const marker = scroller.querySelector<HTMLElement>(".reader-word-highlight-active")
      ?? scroller.querySelector<HTMLElement>(".reader-chunk-highlight-active");
    if (!marker) return;

    // Keep the spoken sentence in the upper third of the page, book-style.
    const lead = Math.max(32, scroller.clientHeight * 0.28);
    const nextTop = Math.max(
      0,
      scroller.scrollTop + marker.getBoundingClientRect().top - scroller.getBoundingClientRect().top - lead,
    );
    if (Math.abs(scroller.scrollTop - nextTop) < 1) return;
    programmaticScrollRef.current = true;
    scroller.scrollTop = nextTop;
  }, []);

  const resumeFollowing = useCallback(() => {
    followPausedRef.current = false;
    setFollowPaused(false);
    scrollMarkerIntoView();
  }, [scrollMarkerIntoView]);

  useEffect(() => {
    if (!isPlaying) return;
    followPausedRef.current = false;
    setFollowPaused(false);
  }, [isPlaying]);

  useEffect(() => {
    if (!isPlaying || followPaused) return;
    scrollMarkerIntoView();
  }, [activeRange, followPaused, isPlaying, scrollMarkerIntoView]);

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
    if (!isCurrentSection) {
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

  const handleReaderTextMouseUp = useCallback(() => {
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

  // Arrow keys page through reading sections whenever focus isn't in a form
  // control or dialog — the book-reader equivalent of turning pages.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (editingRef.current) return;
      const target = event.target;
      if (
        target instanceof HTMLElement
        && target.closest("input, textarea, select, [contenteditable='true'], [role='dialog']")
      ) return;
      const section = event.key === "ArrowRight" ? nextSection : previousSection;
      if (!section) return;
      event.preventDefault();
      handleJumpToOffset(section.start);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [handleJumpToOffset, nextSection, previousSection]);

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
              {Math.round(readingProgress)}% · {activeDocument?.chapters.length ?? 0} chapter{(activeDocument?.chapters.length ?? 0) !== 1 ? "s" : ""}
              {activeSection && totalSectionCount > 1 ? ` · section ${activeSection.order + 1}/${totalSectionCount}` : ""}
              {statusLabel ? ` · ${statusLabel}` : ""}
            </p>
          </div>
        </div>

        <div className="flex w-full shrink-0 items-center justify-between gap-1 sm:w-auto sm:justify-start sm:gap-2">
        <button
          type="button"
          onClick={() => setLibraryOpen(true)}
          aria-label="Open Reader library"
          className="flex min-h-[44px] min-w-[44px] items-center gap-2 rounded-xl border border-white/50 bg-white/40 px-3 py-2 text-sm text-text-primary shadow-glass-sm backdrop-blur-md transition-all duration-200 hover:-translate-y-px hover:bg-white/60 active:translate-y-0 active:scale-[0.98]"
        >
          <Library size={14} className="text-text-muted" />
          <span className="hidden font-medium lg:inline">Library</span>
          <span className="rounded-full bg-accent-light px-1.5 font-mono text-2xs text-accent">{documents.length}</span>
        </button>

        <div className="relative">
          <button
            ref={appearanceButtonRef}
            type="button"
            onClick={() => setAppearanceOpen((open) => !open)}
            aria-label="Reading appearance"
            aria-expanded={appearanceOpen}
            title="Reading appearance"
            className="flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-xl border border-white/50 bg-white/40 text-text-muted shadow-glass-sm backdrop-blur-md transition-all duration-200 hover:-translate-y-px hover:bg-white/60 hover:text-accent active:translate-y-0 active:scale-[0.98]"
          >
            <Type size={16} />
          </button>
          {appearanceOpen && (
            <ViewportPopover
              anchorRef={appearanceButtonRef}
              popoverRef={appearancePopoverRef}
              maxWidth={360}
              className="glass-pop rounded-2xl p-4"
              ariaLabel="Reading appearance"
              onClose={() => setAppearanceOpen(false)}
            >
              <div className="space-y-4">
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <label htmlFor={`${readingTextId}-font-size`} className="text-xs font-semibold uppercase tracking-widest text-text-muted">
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
                    <label htmlFor={`${readingTextId}-line-height`} className="text-xs font-semibold uppercase tracking-widest text-text-muted">
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
                <fieldset>
                  <legend className="mb-2 text-xs font-semibold uppercase tracking-widest text-text-muted">Column width</legend>
                  <div className="grid grid-cols-3 gap-1 rounded-xl bg-white/30 p-1">
                    {(["narrow", "comfortable", "wide"] as const).map((width) => (
                      <button
                        key={width}
                        type="button"
                        aria-pressed={viewPreferences.columnWidth === width}
                        onClick={() => onViewPreferencesChange?.({ columnWidth: width })}
                        className={`rounded-lg px-2 py-2 text-xs font-medium capitalize transition-colors ${
                          viewPreferences.columnWidth === width
                            ? "bg-panel text-accent shadow-glass-sm"
                            : "text-text-muted hover:text-text-primary"
                        }`}
                      >
                        {width === "comfortable" ? "Standard" : width}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <label className="flex items-center justify-between gap-3 text-sm text-text-secondary">
                  Focus spoken text
                  <input
                    type="checkbox"
                    checked={viewPreferences.focusMode}
                    onChange={(event) => onViewPreferencesChange?.({ focusMode: event.target.checked })}
                  />
                </label>
                <label className="flex items-center justify-between gap-3 text-sm text-text-secondary">
                  Continue automatically
                  <input
                    type="checkbox"
                    checked={viewPreferences.autoAdvance}
                    onChange={(event) => onViewPreferencesChange?.({ autoAdvance: event.target.checked })}
                  />
                </label>
              </div>
            </ViewportPopover>
          )}
        </div>

        <button
          type="button"
          onClick={() => {
            if (editing) {
              finishEditing();
            } else {
              setEditDraft(text);
              onEditStart?.();
              setEditing(true);
            }
          }}
          aria-label={editing ? "Finish editing section" : "Edit current section"}
          title={editing ? "Finish editing" : "Edit current section"}
          className={`flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-xl border shadow-glass-sm backdrop-blur-md transition-all duration-200 hover:-translate-y-px active:translate-y-0 active:scale-[0.98] ${
            editing
              ? "border-accent/30 bg-accent-light text-accent"
              : "border-white/50 bg-white/40 text-text-muted hover:bg-white/60 hover:text-accent"
          }`}
        >
          {editing ? <Check size={16} /> : <Pencil size={15} />}
        </button>

        {onNewDocument && (
          <button
            type="button"
            onClick={onNewDocument}
            aria-label="New document"
            title="New document"
            className="flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-xl border border-white/50 bg-white/40 text-text-muted shadow-glass-sm backdrop-blur-md transition-all duration-200 hover:-translate-y-px hover:bg-white/60 hover:text-accent active:translate-y-0 active:scale-[0.98]"
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
            className="flex min-h-[44px] min-w-[44px] items-center gap-2 rounded-xl border border-white/50 bg-white/40 px-3 py-2 text-sm text-text-primary shadow-glass-sm backdrop-blur-md transition-all duration-200 hover:-translate-y-px hover:bg-white/60 active:translate-y-0 active:scale-[0.98] disabled:cursor-default disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:bg-white/40"
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
              ref={urlButtonRef}
              type="button"
              onClick={() => {
                setUrlImportOpen((open) => !open);
                setUrlImportError(null);
              }}
              aria-label="Import from URL"
              aria-expanded={urlImportOpen}
              title="Import article from URL"
              className="flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-xl border border-white/50 bg-white/40 text-text-muted shadow-glass-sm backdrop-blur-md transition-all duration-200 hover:-translate-y-px hover:bg-white/60 hover:text-accent active:translate-y-0 active:scale-[0.98]"
            >
              <Link2 size={15} />
            </button>
            {urlImportOpen && (
              <ViewportPopover
                anchorRef={urlButtonRef}
                popoverRef={urlPopoverRef}
                maxWidth={400}
                className="glass-pop rounded-2xl p-4"
                ariaLabel="Import from URL"
                onClose={() => setUrlImportOpen(false)}
              >
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
              </ViewportPopover>
            )}
          </div>
        )}

        {/* Voice & model settings popover */}
        <div ref={settingsRef} className="relative">
          <button
            ref={settingsButtonRef}
            type="button"
            onClick={() => setSettingsOpen((o) => !o)}
            aria-expanded={settingsOpen}
            aria-label="Voice settings"
            className="flex min-h-[44px] min-w-[44px] items-center gap-2 rounded-xl border border-white/50 bg-white/40 px-3 py-2 text-sm text-text-primary shadow-glass-sm backdrop-blur-md transition-all duration-200 hover:-translate-y-px hover:bg-white/60 active:translate-y-0 active:scale-[0.98]"
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
              className="glass-pop animate-scale-in origin-top-right rounded-2xl p-4"
              ariaLabel="Voice settings"
              onClose={() => setSettingsOpen(false)}
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
            </ViewportPopover>
          )}
        </div>
        </div>
      </div>

      {selectedDesktopModel && modelError && (
        <div className="flex flex-col gap-3 rounded-2xl border border-danger/20 bg-danger/[0.06] px-4 py-3 sm:flex-row sm:items-center sm:justify-between" role="status">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-text-primary">{activeModelLabel} needs setup in Reader</p>
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
          <div className="flex min-w-0 items-center gap-1">
            <button
              type="button"
              disabled={!previousSection}
              onClick={() => previousSection && handleJumpToOffset(previousSection.start)}
              aria-label="Previous reading section"
              title="Previous section (←)"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-white/45 hover:text-accent disabled:cursor-not-allowed disabled:opacity-35"
            >
              <ChevronLeft size={15} />
            </button>
            {libraryError ? (
              <p className="text-xs text-danger" role="status">{libraryError}</p>
            ) : currentChapter ? (
              <button
                type="button"
                onClick={() => setLibraryOpen(true)}
                className="block w-full max-w-full truncate text-left text-xs font-medium text-text-muted transition-colors hover:text-accent"
              >
                Chapter {currentChapter.order + 1} of {activeDocument?.chapters.length}: {currentChapter.title}
                {activeSection && activeSection.chapterSectionCount > 1
                  ? ` · Part ${activeSection.chapterSectionIndex + 1} of ${activeSection.chapterSectionCount}`
                  : ""}
              </button>
            ) : null}
            <button
              type="button"
              disabled={!nextSection}
              onClick={() => nextSection && handleJumpToOffset(nextSection.start)}
              aria-label="Next reading section"
              title="Next section (→)"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-white/45 hover:text-accent disabled:cursor-not-allowed disabled:opacity-35"
            >
              <ChevronRight size={15} />
            </button>
          </div>
          <div className="flex min-w-32 items-center gap-2 sm:w-64">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
              <div
                className="h-full rounded-full bg-accent transition-[transform] duration-300 origin-left"
                style={{ transform: `scaleX(${clamp(readingProgress / 100, 0, 1)})` }}
              />
            </div>
            <span className="w-9 text-right font-mono text-2xs text-text-muted tabular-nums">
              {Math.round(readingProgress)}%
            </span>
            {remainingLabel && (
              <span className="hidden whitespace-nowrap font-mono text-2xs text-text-muted tabular-nums md:inline">
                {remainingLabel}
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── Document ────────────────────────────────────────── */}
      <section
        className={`glass-panel relative overflow-hidden rounded-[28px] ${fullScreen ? "flex-1" : ""}`}
        style={{
          "--reader-column-width": `${readerColumnWidthRem(viewPreferences.columnWidth)}rem`,
        } as CSSProperties}
      >
        <div className={`relative ${fullScreen ? "h-full min-h-[55vh]" : "min-h-72"}`}>
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
              className={`absolute inset-0 overflow-auto text-text-primary outline-none ${documentPadding(fullScreen)} ${focusMode ? "reader-focus" : ""}`}
              style={{ fontSize: viewPreferences.fontSize, lineHeight: viewPreferences.lineHeight }}
            >
              {currentChapter && (
                <header className="mb-7 border-b border-border/50 pb-5">
                  <p className="font-mono text-2xs uppercase tracking-widest text-text-muted">
                    Chapter {currentChapter.order + 1} of {activeDocument?.chapters.length ?? 1}
                    {activeSection && activeSection.chapterSectionCount > 1
                      ? ` · Part ${activeSection.chapterSectionIndex + 1} of ${activeSection.chapterSectionCount}`
                      : ""}
                  </p>
                  <h3 className="mt-2 font-display text-[1.45em] leading-tight font-semibold text-text-primary">
                    {currentChapter.title}
                  </h3>
                </header>
              )}
              <article
                ref={readerTextRef}
                onMouseUp={handleReaderTextMouseUp}
                onDoubleClick={handleReaderTextDoubleClick}
                title="Double-click to listen from here"
                className={`${DOCUMENT_TEXT_CLASSES} reader-article`}
              >
                {paragraphs.map(({ block, parts }) => (
                  <p
                    key={`block-${block.start}`}
                    data-block-start={block.start}
                    className={block.blankLineBefore ? "reader-paragraph-spaced" : undefined}
                  >
                    {parts.map((part) => {
                      const activeClass = part.isActive
                        ? "reader-chunk-highlight reader-chunk-highlight-active"
                        : "";
                      const wordClass = part.isWordActive ? "reader-word-highlight-active" : "";
                      const className = `${activeClass} ${wordClass}`.trim();

                      return (
                        <span
                          key={`part-${part.start}`}
                          className={className || undefined}
                          data-section-index={part.sectionIndex >= 0 ? part.sectionIndex : undefined}
                          data-reader-active-word={part.isWordActive ? "true" : undefined}
                        >
                          {part.text}
                        </span>
                      );
                    })}
                  </p>
                ))}
              </article>
              {selectedPassage && (
                <button
                  type="button"
                  onClick={() => {
                    setLibraryTab("notes");
                    setLibraryOpen(true);
                  }}
                  className="sticky bottom-28 left-1/2 mt-8 -translate-x-1/2 rounded-full border border-accent/25 bg-panel/90 px-4 py-2 text-xs font-semibold text-accent shadow-glass-md backdrop-blur-xl"
                >
                  Add note to selection
                </button>
              )}
            </div>
          )}
          {followPaused && isPlaying && !editing && (
            <button
              type="button"
              onClick={resumeFollowing}
              className="absolute bottom-5 left-1/2 z-10 -translate-x-1/2 rounded-full border border-accent/25 bg-panel/90 px-4 py-2 text-xs font-semibold text-accent shadow-glass-md backdrop-blur-xl transition-transform active:scale-[0.98]"
            >
              Resume auto-follow
            </button>
          )}
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
