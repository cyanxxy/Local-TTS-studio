/**
 * Pure text-layout helpers for the Reader's reading pane. Everything here maps
 * section text to paragraph blocks and styled spans by character offset, so the
 * DOM can always be mapped back to exact text offsets.
 */

export interface TextBlock {
  start: number;
  end: number;
  blankLineBefore: boolean;
}

export interface OverlayPart {
  text: string;
  start: number;
  isActive: boolean;
}

export interface ParagraphParts {
  block: TextBlock;
  parts: OverlayPart[];
}

export interface TextRange {
  start: number;
  end: number;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Splits section text into paragraph blocks, one per non-empty line. Newline
 * separators live between blocks and are never rendered as glyphs; every block
 * records its character offset so DOM positions map back to text offsets.
 */
export function splitTextBlocks(text: string): TextBlock[] {
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

/**
 * Splits the source text into contiguous spans aligned to paragraph blocks and
 * the active range. Spans carry only background styling (tint + highlight), never
 * inline content, so the overlay stays glyph-for-glyph identical to the textarea
 * beneath it — keeping the caret, highlights, and scrolling in sync.
 *
 * Only the spoken range gets its own span: chunk boundaries are invisible to the
 * reader, so splitting on them would cost dozens to hundreds of identical spans
 * per section for no pixel difference.
 *
 * Deliberately independent of the spoken word: the word moves several times a
 * second and splitting on it here would rebuild every span in the section each
 * time. The word highlight is applied per paragraph at render time instead.
 */
export function buildOverlayParts(
  text: string,
  blocks: readonly TextBlock[],
  activeRange: TextRange | null,
): OverlayPart[] {
  if (!text) return [];

  const offsets = new Set<number>([0, text.length]);
  for (const block of blocks) {
    offsets.add(block.start);
    offsets.add(block.end);
  }
  if (activeRange) {
    offsets.add(clamp(activeRange.start, 0, text.length));
    offsets.add(clamp(activeRange.end, 0, text.length));
  }

  const sorted = [...offsets].sort((a, b) => a - b);
  const parts: OverlayPart[] = [];

  for (let i = 0; i < sorted.length - 1; i++) {
    const partStart = sorted[i];
    const partEnd = sorted[i + 1];

    const isActive = activeRange
      ? partStart >= activeRange.start && partEnd <= activeRange.end
      : false;

    parts.push({
      text: text.slice(partStart, partEnd),
      start: partStart,
      isActive,
    });
  }

  return parts;
}

/**
 * Hands every overlay part to the paragraph block that contains it. Parts that
 * fall between blocks are newline separators; they carry no glyphs and are
 * dropped.
 */
export function groupPartsByBlock(
  blocks: readonly TextBlock[],
  parts: readonly OverlayPart[],
): ParagraphParts[] {
  const groups = blocks.map((block) => ({ block, parts: [] as OverlayPart[] }));
  let blockIndex = 0;
  for (const part of parts) {
    while (blockIndex < blocks.length && part.start >= blocks[blockIndex].end) {
      blockIndex += 1;
    }
    if (blockIndex >= blocks.length) break;
    if (part.start >= blocks[blockIndex].start) groups[blockIndex].parts.push(part);
  }
  return groups;
}

/**
 * Imported chapters usually open with their own title line. When the first
 * block of a chapter's opening section repeats the chapter title (ignoring a
 * Markdown heading marker and letter case), that block is drawn as the heading
 * instead of adding a second copy above it.
 */
export function chapterHeadingBlockStart(
  text: string,
  firstBlock: TextBlock | undefined,
  chapterTitle: string,
): number | null {
  if (!firstBlock) return null;
  const line = text.slice(firstBlock.start, firstBlock.end).replace(/^\s{0,3}#{1,6}\s+/, "").trim();
  return line.localeCompare(chapterTitle, undefined, { sensitivity: "accent" }) === 0
    ? firstBlock.start
    : null;
}
