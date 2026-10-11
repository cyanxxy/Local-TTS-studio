import { BookmarkPlus, Eraser, NotebookPen, Play, X } from "lucide-react";
import { READER_HIGHLIGHT_COLORS, type ReaderHighlightColor } from "../../lib/readerDocument";
import { READER_HIGHLIGHT_SWATCHES } from "./readerHighlightColors";

export interface SelectedPassage {
  quote: string;
  /** Document offsets of the selection, end exclusive. */
  textOffset: number;
  endOffset: number;
}

const ACTION_BUTTON = "flex items-center gap-1.5 rounded-full px-3 py-1.5 transition-colors hover:bg-accent-light";
const ICON_BUTTON = "flex h-7 w-7 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-accent-light hover:text-accent";

interface ReaderSelectionToolbarProps {
  passage: SelectedPassage;
  onListen: (passage: SelectedPassage) => void;
  /** Absent when bookmarks cannot be saved. */
  onBookmark?: (passage: SelectedPassage) => void;
  onNote: () => void;
  /** Absent when highlights cannot be saved. */
  onHighlight?: (passage: SelectedPassage, color: ReaderHighlightColor) => void;
  /** Colour of the highlight the selection lies in; picking a colour then recolours it. */
  currentHighlight?: ReaderHighlightColor;
  /** Present when the selection lies in a highlight that can be removed. */
  onRemoveHighlight?: () => void;
  onDismiss: () => void;
}

/** Actions for a passage selected in the reading pane, pinned near the dock. */
export function ReaderSelectionToolbar({
  passage,
  onListen,
  onBookmark,
  onNote,
  onHighlight,
  currentHighlight,
  onRemoveHighlight,
  onDismiss,
}: ReaderSelectionToolbarProps) {
  return (
    <div
      role="toolbar"
      aria-label="Selected passage"
      className="sticky bottom-44 left-1/2 mt-8 flex w-max max-w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 flex-wrap items-center justify-center gap-0.5 glass rounded-[22px] p-1 font-sans text-xs font-semibold text-accent"
    >
      {onHighlight && (
        <div
          role="group"
          aria-label={currentHighlight ? "Change highlight colour" : "Highlight"}
          className="flex items-center gap-0.5 px-1"
        >
          {READER_HIGHLIGHT_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={`${READER_HIGHLIGHT_SWATCHES[color].label} highlight`}
              aria-pressed={currentHighlight === undefined ? undefined : currentHighlight === color}
              onClick={() => onHighlight(passage, color)}
              className={`flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-accent-light ${
                currentHighlight === color ? "bg-accent-light" : ""
              }`}
            >
              <span
                aria-hidden
                className="h-3.5 w-3.5 rounded-full ring-1 ring-black/10"
                style={{ backgroundColor: READER_HIGHLIGHT_SWATCHES[color].swatch }}
              />
            </button>
          ))}
          {onRemoveHighlight && (
            <button type="button" aria-label="Remove highlight" onClick={onRemoveHighlight} className={ICON_BUTTON}>
              <Eraser size={12} aria-hidden />
            </button>
          )}
        </div>
      )}
      <button type="button" onClick={() => onListen(passage)} className={ACTION_BUTTON}>
        <Play size={12} aria-hidden />
        Listen from here
      </button>
      {onBookmark && (
        <button type="button" onClick={() => onBookmark(passage)} className={ACTION_BUTTON}>
          <BookmarkPlus size={12} aria-hidden />
          Bookmark
        </button>
      )}
      <button type="button" aria-label="Add note to selection" onClick={onNote} className={ACTION_BUTTON}>
        <NotebookPen size={12} aria-hidden />
        Note
      </button>
      <button type="button" aria-label="Dismiss" onClick={onDismiss} className={ICON_BUTTON}>
        <X size={12} />
      </button>
    </div>
  );
}
