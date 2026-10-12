/**
 * ID3v2.4 tag writer with chapters (ID3v2 Chapter Frame Addendum 1.0).
 *
 * Writes UTF-8 text frames (TIT2 title, TPE1 artist, TALB album, TDRC date,
 * COMM comment, TLEN length), one CHAP frame per chapter with an embedded
 * TIT2, and a top-level ordered CTOC. More than 255 chapters are grouped
 * under nested tables of contents, since one CTOC lists at most 255 entries.
 * Podcast and audiobook players (Apple Podcasts and Books, Overcast, VLC)
 * read this layout for chapter navigation.
 */

export interface Id3Metadata {
  title?: string;
  artist?: string;
  album?: string;
  /** Recording date or year, ISO 8601 ("2026" or "2026-10-11"). */
  date?: string;
  comment?: string;
  /** Audio duration in milliseconds (TLEN). */
  durationMs?: number;
}

export interface Id3Chapter {
  title: string;
  startMs: number;
  endMs: number;
}

export interface Id3TagOptions {
  /** Zero padding after the frames, so editors can grow the tag in place. */
  paddingBytes?: number;
}

const DEFAULT_PADDING_BYTES = 1024;
const MAX_SYNCSAFE = 0x0fffffff;
const MAX_CTOC_ENTRIES = 255;
const MAX_TIME_MS = 0xfffffffe;
const UNKNOWN_OFFSET = 0xffffffff;
const ENCODING_UTF8 = 3;
const CTOC_TOP_LEVEL = 0x02;
const CTOC_ORDERED = 0x01;
const MAX_TEXT_LENGTH = 1024;
const DATE = /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/;

const utf8 = new TextEncoder();

function syncsafe(value: number): number[] {
  if (!Number.isInteger(value) || value < 0 || value > MAX_SYNCSAFE) {
    throw new RangeError("The ID3 tag is too large.");
  }
  return [(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f];
}

function uint32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function frame(id: string, body: Uint8Array): Uint8Array {
  return concat([utf8.encode(id), Uint8Array.from(syncsafe(body.length)), new Uint8Array(2), body]);
}

/** Collapses whitespace, drops control characters and limits length; null terminators cannot appear. */
function cleanText(text: string): string {
  return Array.from(text.replace(/\s+/g, " ").trim())
    .filter((character) => {
      const code = character.codePointAt(0) as number;
      return code >= 0x20 && !(code >= 0x7f && code <= 0x9f);
    })
    .slice(0, MAX_TEXT_LENGTH)
    .join("");
}

function textFrame(id: string, text: string): Uint8Array {
  return frame(id, concat([Uint8Array.of(ENCODING_UTF8), utf8.encode(text)]));
}

function asciiId(id: string): Uint8Array {
  return concat([utf8.encode(id), Uint8Array.of(0)]);
}

function chapterFrame(id: string, chapter: Id3Chapter): Uint8Array {
  return frame("CHAP", concat([
    asciiId(id),
    Uint8Array.from([...uint32(chapter.startMs), ...uint32(chapter.endMs), ...uint32(UNKNOWN_OFFSET), ...uint32(UNKNOWN_OFFSET)]),
    textFrame("TIT2", cleanText(chapter.title) || id),
  ]));
}

function tocFrame(id: string, flags: number, children: readonly string[], title?: string): Uint8Array {
  return frame("CTOC", concat([
    asciiId(id),
    Uint8Array.of(flags, children.length),
    ...children.map(asciiId),
    ...(title ? [textFrame("TIT2", title)] : []),
  ]));
}

function validateChapters(chapters: readonly Id3Chapter[]): Id3Chapter[] {
  let previousStart = 0;
  return chapters.map((chapter, index) => {
    const startMs = Math.round(chapter.startMs);
    const endMs = Math.round(chapter.endMs);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs > MAX_TIME_MS || endMs < startMs) {
      throw new RangeError(`Chapter ${index + 1} has an invalid time range.`);
    }
    if (startMs < previousStart) throw new RangeError(`Chapter ${index + 1} starts before the previous chapter.`);
    previousStart = startMs;
    return { title: chapter.title, startMs, endMs };
  });
}

/** Builds a complete ID3v2.4 tag to place before MPEG audio frames. */
export function buildId3Tag(metadata: Id3Metadata, chapters: readonly Id3Chapter[] = [], options: Id3TagOptions = {}): Uint8Array {
  const frames: Uint8Array[] = [];
  const addText = (id: string, value: string | undefined) => {
    const text = value === undefined ? "" : cleanText(value);
    if (text) frames.push(textFrame(id, text));
  };
  addText("TIT2", metadata.title);
  addText("TPE1", metadata.artist);
  addText("TALB", metadata.album);
  if (metadata.date !== undefined && DATE.test(metadata.date)) addText("TDRC", metadata.date);
  const comment = metadata.comment === undefined ? "" : cleanText(metadata.comment);
  // COMM: encoding, language "und", empty description (terminated), text.
  if (comment) frames.push(frame("COMM", concat([Uint8Array.of(ENCODING_UTF8), utf8.encode("und"), Uint8Array.of(0), utf8.encode(comment)])));
  if (metadata.durationMs !== undefined && Number.isFinite(metadata.durationMs) && metadata.durationMs >= 0) {
    addText("TLEN", String(Math.round(metadata.durationMs)));
  }

  const validated = validateChapters(chapters);
  if (validated.length > 0) {
    const chapterIds = validated.map((_, index) => `ch${index}`);
    if (validated.length <= MAX_CTOC_ENTRIES) {
      frames.push(tocFrame("toc", CTOC_TOP_LEVEL | CTOC_ORDERED, chapterIds));
    } else {
      const groups: string[][] = [];
      for (let index = 0; index < chapterIds.length; index += MAX_CTOC_ENTRIES) {
        groups.push(chapterIds.slice(index, index + MAX_CTOC_ENTRIES));
      }
      if (groups.length > MAX_CTOC_ENTRIES) throw new RangeError("Too many chapters for an ID3 table of contents.");
      frames.push(tocFrame("toc", CTOC_TOP_LEVEL | CTOC_ORDERED, groups.map((_, index) => `toc${index + 1}`)));
      groups.forEach((group, index) => {
        frames.push(tocFrame(`toc${index + 1}`, CTOC_ORDERED, group, `Chapters ${index * MAX_CTOC_ENTRIES + 1}-${index * MAX_CTOC_ENTRIES + group.length}`));
      });
    }
    validated.forEach((chapter, index) => frames.push(chapterFrame(chapterIds[index], chapter)));
  }

  const padding = Math.max(0, Math.round(options.paddingBytes ?? DEFAULT_PADDING_BYTES));
  const body = concat([...frames, new Uint8Array(padding)]);
  return concat([Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0, ...syncsafe(body.length)]), body]);
}

export interface ChapterStart {
  title: string;
  startSec: number;
}

/**
 * Turns chapter start times into ID3 chapters that end where the next one
 * starts (the last at `durationSec`). Starts are sorted and clamped to the
 * audio; chapters that would be empty are dropped.
 */
export function chaptersFromStarts(starts: readonly ChapterStart[], durationSec: number): Id3Chapter[] {
  const durationMs = Math.max(0, Math.round(durationSec * 1000));
  const sorted = starts
    .filter((start) => Number.isFinite(start.startSec))
    .map((start) => ({ title: start.title, startMs: Math.min(durationMs, Math.max(0, Math.round(start.startSec * 1000))) }))
    .sort((a, b) => a.startMs - b.startMs);
  return sorted
    .map((start, index) => ({ title: start.title, startMs: start.startMs, endMs: sorted[index + 1]?.startMs ?? durationMs }))
    .filter((chapter) => chapter.endMs > chapter.startMs);
}
