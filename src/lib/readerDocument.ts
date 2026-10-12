import type { GenerationTuningSettings } from "../types";

export type ReaderDocumentSourceType = "text" | "file" | "epub" | "url";

export interface ReaderChapter {
  id: string;
  title: string;
  order: number;
  start: number;
  end: number;
  level: number;
}

/**
 * A bounded playback/rendering window inside a real book chapter. Reader
 * sections are derived, not persisted: chapter metadata remains the canonical
 * table of contents while unusually large chapters stay cheap to render and
 * synthesize.
 */
export interface ReaderSection {
  id: string;
  chapterId: string;
  order: number;
  chapterSectionIndex: number;
  chapterSectionCount: number;
  start: number;
  end: number;
}

export interface ReaderProgress {
  positionSec: number;
  totalDurationSec: number;
  textOffset: number;
  chapterId: string | null;
  sectionId: string | null;
  percent: number;
  updatedAt: number;
}

export interface ReaderBookmark {
  id: string;
  label: string;
  textOffset: number;
  chapterId: string | null;
  sectionId: string | null;
  positionSec: number;
  createdAt: number;
}

export interface ReaderNote {
  id: string;
  text: string;
  quote: string;
  textOffset: number;
  chapterId: string | null;
  sectionId: string | null;
  createdAt: number;
  updatedAt: number;
}

export const READER_HIGHLIGHT_COLORS = ["yellow", "green", "blue", "pink", "purple"] as const;
export type ReaderHighlightColor = (typeof READER_HIGHLIGHT_COLORS)[number];

/** Long highlights keep only this much of their text as the re-anchoring quote. */
export const READER_HIGHLIGHT_QUOTE_LIMIT = 2_000;

export interface ReaderHighlight {
  id: string;
  /** Document offsets of the highlighted range, end exclusive. */
  start: number;
  end: number;
  color: ReaderHighlightColor;
  /**
   * The highlighted text (capped) as it read when highlighted. While the book
   * text at `start` still reads this way the range is anchored; otherwise it
   * is looked up again, so an edit that moved the passage cannot leave the
   * colour over different words.
   */
  quote: string;
  createdAt: number;
  updatedAt: number;
}

/** Largest cover image kept in a record, as a base64 data URL. */
export const READER_COVER_MAX_DATA_URL_CHARS = 384 * 1024;
const READER_COVER_DATA_URL = /^data:image\/(?:jpeg|png|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

export interface ReaderDocumentCover {
  /** A base64 `data:image/...` URL of a raster image. */
  dataUrl: string;
}

export function isReaderDocumentCover(value: unknown): value is ReaderDocumentCover {
  if (typeof value !== "object" || value === null) return false;
  const { dataUrl } = value as Partial<ReaderDocumentCover>;
  return typeof dataUrl === "string"
    && dataUrl.length <= READER_COVER_MAX_DATA_URL_CHARS
    && READER_COVER_DATA_URL.test(dataUrl);
}

export interface ReaderDocumentRecord {
  id: string;
  title: string;
  author: string;
  description: string;
  language: string;
  sourceType: ReaderDocumentSourceType;
  sourceName: string;
  sourceUrl: string;
  text: string;
  chapters: ReaderChapter[];
  progress: ReaderProgress;
  bookmarks: ReaderBookmark[];
  notes: ReaderNote[];
  /** Absent on records saved before highlights existed. */
  highlights?: ReaderHighlight[];
  /** The book's cover, when its source had one. */
  cover?: ReaderDocumentCover;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
}

export interface ReaderDocumentInput {
  id?: string;
  title?: string;
  author?: string;
  description?: string;
  language?: string;
  sourceType?: ReaderDocumentSourceType;
  sourceName?: string;
  sourceUrl?: string;
  text: string;
  chapters?: ReaderChapter[];
  cover?: ReaderDocumentCover;
  now?: number;
}

export interface CachedReaderAudioChunk {
  audio: ArrayBuffer;
  samplingRate: number;
  text: string;
  index: number;
  total: number;
  textStart?: number;
  textEnd?: number;
  pauseAfterSec?: number;
  pauseKind?: "none" | "comma" | "sentence" | "paragraph";
}

export interface CachedReaderAudio {
  cacheKey: string;
  documentId: string;
  chapterId: string;
  sectionId: string;
  signature: string;
  chunks: CachedReaderAudioChunk[];
  byteLength: number;
  currentTime: number;
  playbackRate: number;
  totalDuration: number;
  /** Legacy entries lack this flag and must be treated as potentially partial. */
  synthesisComplete?: boolean;
  updatedAt: number;
}

export const READER_SECTION_TARGET_CHARS = 8_000;
export const READER_SECTION_MIN_CHARS = 4_000;
export const READER_SECTION_MAX_CHARS = 12_000;

export { estimateWordRanges, type EstimatedWordRange } from "./text/wordTiming";

function createId(prefix: string): string {
  const randomId = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${randomId}`;
}

export function normalizeReaderText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

/**
 * Rejoins lines that a PDF or OCR layout broke mid-sentence. Every line is
 * otherwise a paragraph in the Reader and a sentence boundary for speech, so
 * "discuss the\nproposal" would be drawn and spoken as two fragments. A line
 * is joined to the next only when it clearly continues: it lacks closing
 * punctuation and the next line starts in lowercase, or it ends in a comma or
 * a hyphenated word break. Headings and list items keep their own lines.
 */
export function unwrapHardLineBreaks(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/(\n{2,})/)
    .map((block) => {
      if (block.startsWith("\n")) return block;
      const lines = block.split("\n");
      let result = lines[0] ?? "";
      for (const line of lines.slice(1)) {
        const previous = result.trimEnd();
        const next = line.trimStart();
        const nextIsListItem = /^([-*•]|\d+[.)])\s/.test(next);
        const hyphenBreak = /\p{L}-$/u.test(previous) && /^\p{Ll}/u.test(next);
        const continues = !nextIsListItem && next.length > 0 && (
          hyphenBreak
          || /[,;–—]$/.test(previous)
          || (!/[.!?:…"'”’)\]]$/.test(previous) && /^[\p{Ll}\d(“"‘']/u.test(next))
        );
        if (!continues) {
          result += `\n${line}`;
        } else if (hyphenBreak) {
          result = `${previous.slice(0, -1)}${next}`;
        } else {
          result = `${previous} ${next}`;
        }
      }
      return result;
    })
    .join("");
}

/** Normalize only newly edited section content without touching its outer book. */
export function normalizeReaderTextFragment(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n");
}

function cleanTitle(value: string): string {
  return value
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s*(?:chapter|part)\s+/i, (match) => match.trimEnd() + " ")
    .trim()
    .slice(0, 160);
}

export function deriveDocumentTitle(text: string, fallback = "Untitled document"): string {
  const firstMeaningfulLine = normalizeReaderText(text)
    .split("\n")
    .map((line) => cleanTitle(line))
    .find((line) => line.length >= 2 && line.length <= 160);
  return firstMeaningfulLine || fallback;
}

interface HeadingMatch {
  title: string;
  level: number;
  start: number;
}

function findTextHeadings(text: string): HeadingMatch[] {
  const headings: HeadingMatch[] = [];
  let cursor = 0;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const markdown = trimmed.match(/^(#{1,6})\s+(.+)$/);
    const chapterLike = trimmed.match(/^(chapter|part|book|section)\s+(?:[\divxlcdm]+|[\w-]+)(?:\s*[:—-]\s*.+)?$/i);
    const shortUppercase = trimmed.length >= 3
      && trimmed.length <= 80
      && /[A-Z]/.test(trimmed)
      && trimmed === trimmed.toUpperCase()
      && !/[.!?]$/.test(trimmed);

    if (markdown) {
      headings.push({ title: cleanTitle(markdown[2]), level: markdown[1].length, start: cursor });
    } else if (chapterLike) {
      headings.push({ title: cleanTitle(trimmed), level: 1, start: cursor });
    } else if (shortUppercase) {
      headings.push({ title: cleanTitle(trimmed), level: 2, start: cursor });
    }

    cursor += line.length + 1;
  }

  return headings;
}

function uniqueChapterId(title: string, order: number): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return `chapter-${order + 1}-${slug || "section"}`;
}

export function structureTextChapters(text: string, documentTitle: string): ReaderChapter[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (!normalized.trim()) return [];

  const headings = findTextHeadings(normalized);
  if (headings.length === 0) {
    return [{
      id: uniqueChapterId(documentTitle, 0),
      title: documentTitle,
      order: 0,
      start: 0,
      end: normalized.length,
      level: 1,
    }];
  }

  const starts: HeadingMatch[] = headings[0].start > 0
    ? [{ title: "Introduction", level: 1, start: 0 }, ...headings]
    : headings;

  return starts.map((heading, order) => ({
    id: uniqueChapterId(heading.title, order),
    title: heading.title,
    order,
    start: heading.start,
    end: starts[order + 1]?.start ?? normalized.length,
    level: heading.level,
  }));
}

export function normalizeReaderChapters(
  text: string,
  chapters: readonly Omit<ReaderChapter, "order" | "id">[] | readonly ReaderChapter[],
  documentTitle: string,
): ReaderChapter[] {
  const valid = chapters
    .map((chapter) => ({
      ...chapter,
      start: Math.max(0, Math.min(text.length, Math.floor(chapter.start))),
      end: Math.max(0, Math.min(text.length, Math.floor(chapter.end))),
    }))
    .filter((chapter) => chapter.end > chapter.start)
    .sort((a, b) => a.start - b.start)
    .filter((chapter, index, sorted) => index === 0 || chapter.start > sorted[index - 1].start);

  if (valid.length === 0) return structureTextChapters(text, documentTitle);

  return valid.map((chapter, order) => ({
    id: "id" in chapter && chapter.id ? chapter.id : uniqueChapterId(chapter.title, order),
    title: cleanTitle(chapter.title) || `Chapter ${order + 1}`,
    order,
    start: order === 0 ? 0 : chapter.start,
    end: valid[order + 1]?.start ?? text.length,
    level: Math.max(1, Math.min(6, Math.floor(chapter.level || 1))),
  }));
}

interface ReaderTextChangeRange {
  prefixLength: number;
  previousChangeEnd: number;
  nextChangeEnd: number;
}

/**
 * Where an edit is already known to fall, e.g. the section a draft replaced.
 * The texts must be identical before `start` and after the two ends; the
 * character scan for the exact change then only covers the edited span. A
 * hint that does not hold is ignored, so it can never skew an offset.
 */
export interface ReaderTextChangeHint {
  start: number;
  /** End of the replaced span in the previous text. */
  previousEnd: number;
  /** End of its replacement in the next text. */
  nextEnd: number;
}

function isUsableChangeHint(previousText: string, nextText: string, hint: ReaderTextChangeHint): boolean {
  return Number.isSafeInteger(hint.start)
    && Number.isSafeInteger(hint.previousEnd)
    && Number.isSafeInteger(hint.nextEnd)
    && hint.start >= 0
    && hint.start <= hint.previousEnd
    && hint.previousEnd <= previousText.length
    && hint.start <= hint.nextEnd
    && hint.nextEnd <= nextText.length
    && previousText.length - hint.previousEnd === nextText.length - hint.nextEnd
    // Native comparisons confirm the claimed-equal ends far faster than the
    // character scan they let the change search skip.
    && previousText.slice(0, hint.start) === nextText.slice(0, hint.start)
    && previousText.slice(hint.previousEnd) === nextText.slice(hint.nextEnd);
}

function getReaderTextChangeRange(
  previousText: string,
  nextText: string,
  hint?: ReaderTextChangeHint,
): ReaderTextChangeRange {
  const trusted = hint && isUsableChangeHint(previousText, nextText, hint) ? hint : null;
  const sharedLimit = Math.min(previousText.length, nextText.length);
  // Starting past the known-equal ends yields exactly what a full scan finds:
  // both loops still extend as far as the texts keep matching.
  let prefixLength = trusted?.start ?? 0;
  while (prefixLength < sharedLimit && previousText[prefixLength] === nextText[prefixLength]) {
    prefixLength += 1;
  }

  const suffixLimit = sharedLimit - prefixLength;
  let suffixLength = trusted ? Math.min(previousText.length - trusted.previousEnd, suffixLimit) : 0;
  while (
    suffixLength < suffixLimit
    && previousText[previousText.length - suffixLength - 1] === nextText[nextText.length - suffixLength - 1]
  ) {
    suffixLength += 1;
  }

  return {
    prefixLength,
    previousChangeEnd: previousText.length - suffixLength,
    nextChangeEnd: nextText.length - suffixLength,
  };
}

/**
 * The last text pair scanned. An edit commit rebases progress, every bookmark,
 * note and highlight, and the chapter table against the same two texts, so
 * remembering one scan turns a whole-book pass per offset into one pass per
 * edit. It holds the two most recent texts until the next edit replaces them.
 */
let lastTextChange: { previousText: string; nextText: string; range: ReaderTextChangeRange } | null = null;

function rememberedTextChangeRange(
  previousText: string,
  nextText: string,
  hint?: ReaderTextChangeHint,
): ReaderTextChangeRange {
  if (lastTextChange?.previousText === previousText && lastTextChange.nextText === nextText) {
    return lastTextChange.range;
  }
  const range = getReaderTextChangeRange(previousText, nextText, hint);
  lastTextChange = { previousText, nextText, range };
  return range;
}

function rebaseOffsetAcross(
  { prefixLength, previousChangeEnd, nextChangeEnd }: ReaderTextChangeRange,
  previousLength: number,
  nextLength: number,
  offset: number,
): number {
  const safeOffset = Math.max(0, Math.min(previousLength, offset));
  if (safeOffset < prefixLength) return safeOffset;
  if (safeOffset >= previousChangeEnd) return safeOffset + nextLength - previousLength;
  return prefixLength + Math.min(safeOffset - prefixLength, nextChangeEnd - prefixLength);
}

/**
 * Maps offsets in `previousText` onto `nextText`, finding the edit once for
 * any number of offsets. A hint narrows that one scan to the edited span.
 */
export function createReaderOffsetRebaser(
  previousText: string,
  nextText: string,
  hint?: ReaderTextChangeHint,
): (offset: number) => number {
  const range = rememberedTextChangeRange(previousText, nextText, hint);
  return (offset) => rebaseOffsetAcross(range, previousText.length, nextText.length, offset);
}

/** Keep whole-book annotations anchored as text before them grows or shrinks. */
export function rebaseReaderTextOffset(previousText: string, nextText: string, offset: number): number {
  return rebaseOffsetAcross(
    rememberedTextChangeRange(previousText, nextText),
    previousText.length,
    nextText.length,
    offset,
  );
}

function nearestReaderSectionBoundary(text: string, start: number, end: number): number {
  if (end - start <= READER_SECTION_MAX_CHARS) return end;

  const minimum = Math.min(end, start + READER_SECTION_MIN_CHARS);
  const preferred = Math.min(end, start + READER_SECTION_TARGET_CHARS);
  const maximum = Math.min(end, start + READER_SECTION_MAX_CHARS);
  const window = text.slice(minimum, maximum);
  const candidates: number[] = [];

  for (const match of window.matchAll(/\n{2,}/g)) {
    candidates.push(minimum + (match.index ?? 0) + match[0].length);
  }
  for (const match of window.matchAll(/[.!?]["'’”)]*\s+/g)) {
    candidates.push(minimum + (match.index ?? 0) + match[0].length);
  }

  if (candidates.length > 0) {
    return candidates.reduce((best, candidate) => (
      Math.abs(candidate - preferred) < Math.abs(best - preferred) ? candidate : best
    ));
  }

  const whitespace = text.slice(minimum, maximum).lastIndexOf(" ");
  return whitespace >= 0 ? minimum + whitespace + 1 : maximum;
}

/** Build deterministic, paragraph-aligned working sections for a book. */
export function buildReaderSections(
  text: string,
  chapters: readonly ReaderChapter[],
): ReaderSection[] {
  if (!text) return [];
  const sourceChapters = chapters.length > 0
    ? chapters
    : [{ id: "chapter-1", title: "Document", order: 0, start: 0, end: text.length, level: 1 }];
  const sections: ReaderSection[] = [];

  for (const chapter of sourceChapters) {
    const chapterStart = Math.max(0, Math.min(text.length, chapter.start));
    const chapterEnd = Math.max(chapterStart, Math.min(text.length, chapter.end));
    if (chapterEnd <= chapterStart) continue;

    const boundaries = [chapterStart];
    let cursor = chapterStart;
    while (cursor < chapterEnd) {
      const next = nearestReaderSectionBoundary(text, cursor, chapterEnd);
      const safeNext = Math.max(cursor + 1, Math.min(chapterEnd, next));
      boundaries.push(safeNext);
      cursor = safeNext;
    }

    const chapterSectionCount = boundaries.length - 1;
    for (let index = 0; index < chapterSectionCount; index += 1) {
      sections.push({
        id: `${chapter.id}:section-${index + 1}`,
        chapterId: chapter.id,
        order: sections.length,
        chapterSectionIndex: index,
        chapterSectionCount,
        start: boundaries[index],
        end: boundaries[index + 1],
      });
    }
  }

  return sections;
}

export function readerSectionAtOffset(
  sections: readonly ReaderSection[],
  offset: number,
): ReaderSection | null {
  if (sections.length === 0) return null;
  const clampedOffset = Math.max(0, offset);
  return sections.find((section) => clampedOffset >= section.start && clampedOffset < section.end)
    ?? [...sections].reverse().find((section) => clampedOffset >= section.start)
    ?? sections[0];
}

export function getReaderSectionText(text: string, section: ReaderSection | null): string {
  if (!section) return text;
  return text.slice(section.start, section.end);
}

export function createReaderAudioCacheKey(documentId: string, sectionId: string): string {
  return JSON.stringify([documentId, sectionId]);
}

export function getCachedReaderAudioByteLength(chunks: readonly CachedReaderAudioChunk[]): number {
  return chunks.reduce((total, chunk) => total + chunk.audio.byteLength, 0);
}

/** Preserve imported chapter metadata while moving boundaries around a localized text edit. */
export function rebaseReaderChapters(
  previousText: string,
  nextText: string,
  chapters: readonly ReaderChapter[],
  documentTitle: string,
): ReaderChapter[] {
  if (chapters.length === 0) return structureTextChapters(nextText, documentTitle);

  const { prefixLength, previousChangeEnd } = rememberedTextChangeRange(previousText, nextText);
  const delta = nextText.length - previousText.length;
  const insertionOnly = previousChangeEnd === prefixLength;
  const moveBoundary = (offset: number): number => {
    if (offset < prefixLength || (!insertionOnly && offset === prefixLength)) return offset;
    if (offset >= previousChangeEnd) return offset + delta;
    return prefixLength;
  };

  return normalizeReaderChapters(
    nextText,
    chapters.map((chapter) => ({
      ...chapter,
      start: moveBoundary(chapter.start),
      end: moveBoundary(chapter.end),
    })),
    documentTitle,
  );
}

export function createReaderDocument(input: ReaderDocumentInput): ReaderDocumentRecord {
  const now = input.now ?? Date.now();
  const text = normalizeReaderText(input.text);
  const title = cleanTitle(input.title || "") || deriveDocumentTitle(text);
  const chapters = input.chapters
    ? normalizeReaderChapters(text, input.chapters, title)
    : structureTextChapters(text, title);
  const sections = buildReaderSections(text, chapters);

  return {
    id: input.id ?? createId("document"),
    title,
    author: input.author?.trim().slice(0, 160) ?? "",
    description: input.description?.trim().slice(0, 1000) ?? "",
    language: input.language?.trim().slice(0, 32) ?? "",
    sourceType: input.sourceType ?? "text",
    sourceName: input.sourceName?.trim().slice(0, 260) ?? "",
    sourceUrl: input.sourceUrl?.trim().slice(0, 2048) ?? "",
    text,
    chapters,
    progress: {
      positionSec: 0,
      totalDurationSec: 0,
      textOffset: 0,
      chapterId: chapters[0]?.id ?? null,
      sectionId: sections[0]?.id ?? null,
      percent: 0,
      updatedAt: now,
    },
    bookmarks: [],
    notes: [],
    ...(isReaderDocumentCover(input.cover) ? { cover: { dataUrl: input.cover.dataUrl } } : {}),
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
  };
}

/** Add fields introduced by newer Reader versions without rewriting book text. */
export function normalizeReaderDocumentRecord(document: ReaderDocumentRecord): ReaderDocumentRecord {
  const { highlights, cover, ...record } = document;
  const chapters = normalizeReaderChapters(document.text, document.chapters ?? [], document.title);
  const sections = buildReaderSections(document.text, chapters);
  const progressOffset = Math.max(0, Math.min(document.text.length, document.progress?.textOffset ?? 0));
  const progressChapter = chapterAtOffset(chapters, progressOffset);
  const progressSection = sections.find((section) => section.id === document.progress?.sectionId)
    ?? readerSectionAtOffset(sections, progressOffset);

  return {
    ...record,
    chapters,
    progress: {
      positionSec: Math.max(0, document.progress?.positionSec ?? 0),
      totalDurationSec: Math.max(0, document.progress?.totalDurationSec ?? 0),
      textOffset: progressOffset,
      chapterId: progressChapter?.id ?? null,
      sectionId: progressSection?.id ?? null,
      percent: calculateReaderProgress(document.text.length, progressOffset, 0, 0),
      updatedAt: document.progress?.updatedAt ?? document.updatedAt,
    },
    bookmarks: (document.bookmarks ?? []).map((bookmark) => ({
      ...bookmark,
      chapterId: chapterAtOffset(chapters, bookmark.textOffset)?.id ?? null,
      sectionId: readerSectionAtOffset(sections, bookmark.textOffset)?.id ?? null,
    })),
    notes: (document.notes ?? []).map((note) => ({
      ...note,
      chapterId: chapterAtOffset(chapters, note.textOffset)?.id ?? null,
      sectionId: readerSectionAtOffset(sections, note.textOffset)?.id ?? null,
    })),
    // Records from before highlights existed stay without the field.
    ...(Array.isArray(highlights) ? { highlights: normalizeReaderHighlights(document.text, highlights) } : {}),
    ...(isReaderDocumentCover(cover) ? { cover } : {}),
  };
}

export function chapterAtOffset(
  chapters: readonly ReaderChapter[],
  offset: number,
): ReaderChapter | null {
  if (chapters.length === 0) return null;
  const clampedOffset = Math.max(0, offset);
  return chapters.find((chapter) => clampedOffset >= chapter.start && clampedOffset < chapter.end)
    ?? [...chapters].reverse().find((chapter) => clampedOffset >= chapter.start)
    ?? chapters[0];
}

export function calculateReaderProgress(
  textLength: number,
  textOffset: number,
  positionSec: number,
  totalDurationSec: number,
): number {
  // Audio duration is section-local and therefore cannot define whole-book
  // progress. Keep these parameters for callers migrating from the v1 API.
  void positionSec;
  void totalDurationSec;
  if (textLength > 0) {
    return Math.max(0, Math.min(100, (textOffset / textLength) * 100));
  }
  return 0;
}

export function createReaderBookmark(input: Omit<ReaderBookmark, "id" | "createdAt">): ReaderBookmark {
  return { ...input, id: createId("bookmark"), createdAt: Date.now() };
}

export function createReaderNote(input: Omit<ReaderNote, "id" | "createdAt" | "updatedAt">): ReaderNote {
  const now = Date.now();
  return { ...input, id: createId("note"), createdAt: now, updatedAt: now };
}

export function isReaderHighlightColor(value: unknown): value is ReaderHighlightColor {
  return typeof value === "string" && (READER_HIGHLIGHT_COLORS as readonly string[]).includes(value);
}

export interface ReaderHighlightInput {
  start: number;
  end: number;
  color: ReaderHighlightColor;
}

/**
 * A highlight over `text[start, end)`, trimmed to the words inside it, or null
 * when the range holds nothing to highlight.
 */
export function createReaderHighlight(
  text: string,
  input: ReaderHighlightInput,
  now = Date.now(),
): ReaderHighlight | null {
  if (!Number.isFinite(input.start) || !Number.isFinite(input.end) || !isReaderHighlightColor(input.color)) {
    return null;
  }
  let start = Math.max(0, Math.min(text.length, Math.floor(input.start)));
  let end = Math.max(start, Math.min(text.length, Math.floor(input.end)));
  // A drag usually catches the space or line break around the words.
  while (start < end && /\s/.test(text[start])) start += 1;
  while (end > start && /\s/.test(text[end - 1])) end -= 1;
  if (end <= start) return null;
  return {
    id: createId("highlight"),
    start,
    end,
    color: input.color,
    quote: text.slice(start, Math.min(end, start + READER_HIGHLIGHT_QUOTE_LIMIT)),
    createdAt: now,
    updatedAt: now,
  };
}

/** The highlighted text still sits exactly where the highlight says. */
export function isReaderHighlightAnchored(text: string, highlight: ReaderHighlight): boolean {
  return highlight.end > highlight.start
    && highlight.end <= text.length
    && highlight.quote.length > 0
    && text.startsWith(highlight.quote, highlight.start);
}

/**
 * Where a highlight's text sits in `text` now: in place when it is anchored,
 * else the occurrence of its quote nearest to where it was, or null when its
 * text is gone.
 */
export function resolveReaderHighlightRange(
  text: string,
  highlight: ReaderHighlight,
): { start: number; end: number } | null {
  if (isReaderHighlightAnchored(text, highlight)) return { start: highlight.start, end: highlight.end };
  if (!highlight.quote) return null;
  let found = -1;
  let foundDistance = Infinity;
  for (let index = text.indexOf(highlight.quote); index !== -1; index = text.indexOf(highlight.quote, index + 1)) {
    const distance = Math.abs(index - highlight.start);
    if (distance < foundDistance) {
      found = index;
      foundDistance = distance;
    } else if (index > highlight.start) {
      break;
    }
  }
  if (found === -1) return null;
  // A quote shorter than the limit is the whole highlighted text; only a
  // truncated one leaves the stored range to say how far the highlight ran.
  const length = highlight.quote.length < READER_HIGHLIGHT_QUOTE_LIMIT
    ? highlight.quote.length
    : Math.max(highlight.quote.length, highlight.end - highlight.start);
  return { start: found, end: Math.min(text.length, found + length) };
}

function isStoredHighlight(value: unknown): value is ReaderHighlight {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<ReaderHighlight>;
  return typeof entry.id === "string" && entry.id.length > 0
    && typeof entry.start === "number" && Number.isSafeInteger(entry.start) && entry.start >= 0
    && typeof entry.end === "number" && Number.isSafeInteger(entry.end) && entry.end > entry.start
    && isReaderHighlightColor(entry.color)
    && typeof entry.quote === "string"
    && Number.isFinite(entry.createdAt)
    && Number.isFinite(entry.updatedAt);
}

/**
 * Keeps well-formed stored highlights, in reading order and once per id, and
 * re-anchors any whose text has moved. One whose text is gone keeps its record
 * (and stays listed and exported) but no longer marks the page.
 */
function normalizeReaderHighlights(text: string, highlights: readonly unknown[]): ReaderHighlight[] {
  const seenIds = new Set<string>();
  return highlights
    .filter(isStoredHighlight)
    .filter((highlight) => {
      if (seenIds.has(highlight.id)) return false;
      seenIds.add(highlight.id);
      return true;
    })
    .map((highlight) => {
      const range = resolveReaderHighlightRange(text, highlight);
      if (range) return range.start === highlight.start && range.end === highlight.end ? highlight : { ...highlight, ...range };
      const start = Math.max(0, Math.min(text.length, Math.floor(highlight.start)));
      return { ...highlight, start, end: Math.max(start, Math.min(text.length, Math.floor(highlight.end))) };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Carries highlights across a text edit. Anchored ones move with their words
 * and take their quote from the edited text, so a fix inside a highlighted
 * passage keeps the highlight, while one whose words were all deleted goes
 * with them. Text typed right after a highlight stays outside it. Detached
 * ones are left for their quote to find.
 */
export function rebaseReaderHighlights(
  previousText: string,
  nextText: string,
  highlights: readonly ReaderHighlight[],
  hint?: ReaderTextChangeHint,
): ReaderHighlight[] {
  if (highlights.length === 0) return [];
  const range = rememberedTextChangeRange(previousText, nextText, hint);
  const rebase = (offset: number) => rebaseOffsetAcross(range, previousText.length, nextText.length, offset);
  const insertionAt = range.previousChangeEnd === range.prefixLength ? range.prefixLength : -1;
  return highlights.flatMap((highlight) => {
    if (!isReaderHighlightAnchored(previousText, highlight)) return [highlight];
    const start = rebase(highlight.start);
    const end = highlight.end === insertionAt ? highlight.end : rebase(highlight.end);
    if (end <= start) return [];
    return [{
      ...highlight,
      start,
      end,
      quote: nextText.slice(start, Math.min(end, start + READER_HIGHLIGHT_QUOTE_LIMIT)),
    }];
  });
}

/**
 * Version 2 hashes only the inputs the selected engine reads (see
 * `EngineDescriptor.signatureParts`). Older entries carry no version prefix, so
 * after the upgrade they never compare equal: each one misses once and is
 * replaced, instead of being restored under a meaning it no longer has.
 */
export const READER_AUDIO_SIGNATURE_VERSION = 2;

/**
 * The tuning inputs that shape an engine's audio, already narrowed to the ones
 * it reads. An omitted field is one the engine ignores, so changing it can
 * never invalidate cached audio.
 */
export interface AudioSignatureTuning {
  speed?: number;
  sentenceSpeedVariance?: number;
  quality?: number;
  language?: string;
  pauseOverridesSec?: GenerationTuningSettings["pauseOverridesSec"];
  pronunciationRules?: GenerationTuningSettings["pronunciationRules"];
  emphasisStrength?: number;
}

export function buildAudioSignature(parts: {
  text: string;
  model: string;
  voice: string;
  tuning: AudioSignatureTuning;
}): string {
  let hash = 2166136261;
  const { tuning } = parts;
  // A fixed key order with null for anything absent keeps equal inputs equal
  // regardless of how the caller assembled the object.
  const tuningKey = JSON.stringify({
    speed: tuning.speed ?? null,
    sentenceSpeedVariance: tuning.sentenceSpeedVariance ?? null,
    quality: tuning.quality ?? null,
    language: tuning.language ?? null,
    pauseOverridesSec: tuning.pauseOverridesSec
      ? {
          none: tuning.pauseOverridesSec.none ?? null,
          comma: tuning.pauseOverridesSec.comma ?? null,
          sentence: tuning.pauseOverridesSec.sentence ?? null,
          paragraph: tuning.pauseOverridesSec.paragraph ?? null,
        }
      : null,
    pronunciationRules: tuning.pronunciationRules?.map(({ from, to }) => ({ from, to })) ?? null,
    emphasisStrength: tuning.emphasisStrength ?? null,
  });
  const value = `${parts.model}\u0000${parts.voice}\u0000${tuningKey}\u0000${parts.text}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `v${READER_AUDIO_SIGNATURE_VERSION}.${parts.text.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}
