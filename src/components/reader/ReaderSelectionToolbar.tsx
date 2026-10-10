import { BookmarkPlus, NotebookPen, Play, X } from "lucide-react";

export interface SelectedPassage {
  quote: string;
  /** Document offset where the selection starts. */
  textOffset: number;
}

const ACTION_BUTTON = "flex items-center gap-1.5 rounded-full px-3 py-1.5 transition-colors hover:bg-accent-light";

interface ReaderSelectionToolbarProps {
  passage: SelectedPassage;
  onListen: (passage: SelectedPassage) => void;
  /** Absent when bookmarks cannot be saved. */
  onBookmark?: (passage: SelectedPassage) => void;
  onNote: () => void;
  onDismiss: () => void;
}

/** Actions for a passage selected in the reading pane, pinned near the dock. */
export function ReaderSelectionToolbar({
  passage,
  onListen,
  onBookmark,
  onNote,
  onDismiss,
}: ReaderSelectionToolbarProps) {
  return (
    <div
      role="toolbar"
      aria-label="Selected passage"
      className="sticky bottom-44 left-1/2 mt-8 flex w-max -translate-x-1/2 items-center gap-0.5 glass rounded-full p-1 font-sans text-xs font-semibold text-accent"
    >
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
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="flex h-7 w-7 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-accent-light hover:text-accent"
      >
        <X size={12} />
      </button>
    </div>
  );
}
