import { memo } from "react";
import { READER_HIGHLIGHT_SWATCHES } from "./readerHighlightColors";
import type { OverlayPart, TextBlock } from "./readerTextLayout";

interface ReaderParagraphProps {
  block: TextBlock;
  parts: OverlayPart[];
  /** Absolute offsets of the spoken word, or -1 when it is not in this block. */
  wordStart: number;
  wordEnd: number;
  /** The chapter's own title line, drawn as the chapter heading. */
  heading?: boolean;
  /** This paragraph is the reading pane's one tab stop; the rest focus by script. */
  tabStop?: boolean;
  /** Id of the hint describing the paragraph's keyboard actions. */
  describedBy?: string;
}

// A still wash: a breathing highlight kept moving in the corner of the eye
// for the whole of every passage.
function overlayPartClassName(isActive: boolean): string | undefined {
  return isActive ? "reader-chunk-highlight reader-chunk-highlight-active" : undefined;
}

/**
 * One paragraph of the reading pane. Memoised on its own parts plus the word
 * offsets, so a word advancing re-renders only the paragraph containing it —
 * the rest of a chapter's spans stay untouched between sections.
 */
export const ReaderParagraph = memo(function ReaderParagraph({
  block,
  parts,
  wordStart,
  wordEnd,
  heading = false,
  tabStop = false,
  describedBy,
}: ReaderParagraphProps) {
  const layoutClassName = heading
    ? "reader-chapter-heading"
    : block.blankLineBefore ? "reader-paragraph-spaced" : "";
  return (
    <p
      data-block-start={block.start}
      role={heading ? "heading" : undefined}
      aria-level={heading ? 3 : undefined}
      tabIndex={tabStop ? 0 : -1}
      aria-describedby={describedBy}
      className={`${layoutClassName} rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent/50`}
    >
      {parts.map((part) => {
        const className = overlayPartClassName(part.isActive);
        // A highlight's wash outranks the spoken passage's, so the colour holds
        // while the passage is read; the word marker keeps its own look.
        const highlight = part.highlight;
        const style = highlight ? READER_HIGHLIGHT_SWATCHES[highlight].wash : undefined;
        const partEnd = part.start + part.text.length;
        const overlaps = wordStart >= 0 && wordStart < partEnd && wordEnd > part.start;

        if (!overlaps) {
          return (
            <span key={`part-${part.start}`} className={className} style={style} data-highlight={highlight}>
              {part.text}
            </span>
          );
        }

        // Split around the spoken word rather than re-deriving every span in the
        // section from scratch. Auto-follow looks for the
        // reader-word-highlight-active element, so it must stay in the DOM.
        const localStart = Math.max(0, wordStart - part.start);
        const localEnd = Math.min(part.text.length, wordEnd - part.start);
        const before = part.text.slice(0, localStart);
        const word = part.text.slice(localStart, localEnd);
        const after = part.text.slice(localEnd);
        const wordClassName = className
          ? `${className} reader-word-highlight-active`
          : "reader-word-highlight-active";

        return [
          before && (
            <span key={`part-${part.start}`} className={className} style={style} data-highlight={highlight}>
              {before}
            </span>
          ),
          word && (
            <span
              key={`word-${part.start + localStart}`}
              className={wordClassName}
              data-reader-active-word="true"
              data-highlight={highlight}
            >
              {word}
            </span>
          ),
          after && (
            <span key={`tail-${part.start + localEnd}`} className={className} style={style} data-highlight={highlight}>
              {after}
            </span>
          ),
        ];
      })}
    </p>
  );
});
