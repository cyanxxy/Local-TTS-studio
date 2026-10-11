import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import type { AudioSegment } from "../../hooks/useAudioPlayer";
import type { PlaybackClock } from "../../lib/playbackClock";
import type { ReaderHighlightColor } from "../../lib/readerDocument";
import { ReaderParagraph } from "./ReaderParagraph";
import { ReaderSelectionToolbar, type SelectedPassage } from "./ReaderSelectionToolbar";
import { normalizeQuote, readArticleSelection } from "./readerSelection";
import {
  buildOverlayParts,
  groupPartsByBlock,
  type HighlightRange,
  type TextBlock,
  type TextRange,
} from "./readerTextLayout";
import { useReaderWordTracking } from "./useReaderWordTracking";

/** A saved highlight that marks this section, in section-local offsets. */
export interface SectionHighlight extends HighlightRange {
  id: string;
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

interface ReaderTextPaneProps {
  readingTextId: string;
  fullScreen: boolean;
  fontSize: number;
  lineHeight: number;
  /** Dim everything but the spoken passage while audio plays. */
  focusMode: boolean;
  text: string;
  blocks: TextBlock[];
  /** Section-local range of the passage being spoken. */
  activeRange: TextRange | null;
  highlights: readonly SectionHighlight[];
  /** Document offset of the section, for mapping selections back to the book. */
  sectionStart: number;
  /** Shown above the text when the chapter does not open with its own title line. */
  chapterHeading: { title: string; continued: boolean } | null;
  /** Offset of the first block when that block is the chapter's own title line. */
  headingBlockStart: number | null;
  clock: PlaybackClock;
  activeSegment: AudioSegment | null;
  estimatedWordTrackingStable: boolean;
  isPlaying: boolean;
  editing: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onDraftCommit: () => void;
  /** Double-click in the editor seeks to the section-local offset under the caret. */
  onEditorSeek: (localOffset: number) => void;
  onStartEditing: () => void;
  scrollerRef: RefObject<HTMLDivElement | null>;
  articleRef: RefObject<HTMLElement | null>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  followPaused: boolean;
  onScroll: () => void;
  onResumeFollow: () => void;
  scrollMarkerIntoView: () => void;
  selectedPassage: SelectedPassage | null;
  onSelectPassage: (passage: SelectedPassage | null) => void;
  /** Starts listening from a document offset. */
  onListenFrom: (documentOffset: number) => void;
  onBookmarkPassage?: (passage: SelectedPassage) => void;
  onNotePassage: () => void;
  /**
   * Highlights the passage in a colour; `highlightId` names the highlight the
   * selection already lies in, which the colour should go to instead.
   */
  onHighlightPassage?: (passage: SelectedPassage, color: ReaderHighlightColor, highlightId?: string) => void;
  onRemoveHighlight?: (highlightId: string) => void;
}

/**
 * The reading pane: the section as selectable paragraphs (or the section
 * editor), the spoken-word highlight, auto-follow and the selection toolbar.
 * It is the only part of the Reader that subscribes to the spoken word, so a
 * word advancing re-renders this pane — and within it only the paragraph that
 * holds the word — instead of the whole page.
 */
export const ReaderTextPane = memo(function ReaderTextPane({
  readingTextId,
  fullScreen,
  fontSize,
  lineHeight,
  focusMode,
  text,
  blocks,
  activeRange,
  highlights,
  sectionStart,
  chapterHeading,
  headingBlockStart,
  clock,
  activeSegment,
  estimatedWordTrackingStable,
  isPlaying,
  editing,
  draft,
  onDraftChange,
  onDraftCommit,
  onEditorSeek,
  onStartEditing,
  scrollerRef,
  articleRef,
  textareaRef,
  followPaused,
  onScroll,
  onResumeFollow,
  scrollMarkerIntoView,
  selectedPassage,
  onSelectPassage,
  onListenFrom,
  onBookmarkPassage,
  onNotePassage,
  onHighlightPassage,
  onRemoveHighlight,
}: ReaderTextPaneProps) {
  const { wordIndex, wordRange } = useReaderWordTracking(clock, activeSegment, estimatedWordTrackingStable);
  const paragraphs = useMemo(
    () => groupPartsByBlock(blocks, buildOverlayParts(text, blocks, activeRange, highlights)),
    [activeRange, blocks, highlights, text],
  );
  // The highlight a selection lies in takes the colour picked for it, the way
  // the page shows the innermost highlight where several overlap.
  const selectionHighlight = useMemo(() => {
    if (!selectedPassage) return undefined;
    const start = selectedPassage.textOffset - sectionStart;
    const end = selectedPassage.endOffset - sectionStart;
    let found: SectionHighlight | undefined;
    for (const highlight of highlights) {
      if (highlight.start > start || highlight.end < end) continue;
      if (!found || highlight.start > found.start || (highlight.start === found.start && highlight.end < found.end)) {
        found = highlight;
      }
    }
    return found;
  }, [highlights, sectionStart, selectedPassage]);

  useEffect(() => {
    if (!isPlaying || followPaused) return;
    scrollMarkerIntoView();
  }, [activeRange, followPaused, isPlaying, scrollMarkerIntoView, wordIndex]);

  const clearDomSelection = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    onSelectPassage(null);
  }, [onSelectPassage]);

  const handleMouseUp = useCallback((event: ReactMouseEvent) => {
    // The second mouseup of a double-click lands after the browser has selected
    // the word under the cursor, which would flash the note pill for a frame
    // before `dblclick` seeks and clears it. Only a deliberate drag opens it.
    if (event.detail > 1 || !articleRef.current) return;
    const selection = readArticleSelection(articleRef.current, text.length);
    if (!selection) return;
    if (!selection.collapsed) {
      const quote = normalizeQuote(selection.quote);
      if (quote) {
        onSelectPassage({
          quote,
          textOffset: sectionStart + selection.start,
          endOffset: sectionStart + selection.end,
        });
      }
      return;
    }
    // A plain click only dismisses the note pill — seeking is double-click.
    onSelectPassage(null);
  }, [articleRef, onSelectPassage, sectionStart, text.length]);

  const handleDoubleClick = useCallback(() => {
    if (!articleRef.current) return;
    const selection = readArticleSelection(articleRef.current, text.length);
    if (!selection) return;
    clearDomSelection();
    onListenFrom(sectionStart + selection.start);
  }, [articleRef, clearDomSelection, onListenFrom, sectionStart, text.length]);

  const handleListen = useCallback((passage: SelectedPassage) => {
    clearDomSelection();
    onListenFrom(passage.textOffset);
  }, [clearDomSelection, onListenFrom]);

  const handleBookmark = useCallback((passage: SelectedPassage) => {
    onBookmarkPassage?.(passage);
    clearDomSelection();
  }, [clearDomSelection, onBookmarkPassage]);

  const handleHighlight = useCallback((passage: SelectedPassage, color: ReaderHighlightColor) => {
    onHighlightPassage?.(passage, color, selectionHighlight?.id);
    clearDomSelection();
  }, [clearDomSelection, onHighlightPassage, selectionHighlight]);

  const handleRemoveHighlight = useCallback(() => {
    if (selectionHighlight) onRemoveHighlight?.(selectionHighlight.id);
    clearDomSelection();
  }, [clearDomSelection, onRemoveHighlight, selectionHighlight]);

  const textStyle = { fontSize, lineHeight };

  return (
    <div className={`relative ${fullScreen ? "min-h-[55vh] flex-1" : "min-h-72"}`}>
      {editing ? (
        <textarea
          id={readingTextId}
          ref={textareaRef}
          aria-label="Reading Text"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onBlur={onDraftCommit}
          onScroll={onScroll}
          onDoubleClick={(event) => onEditorSeek(event.currentTarget.selectionStart)}
          placeholder="Type or paste text for this reading section…"
          className={`absolute inset-0 h-full w-full resize-none overflow-auto bg-transparent text-text-primary caret-text-primary placeholder:font-sans placeholder:text-text-muted focus:outline-none ${DOCUMENT_TEXT_CLASSES} ${documentPadding(fullScreen)}`}
          style={textStyle}
        />
      ) : (
        <div
          id={readingTextId}
          ref={scrollerRef}
          role="document"
          aria-label="Reading Text"
          tabIndex={0}
          onScroll={onScroll}
          className={`absolute inset-0 overflow-auto text-text-primary outline-none ${documentPadding(fullScreen)} ${fullScreen ? "reader-scroll-edge" : ""} ${focusMode ? "reader-focus" : ""}`}
          style={textStyle}
        >
          {/* A chapter opens like a printed chapter opens; the parts after
              it pick up mid-flow with a quiet continuation marker instead
              of restating the title at full size. */}
          {chapterHeading && (chapterHeading.continued ? (
            <p className="mb-6 truncate font-mono text-xs text-text-secondary">
              {chapterHeading.title} · continued
            </p>
          ) : (
            <header className="mb-7 border-b border-border/50 pb-5">
              <h3 className="font-display text-[1.45em] leading-tight font-semibold text-text-primary">
                {chapterHeading.title}
              </h3>
            </header>
          ))}
          <article
            ref={articleRef}
            onMouseUp={handleMouseUp}
            onDoubleClick={handleDoubleClick}
            title="Double-click to listen from here"
            className={`${DOCUMENT_TEXT_CLASSES} reader-article`}
          >
            {paragraphs.map(({ block, parts }) => {
              // Hand the word offsets only to the paragraph that contains
              // them; every other paragraph keeps its memoised output.
              const holdsWord = wordRange !== null
                && wordRange.start < block.end
                && wordRange.end > block.start;
              return (
                <ReaderParagraph
                  key={`block-${block.start}`}
                  block={block}
                  parts={parts}
                  wordStart={holdsWord ? wordRange.start : -1}
                  wordEnd={holdsWord ? wordRange.end : -1}
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
                onClick={onStartEditing}
                className="mt-3 rounded-xl border border-border bg-text-primary/[0.04] px-3 py-2 text-sm font-medium text-text-primary transition-all duration-200 hover:bg-text-primary/[0.07] hover:text-accent active:scale-[0.98]"
              >
                Add text
              </button>
            </div>
          )}
          {selectedPassage && (
            <ReaderSelectionToolbar
              passage={selectedPassage}
              onListen={handleListen}
              onBookmark={onBookmarkPassage ? handleBookmark : undefined}
              onNote={onNotePassage}
              onHighlight={onHighlightPassage ? handleHighlight : undefined}
              currentHighlight={selectionHighlight?.color}
              onRemoveHighlight={selectionHighlight && onRemoveHighlight ? handleRemoveHighlight : undefined}
              onDismiss={clearDomSelection}
            />
          )}
        </div>
      )}
      {followPaused && isPlaying && !editing && (
        <button
          type="button"
          onClick={onResumeFollow}
          className="absolute bottom-5 left-1/2 z-10 -translate-x-1/2 glass rounded-full px-4 py-2 text-xs font-semibold text-accent transition-transform active:scale-[0.98]"
        >
          Resume auto-follow
        </button>
      )}
    </div>
  );
});
