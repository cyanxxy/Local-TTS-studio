import {
  isReaderHighlightAnchored,
  READER_HIGHLIGHT_COLORS,
  type ReaderHighlight,
  type ReaderHighlightColor,
} from "../../lib/readerDocument";
import { READER_HIGHLIGHT_SWATCHES } from "./readerHighlightColors";

interface ReaderHighlightListProps {
  text: string;
  highlights: readonly ReaderHighlight[];
  onJumpToOffset: (offset: number) => void;
  /** Absent when highlights cannot be recoloured. */
  onUpdateHighlight?: (id: string, patch: { color: ReaderHighlightColor }) => void;
  /** Absent when highlights cannot be removed. */
  onRemoveHighlight?: (id: string) => void;
}

/** The book's highlights in reading order, each one a jump back to its passage. */
export function ReaderHighlightList({
  text,
  highlights,
  onJumpToOffset,
  onUpdateHighlight,
  onRemoveHighlight,
}: ReaderHighlightListProps) {
  return (
    <section aria-label="Highlights" className="space-y-2">
      <p className="text-xs font-semibold text-text-secondary">Highlights</p>
      {highlights.map((highlight) => {
        const swatch = READER_HIGHLIGHT_SWATCHES[highlight.color];
        // An edit can leave a highlight's words nowhere to be found; it stays
        // listed (and exported) but there is no passage to jump to.
        const anchored = isReaderHighlightAnchored(text, highlight);
        const truncated = highlight.end - highlight.start > highlight.quote.length;
        const quote = (
          <span className="line-clamp-3 text-xs leading-5 text-text-secondary">
            {highlight.quote}{truncated ? "…" : ""}
          </span>
        );
        return (
          <div
            key={highlight.id}
            className="rounded-2xl border border-border bg-text-primary/[0.03] p-3"
            style={{ boxShadow: `inset 3px 0 0 ${swatch.swatch}` }}
          >
            {anchored ? (
              <button
                type="button"
                onClick={() => onJumpToOffset(highlight.start)}
                className="block w-full pl-1 text-left active:scale-[0.99]"
              >
                {quote}
              </button>
            ) : (
              <p className="pl-1 opacity-70">
                {quote}
                <span className="mt-1 block text-2xs text-text-muted">This passage was edited away.</span>
              </p>
            )}
            {(onUpdateHighlight || onRemoveHighlight) && (
              <div className="mt-2 flex items-center gap-1 pl-1">
                {onUpdateHighlight && READER_HIGHLIGHT_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    aria-label={`${READER_HIGHLIGHT_SWATCHES[color].label} highlight`}
                    aria-pressed={highlight.color === color}
                    onClick={() => {
                      if (highlight.color !== color) onUpdateHighlight(highlight.id, { color });
                    }}
                    className={`flex h-6 w-6 items-center justify-center rounded-full transition-colors hover:bg-text-primary/[0.07] ${
                      highlight.color === color ? "bg-text-primary/[0.07]" : ""
                    }`}
                  >
                    <span
                      aria-hidden
                      className="h-3 w-3 rounded-full ring-1 ring-black/10"
                      style={{ backgroundColor: READER_HIGHLIGHT_SWATCHES[color].swatch }}
                    />
                  </button>
                ))}
                {onRemoveHighlight && (
                  <button
                    type="button"
                    onClick={() => onRemoveHighlight(highlight.id)}
                    className="ml-auto text-2xs text-text-muted hover:text-danger"
                  >
                    Remove
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
