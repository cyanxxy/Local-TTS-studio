/**
 * Inline pause markup.
 *
 * `<break time="1.5s"/>`, `<break time="500ms"/>`, `<break strength="strong"/>`
 * and `[pause 1.5s]` / `[pause 500ms]` / `[pause]` mark an explicit pause. The
 * markers are never spoken: they split the text into segments whose last chunk
 * carries the requested pause, so every engine renders the break the same way
 * as an ordinary chunk-boundary silence. Source offsets are preserved.
 */

import type { ChunkPauseKind } from "../../types";

/** Longest single explicit pause; longer requests and runs of tags are clamped. */
export const MAX_BREAK_SEC = 10;
/** Pause for `<break/>` and `[pause]` without a time, matching SSML's "medium". */
export const DEFAULT_BREAK_SEC = 0.5;

const STRENGTH_SECONDS: Record<string, number> = {
  none: 0,
  "x-weak": 0.1,
  weak: 0.25,
  medium: DEFAULT_BREAK_SEC,
  strong: 0.75,
  "x-strong": 1,
};

// Each alternative captures what the parser needs: the SSML attribute list, or
// the bracket form's number and unit.
const BREAK_MARKUP = /<break\b([^<>]*?)\/?>|\[\s*pause(?:\s+(\d+(?:\.\d+)?|\.\d+)\s*(ms|s|sec|secs|seconds?)?)?\s*\]/giu;
const SSML_ATTRIBUTE = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
const SSML_TIME = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*(ms|s)\s*$/iu;

export type SpeechBreakSyntax = "ssml" | "bracket";

export interface SpeechBreakTag {
  /** Source range of the whole tag. */
  start: number;
  end: number;
  seconds: number;
  syntax: SpeechBreakSyntax;
  /** The requested time exceeded `MAX_BREAK_SEC` and was clamped. */
  clamped: boolean;
  /** The tag had an unreadable time or strength and fell back to the default. */
  invalid: boolean;
}

export interface SpeechTextSegment {
  /** Trimmed source range of the spoken text between tags. */
  start: number;
  end: number;
  text: string;
  /** Explicit pause after this segment, or null when no tag follows it. */
  pauseAfterSec: number | null;
}

export interface ParsedSpeechBreaks {
  segments: SpeechTextSegment[];
  breaks: SpeechBreakTag[];
  /** Pause requested before any spoken text. */
  leadingPauseSec: number;
}

function clampBreakSeconds(seconds: number): number {
  return Math.min(MAX_BREAK_SEC, Math.max(0, seconds));
}

function roundSeconds(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

function parseSsmlBreak(attributes: string): { seconds: number; invalid: boolean } {
  const values = new Map<string, string>();
  for (const attribute of attributes.matchAll(SSML_ATTRIBUTE)) {
    values.set(attribute[1].toLowerCase(), attribute[2] ?? attribute[3]);
  }
  const time = values.get("time");
  if (time !== undefined) {
    const parsed = SSML_TIME.exec(time);
    if (!parsed) return { seconds: DEFAULT_BREAK_SEC, invalid: true };
    const value = Number(parsed[1]);
    return { seconds: parsed[2].toLowerCase() === "ms" ? value / 1000 : value, invalid: false };
  }
  const strength = values.get("strength");
  if (strength !== undefined) {
    const seconds = STRENGTH_SECONDS[strength.trim().toLowerCase()];
    return seconds === undefined
      ? { seconds: DEFAULT_BREAK_SEC, invalid: true }
      : { seconds, invalid: false };
  }
  return { seconds: DEFAULT_BREAK_SEC, invalid: false };
}

/** Finds every pause tag in source order. */
export function findSpeechBreaks(text: string): SpeechBreakTag[] {
  const breaks: SpeechBreakTag[] = [];
  for (const match of text.matchAll(BREAK_MARKUP)) {
    const start = match.index;
    let requested: { seconds: number; invalid: boolean };
    let syntax: SpeechBreakSyntax;
    if (match[1] !== undefined) {
      syntax = "ssml";
      requested = parseSsmlBreak(match[1]);
    } else {
      syntax = "bracket";
      const value = match[2] === undefined ? DEFAULT_BREAK_SEC : Number(match[2]);
      requested = { seconds: match[3]?.toLowerCase() === "ms" ? value / 1000 : value, invalid: false };
    }
    breaks.push({
      start,
      end: start + match[0].length,
      seconds: roundSeconds(clampBreakSeconds(requested.seconds)),
      syntax,
      clamped: requested.seconds > MAX_BREAK_SEC,
      invalid: requested.invalid,
    });
  }
  return breaks;
}

function trimmedRange(text: string, start: number, end: number): { start: number; end: number } {
  let trimmedStart = start;
  let trimmedEnd = end;
  while (trimmedStart < trimmedEnd && /\s/u.test(text[trimmedStart])) trimmedStart += 1;
  while (trimmedEnd > trimmedStart && /\s/u.test(text[trimmedEnd - 1])) trimmedEnd -= 1;
  return { start: trimmedStart, end: trimmedEnd };
}

/**
 * Splits text at pause tags. Whitespace-only text between tags is dropped and
 * adjacent tags add up (still clamped to `MAX_BREAK_SEC`).
 */
export function parseSpeechBreaks(text: string): ParsedSpeechBreaks {
  const breaks = findSpeechBreaks(text);
  const segments: SpeechTextSegment[] = [];
  let leadingPauseSec = 0;
  let cursor = 0;

  const addPause = (seconds: number) => {
    const last = segments.at(-1);
    if (last) {
      last.pauseAfterSec = roundSeconds(clampBreakSeconds((last.pauseAfterSec ?? 0) + seconds));
    } else {
      leadingPauseSec = roundSeconds(clampBreakSeconds(leadingPauseSec + seconds));
    }
  };
  const addText = (start: number, end: number) => {
    const range = trimmedRange(text, start, end);
    if (range.end > range.start) {
      segments.push({ ...range, text: text.slice(range.start, range.end), pauseAfterSec: null });
    }
  };

  for (const tag of breaks) {
    addText(cursor, tag.start);
    addPause(tag.seconds);
    cursor = tag.end;
  }
  addText(cursor, text.length);

  return { segments, breaks, leadingPauseSec };
}

/**
 * Removes pause tags so they are never spoken, collapsing the space around a
 * tag to one space between words and to nothing next to a line break or at
 * either end of the text.
 */
export function stripSpeechBreakMarkup(text: string): string {
  if (!text.includes("<") && !text.includes("[")) return text;
  const pattern = new RegExp(`[ \\t]*(?:${BREAK_MARKUP.source})[ \\t]*`, "giu");
  return text.replace(pattern, (match: string, ...args: unknown[]) => {
    const offset = args[args.length - 2] as number;
    const before = text[offset - 1];
    const after = text[offset + match.length];
    if (before === undefined || after === undefined || /\s/u.test(before) || /\s/u.test(after)) return "";
    return " ";
  });
}

export interface BreakAwareChunk {
  text: string;
  start: number;
  end: number;
  pauseAfterSec: number;
  pauseKind: ChunkPauseKind;
}

export type ChunkWithBreak<T extends BreakAwareChunk> = T & {
  /** Explicit pause from a tag; when set, it replaces the pause-kind default and slider overrides. */
  breakPauseSec?: number;
};

export interface BreakAwareChunking<T extends BreakAwareChunk> {
  chunks: ChunkWithBreak<T>[];
  leadingPauseSec: number;
}

/**
 * Runs an engine chunker on each tag-free segment and forces a boundary with
 * the tag's pause at every break. Chunk offsets index the original text.
 */
export function chunkWithSpeechBreaks<T extends BreakAwareChunk>(
  text: string,
  chunkSegment: (segmentText: string) => T[],
): BreakAwareChunking<T> {
  const parsed = parseSpeechBreaks(text);
  const chunks: ChunkWithBreak<T>[] = [];
  let leadingPauseSec = parsed.leadingPauseSec;
  // Break pause of the last chunk; every segment but the final one ends at a tag.
  let lastBreakSec = 0;

  for (const segment of parsed.segments) {
    const segmentChunks = chunkSegment(segment.text).map((chunk) => ({
      ...chunk,
      start: chunk.start + segment.start,
      end: chunk.end + segment.start,
    }));
    chunks.push(...segmentChunks);
    if (segment.pauseAfterSec === null) continue;

    // A segment the chunker found nothing to speak in still keeps its pause.
    const last = chunks.at(-1);
    if (!last) {
      leadingPauseSec = roundSeconds(clampBreakSeconds(leadingPauseSec + segment.pauseAfterSec));
      continue;
    }
    const seconds = roundSeconds(clampBreakSeconds((segmentChunks.length > 0 ? 0 : lastBreakSec) + segment.pauseAfterSec));
    chunks[chunks.length - 1] = { ...last, pauseAfterSec: seconds, breakPauseSec: seconds };
    lastBreakSec = seconds;
  }

  return { chunks, leadingPauseSec };
}
