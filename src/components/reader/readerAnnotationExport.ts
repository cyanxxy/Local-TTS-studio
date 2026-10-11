import {
  chapterAtOffset,
  isReaderHighlightAnchored,
  type ReaderBookmark,
  type ReaderChapter,
  type ReaderDocumentRecord,
  type ReaderHighlight,
  type ReaderNote,
} from "../../lib/readerDocument";
import { READER_HIGHLIGHT_SWATCHES } from "./readerHighlightColors";

export type ReaderAnnotationExportFormat = "markdown" | "json";

export interface ReaderAnnotationFile {
  fileName: string;
  mimeType: string;
  content: string;
}

/** Identifies the JSON export so other tools can recognise and version it. */
export const READER_ANNOTATION_EXPORT_FORMAT = "open-tts-reader-annotations";
export const READER_ANNOTATION_EXPORT_VERSION = 1;

type Annotated = Pick<ReaderDocumentRecord, "bookmarks" | "notes" | "highlights">;

export function countReaderAnnotations(document: Annotated): number {
  return document.bookmarks.length + document.notes.length + (document.highlights?.length ?? 0);
}

/** The words a highlight marks: its live range while anchored, else its saved quote. */
function highlightText(text: string, highlight: ReaderHighlight): string {
  return isReaderHighlightAnchored(text, highlight) ? text.slice(highlight.start, highlight.end) : highlight.quote;
}

function percentThrough(text: string, offset: number): number {
  return text.length > 0 ? Math.round((Math.max(0, Math.min(text.length, offset)) / text.length) * 100) : 0;
}

/** m:ss, or h:mm:ss past an hour, matching the player. */
function formatListeningTime(seconds: number): string {
  const total = Math.floor(Math.max(0, seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

function isoTime(milliseconds: number): string | null {
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function localDate(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** One Markdown line: a line break inside a title or label must not start a heading. */
function inline(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function blockquote(text: string): string {
  return text.trim().split("\n").map((line) => (line.trim() ? `> ${line.trim()}` : ">")).join("\n");
}

function fileStem(title: string): string {
  const stem = title
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+/, "")
    .slice(0, 80)
    .replace(/-+$/, "");
  return stem || "reader";
}

type AnnotationEntry =
  | { kind: "bookmark"; offset: number; bookmark: ReaderBookmark }
  | { kind: "highlight"; offset: number; highlight: ReaderHighlight }
  | { kind: "note"; offset: number; note: ReaderNote };

const KIND_ORDER: Record<AnnotationEntry["kind"], number> = { bookmark: 0, highlight: 1, note: 2 };

/** Every annotation in reading order; at one spot, bookmarks, then highlights, then notes. */
function annotationsInReadingOrder(document: ReaderDocumentRecord): AnnotationEntry[] {
  return [
    ...document.bookmarks.map((bookmark) => ({ kind: "bookmark" as const, offset: bookmark.textOffset, bookmark })),
    ...(document.highlights ?? []).map((highlight) => ({ kind: "highlight" as const, offset: highlight.start, highlight })),
    ...document.notes.map((note) => ({ kind: "note" as const, offset: note.textOffset, note })),
  ].sort((a, b) => a.offset - b.offset || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

function markdownEntry(document: ReaderDocumentRecord, entry: AnnotationEntry): string {
  const where = `${percentThrough(document.text, entry.offset)}% through`;
  switch (entry.kind) {
    case "bookmark": {
      const time = entry.bookmark.positionSec > 0 ? `, ${formatListeningTime(entry.bookmark.positionSec)}` : "";
      return `- Bookmark: ${inline(entry.bookmark.label)} (${where}${time})`;
    }
    case "highlight":
      return [
        blockquote(highlightText(document.text, entry.highlight)),
        `*${READER_HIGHLIGHT_SWATCHES[entry.highlight.color].label} highlight · ${where}*`,
      ].join("\n\n");
    case "note":
      return [
        ...(entry.note.quote.trim() ? [blockquote(entry.note.quote)] : []),
        entry.note.text.trim(),
        `*Note · ${where}*`,
      ].join("\n\n");
  }
}

/**
 * Notes, highlights and bookmarks as Markdown, grouped under their chapters
 * in reading order, for notebooks such as Obsidian or a plain text editor.
 */
export function buildReaderAnnotationsMarkdown(document: ReaderDocumentRecord, exportedAt = new Date()): string {
  const entries = annotationsInReadingOrder(document);
  const counts = [
    plural(document.highlights?.length ?? 0, "highlight"),
    plural(document.notes.length, "note"),
    plural(document.bookmarks.length, "bookmark"),
  ].join(" · ");
  const blocks = [
    `# ${inline(document.title)}`,
    ...(document.author ? [`by ${inline(document.author)}`] : []),
    `${counts} · exported from Open TTS on ${localDate(exportedAt)}`,
  ];

  // A one-chapter document's only chapter is the book itself.
  const showChapters = document.chapters.length > 1;
  let chapter: ReaderChapter | null = null;
  for (const entry of entries) {
    const entryChapter = chapterAtOffset(document.chapters, entry.offset);
    if (showChapters && entryChapter && entryChapter !== chapter) {
      blocks.push(`## ${inline(entryChapter.title)}`);
      chapter = entryChapter;
    }
    blocks.push(markdownEntry(document, entry));
  }
  return `${blocks.join("\n\n")}\n`;
}

/** The same annotations as versioned JSON, with offsets for tools that re-anchor them. */
export function buildReaderAnnotationsJson(document: ReaderDocumentRecord, exportedAt = new Date()): string {
  const chapterTitle = (offset: number) => chapterAtOffset(document.chapters, offset)?.title ?? null;
  const highlights = [...(document.highlights ?? [])].sort((a, b) => a.start - b.start);
  return `${JSON.stringify({
    format: READER_ANNOTATION_EXPORT_FORMAT,
    version: READER_ANNOTATION_EXPORT_VERSION,
    exportedAt: exportedAt.toISOString(),
    document: {
      id: document.id,
      title: document.title,
      author: document.author,
      language: document.language,
      sourceName: document.sourceName,
      sourceUrl: document.sourceUrl,
    },
    highlights: highlights.map((highlight) => ({
      id: highlight.id,
      color: highlight.color,
      text: highlightText(document.text, highlight),
      chapter: chapterTitle(highlight.start),
      start: highlight.start,
      end: highlight.end,
      percent: percentThrough(document.text, highlight.start),
      createdAt: isoTime(highlight.createdAt),
      updatedAt: isoTime(highlight.updatedAt),
    })),
    notes: [...document.notes].sort((a, b) => a.textOffset - b.textOffset).map((note) => ({
      id: note.id,
      text: note.text,
      quote: note.quote,
      chapter: chapterTitle(note.textOffset),
      textOffset: note.textOffset,
      percent: percentThrough(document.text, note.textOffset),
      createdAt: isoTime(note.createdAt),
      updatedAt: isoTime(note.updatedAt),
    })),
    bookmarks: [...document.bookmarks].sort((a, b) => a.textOffset - b.textOffset).map((bookmark) => ({
      id: bookmark.id,
      label: bookmark.label,
      chapter: chapterTitle(bookmark.textOffset),
      textOffset: bookmark.textOffset,
      positionSec: bookmark.positionSec,
      percent: percentThrough(document.text, bookmark.textOffset),
      createdAt: isoTime(bookmark.createdAt),
    })),
  }, null, 2)}\n`;
}

export function buildReaderAnnotationFile(
  document: ReaderDocumentRecord,
  format: ReaderAnnotationExportFormat,
  exportedAt = new Date(),
): ReaderAnnotationFile {
  const stem = `${fileStem(document.title)}-annotations`;
  return format === "json"
    ? { fileName: `${stem}.json`, mimeType: "application/json", content: buildReaderAnnotationsJson(document, exportedAt) }
    : { fileName: `${stem}.md`, mimeType: "text/markdown", content: buildReaderAnnotationsMarkdown(document, exportedAt) };
}
