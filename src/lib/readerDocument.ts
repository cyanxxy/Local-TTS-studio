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
  updatedAt: number;
}

export const READER_SECTION_TARGET_CHARS = 8_000;
export const READER_SECTION_MIN_CHARS = 4_000;
export const READER_SECTION_MAX_CHARS = 12_000;

export interface EstimatedWordRange {
  word: string;
  start: number;
  end: number;
  startSec: number;
  endSec: number;
}

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

function getReaderTextChangeRange(previousText: string, nextText: string): ReaderTextChangeRange {
  let prefixLength = 0;
  const sharedLimit = Math.min(previousText.length, nextText.length);
  while (prefixLength < sharedLimit && previousText[prefixLength] === nextText[prefixLength]) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < sharedLimit - prefixLength
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

/** Keep whole-book annotations anchored as text before them grows or shrinks. */
export function rebaseReaderTextOffset(previousText: string, nextText: string, offset: number): number {
  const { prefixLength, previousChangeEnd, nextChangeEnd } = getReaderTextChangeRange(previousText, nextText);
  const safeOffset = Math.max(0, Math.min(previousText.length, offset));
  if (safeOffset < prefixLength) return safeOffset;
  if (safeOffset >= previousChangeEnd) return safeOffset + nextText.length - previousText.length;
  return prefixLength + Math.min(safeOffset - prefixLength, nextChangeEnd - prefixLength);
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

  const { prefixLength, previousChangeEnd } = getReaderTextChangeRange(previousText, nextText);
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
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
  };
}

/** Add fields introduced by newer Reader versions without rewriting book text. */
export function normalizeReaderDocumentRecord(document: ReaderDocumentRecord): ReaderDocumentRecord {
  const chapters = normalizeReaderChapters(document.text, document.chapters ?? [], document.title);
  const sections = buildReaderSections(document.text, chapters);
  const progressOffset = Math.max(0, Math.min(document.text.length, document.progress?.textOffset ?? 0));
  const progressChapter = chapterAtOffset(chapters, progressOffset);
  const progressSection = sections.find((section) => section.id === document.progress?.sectionId)
    ?? readerSectionAtOffset(sections, progressOffset);

  return {
    ...document,
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

export function estimateWordRanges(
  text: string,
  textStart: number,
  startSec: number,
  endSec: number,
): EstimatedWordRange[] {
  const matches = [...text.matchAll(/\S+/g)];
  if (matches.length === 0 || endSec <= startSec) return [];

  const weights = matches.map((match) => Math.max(1, match[0].replace(/[^\p{L}\p{N}]/gu, "").length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const duration = endSec - startSec;
  let cursorSec = startSec;

  return matches.map((match, index) => {
    const word = match[0];
    const relativeStart = match.index ?? 0;
    const wordDuration = index === matches.length - 1
      ? endSec - cursorSec
      : duration * (weights[index] / totalWeight);
    const range = {
      word,
      start: textStart + relativeStart,
      end: textStart + relativeStart + word.length,
      startSec: cursorSec,
      endSec: index === matches.length - 1 ? endSec : cursorSec + wordDuration,
    };
    cursorSec = range.endSec;
    return range;
  });
}

export function createReaderBookmark(input: Omit<ReaderBookmark, "id" | "createdAt">): ReaderBookmark {
  return { ...input, id: createId("bookmark"), createdAt: Date.now() };
}

export function createReaderNote(input: Omit<ReaderNote, "id" | "createdAt" | "updatedAt">): ReaderNote {
  const now = Date.now();
  return { ...input, id: createId("note"), createdAt: now, updatedAt: now };
}

export function buildAudioSignature(parts: {
  text: string;
  model: string;
  voice: string;
  quality: number;
  tuning?: GenerationTuningSettings;
}): string {
  let hash = 2166136261;
  const tuning = parts.tuning;
  const tuningKey = tuning
    ? JSON.stringify({
        speed: tuning.speed,
        quality: tuning.quality,
        pauseOverridesSec: {
          none: tuning.pauseOverridesSec?.none ?? null,
          comma: tuning.pauseOverridesSec?.comma ?? null,
          sentence: tuning.pauseOverridesSec?.sentence ?? null,
          paragraph: tuning.pauseOverridesSec?.paragraph ?? null,
        },
        sentenceSpeedVariance: tuning.sentenceSpeedVariance ?? null,
        pronunciationRules: tuning.pronunciationRules ?? [],
        emphasisStrength: tuning.emphasisStrength ?? null,
      })
    : "";
  const value = `${parts.model}\u0000${parts.voice}\u0000${parts.quality}\u0000${tuningKey}\u0000${parts.text}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${parts.text.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}
