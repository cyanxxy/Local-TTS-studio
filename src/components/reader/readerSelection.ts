import { clamp } from "./readerTextLayout";

export interface ArticleSelection {
  /** Section-local offsets of the selection, end exclusive. */
  start: number;
  end: number;
  collapsed: boolean;
  /** The selected text as the browser serialises it. */
  quote: string;
}

function blockStart(paragraph: HTMLElement): number {
  return Number(paragraph.dataset.blockStart);
}

/**
 * Maps a DOM position inside the reading article back to a section-local
 * offset. Paragraph elements carry their block's character offset, so the
 * prefix length inside the containing paragraph plus that offset is exact even
 * though newline glyphs are never rendered.
 */
function articleOffset(root: HTMLElement, container: Node, offset: number): number | null {
  if (container === root) {
    // Between paragraphs, where a triple-click leaves the end of its range:
    // the end of the paragraph before, or the start of the first one.
    const before = root.childNodes[offset - 1];
    if (before instanceof HTMLElement && before.dataset.blockStart !== undefined) {
      return blockStart(before) + (before.textContent?.length ?? 0);
    }
    const first = root.childNodes[0];
    return offset === 0 && first instanceof HTMLElement && first.dataset.blockStart !== undefined
      ? blockStart(first)
      : null;
  }
  const element = container instanceof Element ? container : container.parentElement;
  const paragraph = element?.closest<HTMLElement>("[data-block-start]");
  if (!paragraph || !root.contains(paragraph)) return null;
  const prefix = document.createRange();
  prefix.selectNodeContents(paragraph);
  prefix.setEnd(container, offset);
  return blockStart(paragraph) + prefix.toString().length;
}

/** The current document selection, if it lies inside the reading article. */
export function readArticleSelection(root: HTMLElement, textLength: number): ArticleSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const start = articleOffset(root, range.startContainer, range.startOffset);
  if (start === null) return null;
  const end = range.collapsed ? start : articleOffset(root, range.endContainer, range.endOffset) ?? start;
  return {
    start: clamp(start, 0, textLength),
    end: clamp(Math.max(start, end), 0, textLength),
    collapsed: selection.isCollapsed,
    quote: selection.toString(),
  };
}

/** Collapses the quote's whitespace and caps it, the way notes store quotes. */
export function normalizeQuote(quote: string): string {
  return quote.trim().replace(/\s+/g, " ").slice(0, 500);
}
