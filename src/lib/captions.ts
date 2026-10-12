import { estimateWordRanges, type EstimatedWordRange } from "./text/wordTiming";

export interface CaptionSegment {
  startSec: number;
  endSec: number;
  text: string;
  /** Optional speaker label, written as a WebVTT `<v>` voice span. */
  speaker?: string;
}

export interface CaptionLayoutOptions {
  /** Longest caption line; 42 is the common YouTube/Netflix limit. */
  maxCharsPerLine?: number;
  maxLines?: number;
  maxDurationSec?: number;
  /** Short cues are held on screen this long when the following silence allows it. */
  minDurationSec?: number;
  /** Word-by-word captions (TikTok/Reels style) when set, for example 1-3 words. */
  maxWordsPerCue?: number;
}

export interface CaptionCue {
  startSec: number;
  endSec: number;
  lines: string[];
  speaker?: string;
}

export interface CaptionBuildOptions {
  /** Cue layout, or `false` for one cue per segment on a single line. */
  layout?: CaptionLayoutOptions | false;
}

const DEFAULT_LAYOUT: Required<Omit<CaptionLayoutOptions, "maxWordsPerCue">> = {
  maxCharsPerLine: 42,
  maxLines: 2,
  maxDurationSec: 7,
  minDurationSec: 0.8,
};

const SENTENCE_END = /[.!?…。？！]["'”’)\]]*$/u;
const CLAUSE_END = /[,;:—–，；：]["'”’)\]]*$/u;

function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function pad3(value: number): string {
  return String(value).padStart(3, "0");
}

function toTimestampParts(seconds: number): { h: number; m: number; s: number; ms: number } {
  const clamped = Math.max(0, seconds);
  const totalMs = Math.round(clamped * 1000);
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return { h, m, s, ms };
}

function toSrtTimestamp(seconds: number): string {
  const parts = toTimestampParts(seconds);
  return `${pad2(parts.h)}:${pad2(parts.m)}:${pad2(parts.s)},${pad3(parts.ms)}`;
}

function toVttTimestamp(seconds: number): string {
  const parts = toTimestampParts(seconds);
  return `${pad2(parts.h)}:${pad2(parts.m)}:${pad2(parts.s)}.${pad3(parts.ms)}`;
}

function normalizeSegments(segments: readonly CaptionSegment[]): CaptionSegment[] {
  return segments
    .map((segment) => {
      const startSec = Math.max(0, segment.startSec);
      const speaker = segment.speaker === undefined ? "" : cleanText(segment.speaker);
      return {
        startSec,
        endSec: Math.max(startSec + 0.01, segment.endSec),
        text: cleanText(segment.text),
        ...(speaker ? { speaker } : {}),
      };
    })
    .filter((segment) => segment.text.length > 0);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

function positiveSeconds(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function joinedLength(words: readonly EstimatedWordRange[], from: number, to: number): number {
  let length = to - from;
  for (let index = from; index <= to; index += 1) length += words[index].word.length;
  return length;
}

/** Fewest lines a greedy wrap needs; a word longer than a line gets its own line. */
function greedyLineCount(words: readonly string[], maxChars: number): number {
  let lines = 1;
  let lineLength = 0;
  for (const word of words) {
    if (lineLength === 0) {
      lineLength = word.length;
    } else if (lineLength + 1 + word.length <= maxChars) {
      lineLength += 1 + word.length;
    } else {
      lines += 1;
      lineLength = word.length;
    }
  }
  return lines;
}

/**
 * Splits words into `lineCount` lines minimizing the longest line, so a
 * two-line cue reads as two similar-length lines instead of a full line and a
 * dangling word.
 */
function balanceLines(words: readonly string[], lineCount: number): string[] {
  const n = words.length;
  const prefix = [0];
  for (const word of words) prefix.push(prefix[prefix.length - 1] + word.length);
  const width = (from: number, to: number) => prefix[to] - prefix[from] + (to - from - 1);

  // best[k][i]: smallest possible longest line when words[0..i) fill k lines.
  const best: number[][] = Array.from({ length: lineCount + 1 }, () => new Array<number>(n + 1).fill(Infinity));
  const cut: number[][] = Array.from({ length: lineCount + 1 }, () => new Array<number>(n + 1).fill(0));
  best[0][0] = 0;
  for (let k = 1; k <= lineCount; k += 1) {
    for (let i = k; i <= n; i += 1) {
      for (let j = k - 1; j < i; j += 1) {
        const cost = Math.max(best[k - 1][j], width(j, i));
        if (cost < best[k][i]) {
          best[k][i] = cost;
          cut[k][i] = j;
        }
      }
    }
  }

  const lines: string[] = [];
  let end = n;
  for (let k = lineCount; k >= 1; k -= 1) {
    const start = cut[k][end];
    lines.unshift(words.slice(start, end).join(" "));
    end = start;
  }
  return lines;
}

/**
 * Picks where to end a cue that cannot take `overflow`: the last sentence
 * end, then the last clause break, as long as the cue stays at least a third
 * full (`minChars`); otherwise just before the overflowing word.
 */
function chooseCueEnd(words: readonly EstimatedWordRange[], start: number, overflow: number, minChars: number): number {
  for (const pattern of [SENTENCE_END, CLAUSE_END]) {
    for (let index = overflow - 1; index > start && joinedLength(words, start, index) >= minChars; index -= 1) {
      if (pattern.test(words[index].word)) return index;
    }
  }
  return overflow - 1;
}

function layoutSegment(segment: CaptionSegment, layout: CaptionLayoutOptions): CaptionCue[] {
  const words = estimateWordRanges(segment.text, 0, segment.startSec, segment.endSec);
  const maxChars = positiveInteger(layout.maxCharsPerLine, DEFAULT_LAYOUT.maxCharsPerLine);
  const maxLines = positiveInteger(layout.maxLines, DEFAULT_LAYOUT.maxLines);
  const maxDuration = positiveSeconds(layout.maxDurationSec, DEFAULT_LAYOUT.maxDurationSec);
  const maxWords = layout.maxWordsPerCue === undefined ? Infinity : positiveInteger(layout.maxWordsPerCue, 1);

  // Whether words[from..to] (to > from) still make one cue.
  const fits = (from: number, to: number): boolean => {
    if (to - from + 1 > maxWords) return false;
    if (words[to].endSec - words[from].startSec > maxDuration) return false;
    if (joinedLength(words, from, to) <= maxChars) return true;
    return greedyLineCount(words.slice(from, to + 1).map((word) => word.word), maxChars) <= maxLines;
  };

  const cues: CaptionCue[] = [];
  let start = 0;
  let index = 0;
  while (start < words.length) {
    while (index + 1 < words.length && fits(start, index + 1)) index += 1;
    const end = index + 1 < words.length ? chooseCueEnd(words, start, index + 1, (maxChars * maxLines) / 3) : index;
    const cueWords = words.slice(start, end + 1).map((word) => word.word);
    const lineCount = Math.min(maxLines, greedyLineCount(cueWords, maxChars));
    cues.push({
      startSec: words[start].startSec,
      endSec: words[end].endSec,
      lines: balanceLines(cueWords, lineCount),
      ...(segment.speaker ? { speaker: segment.speaker } : {}),
    });
    start = end + 1;
    index = start;
  }
  return cues;
}

/**
 * Holds short cues longer when the silence before the next cue allows it.
 * The last cue keeps its end, so captions never run past the speech.
 */
function applyMinimumDuration(cues: CaptionCue[], minDurationSec: number): CaptionCue[] {
  return cues.map((cue, index) => {
    const next = cues[index + 1];
    const wanted = cue.startSec + minDurationSec;
    if (!next || cue.endSec >= wanted) return cue;
    return { ...cue, endSec: Math.min(wanted, Math.max(cue.endSec, next.startSec)) };
  });
}

/**
 * Turns caption segments (one per spoken chunk group) into readable cues: at
 * most `maxLines` balanced lines of `maxCharsPerLine`, at most
 * `maxDurationSec` long, split at sentence or clause ends where possible.
 */
export function layoutCaptionCues(
  segments: readonly CaptionSegment[],
  layout: CaptionLayoutOptions = {},
): CaptionCue[] {
  const cues = normalizeSegments(segments).flatMap((segment) => layoutSegment(segment, layout));
  return applyMinimumDuration(cues, positiveSeconds(layout.minDurationSec, DEFAULT_LAYOUT.minDurationSec));
}

function buildCues(segments: readonly CaptionSegment[], options: CaptionBuildOptions): CaptionCue[] {
  if (options.layout === false) {
    return normalizeSegments(segments).map((segment) => ({
      startSec: segment.startSec,
      endSec: segment.endSec,
      lines: [segment.text],
      ...(segment.speaker ? { speaker: segment.speaker } : {}),
    }));
  }
  return layoutCaptionCues(segments, options.layout);
}

/** Escapes cue payload text for WebVTT, where `&`, `<` and `>` are markup and `-->` ends a cue timing. */
export function escapeVttText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// SRT has no escaping; an arrow in the text can be mistaken for a timing line.
function sanitizeSrtLine(line: string): string {
  return line.replace(/-->/g, "->");
}

export function buildSrt(segments: readonly CaptionSegment[], options: CaptionBuildOptions = {}): string {
  return buildCues(segments, options)
    .map((cue, index) => {
      const lines = cue.lines.map(sanitizeSrtLine);
      if (cue.speaker) lines[0] = `${sanitizeSrtLine(cue.speaker)}: ${lines[0]}`;
      return `${index + 1}\n${toSrtTimestamp(cue.startSec)} --> ${toSrtTimestamp(cue.endSec)}\n${lines.join("\n")}\n`;
    })
    .join("\n");
}

export function buildVtt(segments: readonly CaptionSegment[], options: CaptionBuildOptions = {}): string {
  const body = buildCues(segments, options)
    .map((cue) => {
      const lines = cue.lines.map(escapeVttText);
      if (cue.speaker) lines[0] = `<v ${escapeVttText(cue.speaker)}>${lines[0]}`;
      return `${toVttTimestamp(cue.startSec)} --> ${toVttTimestamp(cue.endSec)}\n${lines.join("\n")}\n`;
    })
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

export function buildCaptionJson(segments: readonly CaptionSegment[]): string {
  const normalized = normalizeSegments(segments);
  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    segments: normalized.map((segment, index) => ({
      id: index + 1,
      text: segment.text,
      ...(segment.speaker ? { speaker: segment.speaker } : {}),
      startSec: Number(segment.startSec.toFixed(3)),
      endSec: Number(segment.endSec.toFixed(3)),
      words: estimateWordRanges(segment.text, 0, segment.startSec, segment.endSec).map((word) => ({
        word: word.word,
        startSec: Number(word.startSec.toFixed(3)),
        endSec: Number(word.endSec.toFixed(3)),
      })),
    })),
  };
  return JSON.stringify(payload, null, 2);
}
