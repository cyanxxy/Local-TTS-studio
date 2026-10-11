import {
  KOKORO_WASM_MAX_INFERENCE_CHARS,
  KOKORO_WEBGPU_MAX_INFERENCE_CHARS,
  MAX_CHUNK_LENGTH,
  SUPERTONIC_MIN_CHUNK_LENGTH,
} from "../constants";
import type { ChunkPauseKind, InferenceBackend, ModelType } from "../types";
import { split } from "./splitter";

export interface TextChunk {
  text: string;
  start: number;
  end: number;
  pauseAfterSec: number;
  pauseKind: ChunkPauseKind;
}

export interface ChunkingRuntimeProfile {
  backend?: InferenceBackend | null;
  quality?: number;
}

interface ChunkingOptions {
  minCharacters?: number;
  maxCharacters?: number;
  runtime?: ChunkingRuntimeProfile;
  /** Caps the first chunk and ramps up from there; see rampedBudget. */
  firstChunkMaxCharacters?: number;
}

interface ChunkingLimits {
  minCharacters: number;
  maxCharacters: number;
  targetCharacters: number;
}

interface SemanticUnit {
  start: number;
  end: number;
  kind: "heading" | "list" | "quote" | "code" | "sentence";
  paragraphIndex: number;
}

interface ChunkRange {
  start: number;
  end: number;
}

interface RetryOptions {
  runtime?: ChunkingRuntimeProfile;
  attempt?: number;
}

interface GraphemeSegment {
  index: number;
  segment: string;
}

interface GraphemeSegmenter {
  segment(input: string): Iterable<GraphemeSegment>;
}

type IntlWithSegmenter = typeof Intl & {
  Segmenter?: new (locale?: string, options?: { granularity: "grapheme" }) => GraphemeSegmenter;
};

const PAUSE_SECONDS: Record<ChunkPauseKind, number> = {
  none: 0.08,
  comma: 0.14,
  sentence: 0.24,
  paragraph: 0.44,
};

// The first unit of a generation is the audio's time to first sound, so it is
// capped well below the full budget; see rampedBudget.
export const KOKORO_FIRST_UNIT_MAX_CHARS = 140;
export const SUPERTONIC_FIRST_CHUNK_MAX_CHARS = 160;
// A capped first unit is cut at a clause break only when the part kept
// before it is at least this share of the cap.
const FIRST_UNIT_MIN_CLAUSE_SHARE = 0.4;

// A clause break, ending after the whitespace that follows it: a comma,
// semicolon, or colon (with any closing quote), a spaced dash, or full-width
// clause punctuation, which needs no space.
const CLAUSE_BREAK = /[,;:]["'”’)\]]*\s+|\s[—–-]\s+|[，；：、]\s*/g;

/** Two consecutive line breaks (LF or CRLF) — a paragraph boundary. */
const PARAGRAPH_BREAK = /\r?\n\r?\n/;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * The character budget of the unit at `index` (0-based) when the first unit
 * is capped at `firstMax`: the cap doubles with each unit until it reaches
 * `fullMax`. Each unit is generated while the previous one plays, so a unit
 * at most twice as long as the one before keeps playback ahead of synthesis.
 */
export function rampedBudget(index: number, firstMax: number | undefined, fullMax: number): number {
  if (firstMax === undefined) return fullMax;
  return Math.min(fullMax, Math.max(1, Math.floor(firstMax)) * 2 ** index);
}

/**
 * Where a leading range longer than `maxChars` can end at its last clause
 * break within the cap: the offset where the rest starts, or null when no
 * clause break keeps a meaningful first part. Sentences are never cut
 * anywhere else, since a cut mid-clause would be audible.
 */
function findLeadingClauseBreak(text: string, start: number, end: number, maxChars: number): number | null {
  if (end - start <= maxChars) return null;
  let best: number | null = null;
  for (const match of text.slice(start, start + maxChars).matchAll(CLAUSE_BREAK)) {
    const offset = start + match.index + match[0].length;
    if (match.index >= maxChars * FIRST_UNIT_MIN_CLAUSE_SHARE && offset < end) best = offset;
  }
  return best;
}

function isParagraphBreakAt(text: string, index: number): boolean {
  let i = index;
  if (text[i] === "\r") i += 1;
  if (text[i] !== "\n") return false;
  i += 1;
  if (text[i] === "\r") i += 1;
  return text[i] === "\n";
}

function isHighSurrogateAt(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 0xD800 && code <= 0xDBFF;
}

function isLowSurrogateAt(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 0xDC00 && code <= 0xDFFF;
}

function adjustSplitToTextBoundary(text: string, cursor: number, splitAt: number, end: number): number {
  if (splitAt <= cursor || splitAt >= end) return splitAt;

  const Segmenter = (Intl as IntlWithSegmenter).Segmenter;
  if (Segmenter) {
    const segmenter = new Segmenter(undefined, { granularity: "grapheme" });
    let previousBoundary = cursor;

    for (const segment of segmenter.segment(text.slice(cursor, end))) {
      const boundary = cursor + segment.index;
      if (boundary === splitAt) return splitAt;
      if (boundary > splitAt) {
        return previousBoundary > cursor ? previousBoundary : boundary;
      }
      previousBoundary = boundary;
    }
    if (previousBoundary > cursor && previousBoundary < splitAt) {
      return previousBoundary;
    }
  }

  if (isHighSurrogateAt(text, splitAt - 1) && isLowSurrogateAt(text, splitAt)) {
    return splitAt - 1 > cursor ? splitAt - 1 : splitAt + 1;
  }

  return splitAt;
}

function getTextBetween(text: string, start: number | undefined, end: number | undefined, fallback: string): string {
  if (start === undefined || end === undefined || start < 0 || end <= start) {
    return fallback;
  }
  return text.slice(start, end);
}

function trimRangeToContent(text: string, start: number, end: number): { start: number; end: number } | null {
  let left = start;
  let right = end;

  while (left < right && /\s/.test(text[left])) left += 1;
  while (right > left && /\s/.test(text[right - 1])) right -= 1;

  if (right <= left) return null;
  return { start: left, end: right };
}

function normalizeParagraphs(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const len = text.length;
  let i = 0;

  while (i < len) {
    while (i < len && /\s/.test(text[i])) i += 1;
    if (i >= len) break;

    const start = i;
    while (i < len) {
      if (isParagraphBreakAt(text, i)) break;
      i += 1;
    }
    ranges.push({ start, end: i });

    while (i < len && text[i] === "\n") i += 1;
  }

  return ranges;
}

function isHeading(paragraph: string): boolean {
  const firstLine = paragraph.split("\n", 1)[0].trim();
  return /^#{1,6}\s+/.test(firstLine) || /^\d+(\.\d+)*[).]\s+/.test(firstLine);
}

function isList(paragraph: string): boolean {
  return paragraph
    .split("\n")
    .some((line) => /^\s*([-*•]\s+|\d+[).]\s+)/.test(line));
}

function isQuote(paragraph: string): boolean {
  return paragraph.trimStart().startsWith(">");
}

function isCode(paragraph: string): boolean {
  const trimmed = paragraph.trimStart();
  return trimmed.startsWith("```")
    || paragraph.split("\n").every((line) => line.startsWith("    "));
}

function normalizeWithMap(text: string): { normalized: string; originalIndices: number[] } {
  const chars: string[] = [];
  const originalIndices: number[] = [];
  let pendingSpace = false;
  let pendingSpaceIndex = -1;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (/\s/.test(c)) {
      if (!pendingSpace) {
        pendingSpace = true;
        pendingSpaceIndex = i;
      }
      continue;
    }

    if (pendingSpace && chars.length > 0) {
      chars.push(" ");
      originalIndices.push(pendingSpaceIndex);
    }

    chars.push(c);
    originalIndices.push(i);
    pendingSpace = false;
    pendingSpaceIndex = -1;
  }

  return { normalized: chars.join(""), originalIndices };
}

function findApproximateRange(container: string, needle: string, from: number): { start: number; end: number } | null {
  const direct = container.indexOf(needle, from);
  if (direct !== -1) return { start: direct, end: direct + needle.length };

  const containerSlice = container.slice(from);
  const containerMap = normalizeWithMap(containerSlice);
  const needleMap = normalizeWithMap(needle);
  const normalizedNeedle = needleMap.normalized.trim();
  if (!normalizedNeedle) return null;

  const normalizedStart = containerMap.normalized.indexOf(normalizedNeedle);
  if (normalizedStart === -1) return null;

  const normalizedEnd = normalizedStart + normalizedNeedle.length - 1;
  if (normalizedEnd >= containerMap.originalIndices.length) return null;

  const localStart = containerMap.originalIndices[normalizedStart];
  const localEnd = containerMap.originalIndices[normalizedEnd] + 1;
  if (localStart === undefined || localEnd === undefined || Number.isNaN(localEnd)) return null;
  return { start: from + localStart, end: from + localEnd };
}

function splitSentenceUnits(
  text: string,
  start: number,
  end: number,
  paragraphIndex: number,
): SemanticUnit[] {
  const paragraph = text.slice(start, end);
  const sentences = split(paragraph).map((value) => value.trim()).filter(Boolean);
  if (sentences.length === 0) {
    return [{
      start,
      end,
      kind: "sentence",
      paragraphIndex,
    }];
  }

  const units: SemanticUnit[] = [];
  let cursor = 0;
  for (const sentence of sentences) {
    const range = findApproximateRange(paragraph, sentence, cursor);
    if (!range) {
      // Keep moving: we recover uncovered spans after attempting sentence alignment.
      continue;
    }

    const gap = trimRangeToContent(text, start + cursor, start + range.start);
    if (gap) {
      units.push({ ...gap, kind: "sentence", paragraphIndex });
    }

    const absoluteStart = start + range.start;
    const absoluteEnd = start + range.end;
    const trimmed = trimRangeToContent(text, absoluteStart, absoluteEnd);
    if (!trimmed) continue;
    units.push({ ...trimmed, kind: "sentence", paragraphIndex });
    cursor = range.end;
  }

  const tail = trimRangeToContent(text, start + cursor, end);
  if (tail) {
    units.push({ ...tail, kind: "sentence", paragraphIndex });
  }

  if (units.length === 0) {
    const trimmed = trimRangeToContent(text, start, end);
    return trimmed ? [{ ...trimmed, kind: "sentence", paragraphIndex }] : [];
  }

  return units;
}

function splitOversizedRange(text: string, start: number, end: number, maxCharacters: number): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = start;

  while (cursor < end) {
    const remaining = end - cursor;
    if (remaining <= maxCharacters) {
      const trimmed = trimRangeToContent(text, cursor, end);
      if (trimmed) ranges.push(trimmed);
      break;
    }

    const idealEnd = cursor + maxCharacters;
    const minBreak = cursor + Math.floor(maxCharacters * 0.45);
    let splitAt = -1;

    // Scan from idealEnd - 1 so `splitAt = i + 1` never exceeds maxCharacters.
    for (let i = idealEnd - 1; i > minBreak; i -= 1) {
      const c = text[i];
      if (c === "\n" || c === " " || /[.,;:!?]/.test(c)) {
        splitAt = i + 1;
        break;
      }
    }

    if (splitAt === -1 || splitAt <= cursor) {
      splitAt = idealEnd;
    }
    splitAt = adjustSplitToTextBoundary(text, cursor, splitAt, end);

    const trimmed = trimRangeToContent(text, cursor, splitAt);
    if (trimmed) ranges.push(trimmed);
    cursor = splitAt;
  }

  return ranges;
}

function extractSemanticUnits(text: string, maxCharacters: number): SemanticUnit[] {
  const paragraphs = normalizeParagraphs(text);
  const units: SemanticUnit[] = [];

  for (const [paragraphIndex, paragraphRange] of paragraphs.entries()) {
    const paragraphText = text.slice(paragraphRange.start, paragraphRange.end);
    const trimmedParagraph = trimRangeToContent(text, paragraphRange.start, paragraphRange.end);
    if (!trimmedParagraph) continue;

    let paragraphUnits: SemanticUnit[];
    if (isCode(paragraphText)) {
      paragraphUnits = [{ ...trimmedParagraph, kind: "code", paragraphIndex }];
    } else if (isHeading(paragraphText)) {
      paragraphUnits = [{ ...trimmedParagraph, kind: "heading", paragraphIndex }];
    } else if (isList(paragraphText)) {
      paragraphUnits = [{ ...trimmedParagraph, kind: "list", paragraphIndex }];
    } else if (isQuote(paragraphText)) {
      paragraphUnits = [{ ...trimmedParagraph, kind: "quote", paragraphIndex }];
    } else {
      paragraphUnits = splitSentenceUnits(text, trimmedParagraph.start, trimmedParagraph.end, paragraphIndex);
    }

    for (const unit of paragraphUnits) {
      const length = unit.end - unit.start;
      if (length <= maxCharacters) {
        units.push(unit);
        continue;
      }

      const subRanges = splitOversizedRange(text, unit.start, unit.end, maxCharacters);
      subRanges.forEach((range) => units.push({ ...range, kind: unit.kind, paragraphIndex: unit.paragraphIndex }));
    }
  }

  return units;
}

function resolvePauseKind(text: string, current: ChunkRange, next: ChunkRange | null): ChunkPauseKind {
  if (!next) return "none";

  const boundary = text.slice(current.end, next.start);
  if (PARAGRAPH_BREAK.test(boundary)) return "paragraph";
  // The Reader renders every line as its own paragraph, and a line with no
  // closing punctuation is a heading; both deserve more than a sentence gap.
  if (boundary.includes("\n") && !/[.!?。？！…]["'”’)\]]*$/.test(text.slice(current.start, current.end))) {
    return "paragraph";
  }

  const currentText = text.slice(current.start, current.end);
  const punctuationMatch = currentText.match(/([,;:!?。？！.]?)(\s*)$/);
  const trailing = punctuationMatch?.[1] ?? "";

  if (/[,:;]/.test(trailing)) return "comma";
  if (/[.!?。？！]/.test(trailing) || boundary.includes("\n")) return "sentence";
  return "none";
}

export function getAdaptiveChunkLimits(
  runtime?: ChunkingRuntimeProfile,
  overrides?: Pick<ChunkingOptions, "minCharacters" | "maxCharacters">,
): ChunkingLimits {
  const hasMinOverride = typeof overrides?.minCharacters === "number";
  const hasMaxOverride = typeof overrides?.maxCharacters === "number";
  let minCharacters = SUPERTONIC_MIN_CHUNK_LENGTH;
  let maxCharacters = MAX_CHUNK_LENGTH;
  let targetCharacters = Math.floor((minCharacters + maxCharacters) / 2);

  if (runtime?.backend === "wasm") {
    minCharacters = 60;
    maxCharacters = 280;
    targetCharacters = 200;
  } else if (runtime?.backend === "webgpu") {
    minCharacters = 120;
    maxCharacters = MAX_CHUNK_LENGTH;
    targetCharacters = 320;
  }

  const quality = runtime?.quality ?? 5;
  if (quality >= 14) {
    minCharacters = Math.floor(minCharacters * 0.72);
    maxCharacters = Math.floor(maxCharacters * 0.55);
    targetCharacters = Math.floor(targetCharacters * 0.6);
  } else if (quality >= 10) {
    minCharacters = Math.floor(minCharacters * 0.85);
    maxCharacters = Math.floor(maxCharacters * 0.72);
    targetCharacters = Math.floor(targetCharacters * 0.78);
  } else if (quality <= 3 && runtime?.backend === "webgpu") {
    maxCharacters = Math.floor(maxCharacters * 1.05);
    targetCharacters = Math.floor(targetCharacters * 1.08);
  }

  if (hasMinOverride) {
    minCharacters = overrides.minCharacters!;
  }
  if (hasMaxOverride) {
    maxCharacters = overrides.maxCharacters!;
  }
  if (hasMinOverride && hasMaxOverride) {
    targetCharacters = Math.floor((minCharacters + maxCharacters) / 2);
  }

  maxCharacters = clamp(maxCharacters, 80, MAX_CHUNK_LENGTH);
  minCharacters = clamp(minCharacters, 40, Math.max(60, maxCharacters - 40));
  targetCharacters = clamp(targetCharacters, minCharacters, maxCharacters);

  return {
    minCharacters,
    maxCharacters,
    targetCharacters,
  };
}

/** The limits for the chunk at `index` when the first chunk is capped; see rampedBudget. */
function rampLimits(limits: ChunkingLimits, index: number, firstMax: number | undefined): ChunkingLimits {
  const maxCharacters = rampedBudget(index, firstMax, limits.maxCharacters);
  if (maxCharacters === limits.maxCharacters) return limits;
  return {
    minCharacters: Math.min(limits.minCharacters, maxCharacters),
    maxCharacters,
    targetCharacters: Math.min(limits.targetCharacters, maxCharacters),
  };
}

/** Cuts a leading sentence longer than the first chunk's cap at a clause break. */
function splitLeadingSentence(text: string, units: SemanticUnit[], firstMax: number | undefined): SemanticUnit[] {
  const [first, ...rest] = units;
  if (firstMax === undefined || first?.kind !== "sentence") return units;
  const breakAt = findLeadingClauseBreak(text, first.start, first.end, firstMax);
  const head = breakAt === null ? null : trimRangeToContent(text, first.start, breakAt);
  if (breakAt === null || !head) return units;
  return [{ ...first, ...head }, { ...first, start: breakAt }, ...rest];
}

function buildChunkRanges(
  text: string,
  units: SemanticUnit[],
  fullLimits: ChunkingLimits,
  firstChunkMaxCharacters?: number,
): ChunkRange[] {
  if (units.length === 0) return [];

  const ranges: ChunkRange[] = [];
  let current: ChunkRange | null = null;
  let previousUnit: SemanticUnit | null = null;

  const flushCurrent = () => {
    if (!current) return;
    const trimmed = trimRangeToContent(text, current.start, current.end);
    if (trimmed) ranges.push(trimmed);
    current = null;
  };

  for (const unit of units) {
    if (!current) {
      current = { start: unit.start, end: unit.end };
      previousUnit = unit;
      continue;
    }

    const limits = rampLimits(fullLimits, ranges.length, firstChunkMaxCharacters);
    const currentLength = current.end - current.start;
    const candidateEnd = unit.end;
    const candidateLength = candidateEnd - current.start;
    const boundary = previousUnit ? text.slice(previousUnit.end, unit.start) : "";
    const paragraphBoundary = PARAGRAPH_BREAK.test(boundary);
    const paragraphChanged = previousUnit ? unit.paragraphIndex !== previousUnit.paragraphIndex : false;
    const strongKind = unit.kind === "heading" || unit.kind === "list" || unit.kind === "quote" || unit.kind === "code";
    const previousStrong = previousUnit?.kind === "heading"
      || previousUnit?.kind === "list"
      || previousUnit?.kind === "quote"
      || previousUnit?.kind === "code";

    const shouldBreakBefore =
      paragraphChanged
      || candidateLength > limits.maxCharacters
      || previousStrong
      || (paragraphBoundary && currentLength >= limits.minCharacters)
      || (strongKind && currentLength >= Math.floor(limits.minCharacters * 0.5));

    if (shouldBreakBefore) {
      flushCurrent();
      current = { start: unit.start, end: unit.end };
      previousUnit = unit;
      continue;
    }

    current.end = candidateEnd;
    const nextLength = current.end - current.start;
    if (nextLength >= limits.targetCharacters && (paragraphBoundary || unit.kind === "sentence" || strongKind)) {
      flushCurrent();
    }

    previousUnit = unit;
  }

  flushCurrent();
  return ranges;
}

export function chunkWithConstraintsDetailed(
  text: string,
  options: ChunkingOptions = {},
): TextChunk[] {
  if (!text.trim()) return [];

  const limits = getAdaptiveChunkLimits(options.runtime, options);
  const firstMax = options.firstChunkMaxCharacters;
  const units = splitLeadingSentence(text, extractSemanticUnits(text, limits.maxCharacters), firstMax);
  const ranges = buildChunkRanges(text, units, limits, firstMax);

  return ranges.map((range, index) => {
    const next = ranges[index + 1] ?? null;
    const pauseKind = resolvePauseKind(text, range, next);
    const pauseAfterSec = next ? PAUSE_SECONDS[pauseKind] : 0;
    return {
      text: text.slice(range.start, range.end),
      start: range.start,
      end: range.end,
      pauseAfterSec,
      pauseKind,
    };
  });
}

export function chunkWithConstraints(
  text: string,
  options: ChunkingOptions = {},
): string[] {
  return chunkWithConstraintsDetailed(text, options).map((chunk) => chunk.text);
}

export interface KokoroInferenceUnit {
  text: string;
  start?: number;
  end?: number;
}

/** Per-backend character budget for merging adjacent sentences into one Kokoro inference unit. */
export function getKokoroMaxInferenceChars(backend?: InferenceBackend | null): number {
  return backend === "webgpu"
    ? KOKORO_WEBGPU_MAX_INFERENCE_CHARS
    : KOKORO_WASM_MAX_INFERENCE_CHARS;
}

function buildKokoroSentenceRanges(text: string): KokoroInferenceUnit[] {
  const sentences = split(text).map((value) => value.trim()).filter(Boolean);
  const baseUnits = (sentences.length > 0 ? sentences : [text.trim()]).filter(Boolean);
  const units: KokoroInferenceUnit[] = [];
  let searchCursor = 0;

  for (const unitText of baseUnits) {
    let start = text.indexOf(unitText, searchCursor);
    if (start < 0) start = text.indexOf(unitText);
    const end = start >= 0 ? start + unitText.length : undefined;
    if (end !== undefined) searchCursor = end;
    units.push({ text: unitText, start: start >= 0 ? start : undefined, end });
  }

  return units;
}

function splitOversizedKokoroUnit(
  text: string,
  unit: KokoroInferenceUnit,
  maxInferenceChars: number,
): KokoroInferenceUnit[] {
  if (unit.text.length <= maxInferenceChars) return [unit];

  if (unit.start !== undefined && unit.end !== undefined) {
    return splitOversizedRange(text, unit.start, unit.end, maxInferenceChars).map((range) => ({
      text: text.slice(range.start, range.end),
      start: range.start,
      end: range.end,
    }));
  }

  return splitOversizedRange(unit.text, 0, unit.text.length, maxInferenceChars).map((range) => ({
    text: unit.text.slice(range.start, range.end),
  }));
}

/** Cuts a leading sentence longer than the first unit's cap at a clause break. */
function splitLeadingKokoroSentence(
  text: string,
  units: KokoroInferenceUnit[],
  firstMax: number | undefined,
): KokoroInferenceUnit[] {
  const [first, ...rest] = units;
  if (firstMax === undefined || first?.start === undefined || first.end === undefined) return units;
  const breakAt = findLeadingClauseBreak(text, first.start, first.end, firstMax);
  const head = breakAt === null ? null : trimRangeToContent(text, first.start, breakAt);
  if (breakAt === null || !head) return units;
  return [
    { text: text.slice(head.start, head.end), start: head.start, end: head.end },
    { text: text.slice(breakAt, first.end), start: breakAt, end: first.end },
    ...rest,
  ];
}

/**
 * Builds the inference units Kokoro actually generates: sentences are merged
 * greedily until the per-backend character budget is reached. Shared by the
 * worker (to drive generation) and the reader preview (to draw matching section
 * boundaries), so the editor never shows more sections than are produced.
 *
 * With `firstUnitMaxChars`, the budget ramps up from that cap (see
 * rampedBudget) and a longer first sentence is cut at a clause break, so the
 * first audio arrives sooner.
 */
export function buildKokoroInferenceUnits(
  text: string,
  maxInferenceChars: number,
  { firstUnitMaxChars }: { firstUnitMaxChars?: number } = {},
): KokoroInferenceUnit[] {
  const safeMaxInferenceChars = Math.max(1, Math.floor(maxInferenceChars));
  const sentenceUnits = splitLeadingKokoroSentence(
    text,
    buildKokoroSentenceRanges(text).flatMap((unit) => splitOversizedKokoroUnit(text, unit, safeMaxInferenceChars)),
    firstUnitMaxChars,
  );
  if (sentenceUnits.length === 0) return [];

  const mergedUnits: KokoroInferenceUnit[] = [];
  let current: KokoroInferenceUnit | null = null;

  const flushCurrent = () => {
    if (current) mergedUnits.push(current);
    current = null;
  };

  for (const unit of sentenceUnits) {
    if (!current) {
      current = { ...unit };
      continue;
    }

    const budget = rampedBudget(mergedUnits.length, firstUnitMaxChars, safeMaxInferenceChars);
    // Every line in the Reader is its own paragraph (or a heading), so a unit
    // never crosses a line break: the break becomes a real pause instead of
    // the heading running straight into the text it introduces.
    const crossesLineBreak = current.end !== undefined
      && unit.start !== undefined
      && text.slice(current.end, unit.start).includes("\n");
    const canMergeByRange: boolean = !crossesLineBreak
      && current.start !== undefined
      && unit.end !== undefined
      && unit.end > current.start
      && unit.end - current.start <= budget;
    const fallbackText = `${current.text} ${unit.text}`;
    const candidateText: string = canMergeByRange
      ? getTextBetween(text, current.start, unit.end, fallbackText)
      : fallbackText;
    const canMergeByText = current.start === undefined
      && unit.start === undefined
      && candidateText.length <= budget;

    if (canMergeByRange || canMergeByText) {
      current = { text: candidateText, start: current.start, end: unit.end };
      continue;
    }

    flushCurrent();
    current = { ...unit };
  }

  flushCurrent();
  return mergedUnits;
}

/**
 * Kokoro's generation units with the pause that follows each one. The worker
 * generates exactly these, and the Reader draws the same boundaries, so the
 * paragraph and comma pause settings apply to Kokoro as they do to Supertonic.
 */
export function chunkForKokoroDetailed(text: string, runtime?: ChunkingRuntimeProfile): TextChunk[] {
  const maxInferenceChars = getKokoroMaxInferenceChars(runtime?.backend);
  const units = buildKokoroInferenceUnits(text, maxInferenceChars, { firstUnitMaxChars: KOKORO_FIRST_UNIT_MAX_CHARS });

  return units.map((unit, index, all) => {
    const start = unit.start ?? 0;
    const end = unit.end ?? text.length;
    const next = all[index + 1];
    const pauseKind: ChunkPauseKind = !next
      ? "none"
      : unit.end !== undefined && next.start !== undefined
        ? resolvePauseKind(text, { start, end }, { start: next.start, end: next.end ?? text.length })
        : "sentence";
    return {
      text: unit.start !== undefined && unit.end !== undefined ? text.slice(start, end) : unit.text,
      start,
      end,
      pauseAfterSec: next ? PAUSE_SECONDS[pauseKind] : 0,
      pauseKind,
    };
  });
}

/**
 * Supertonic's chunks with the first chunk capped, so its first audio
 * arrives sooner. The Supertonic workers generate exactly these and the
 * Reader previews the same boundaries.
 */
export function chunkForSupertonicDetailed(text: string, options: ChunkingOptions = {}): TextChunk[] {
  return chunkWithConstraintsDetailed(text, { firstChunkMaxCharacters: SUPERTONIC_FIRST_CHUNK_MAX_CHARS, ...options });
}

export function chunkTextForModelDetailed(
  text: string,
  model: ModelType,
  options: ChunkingOptions = {},
): TextChunk[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (model === "supertonic") {
    return chunkForSupertonicDetailed(text, options);
  }

  // Kokoro merges adjacent sentences per backend budget; mirror that here so the
  // reader preview boundaries match the segments generation will emit.
  return chunkForKokoroDetailed(text, options.runtime);
}

export function chunkTextForModel(
  text: string,
  model: ModelType,
  options: ChunkingOptions = {},
): string[] {
  return chunkTextForModelDetailed(text, model, options).map((chunk) => chunk.text);
}

// Boundaries a split may follow, most natural first: a sentence end, a
// clause break, then any space. Each pattern ends after the whitespace that
// follows the boundary (full-width punctuation needs none), so a split never
// separates a word from its punctuation.
const SPLIT_BOUNDARY_TIERS = [
  /[.!?…]["'”’)\]]*\s+|[。？！]["'”’」』)\]]*\s*/g,
  CLAUSE_BREAK,
  /\s+/g,
];
// A tier is used only when its best boundary leaves each part at least this
// share of the text; otherwise a less natural but more even boundary wins.
const SPLIT_MIN_SIDE_SHARE = 0.2;

/**
 * Where to cut `text` in two near its middle, preferring a sentence end,
 * then a clause break, then a space, and only as a last resort the grapheme
 * boundary closest to the middle. Returns the offset where the second part
 * starts: text.slice(0, offset).trimEnd() and text.slice(offset) are both
 * non-empty. Returns null when the text cannot be split that way.
 */
export function findSplitNearMiddle(text: string): number | null {
  const contentEnd = text.trimEnd().length;
  const contentStart = text.length - text.trimStart().length;
  if (contentEnd - contentStart < 2) return null;
  const middle = (contentStart + contentEnd) / 2;
  const minSide = (contentEnd - contentStart) * SPLIT_MIN_SIDE_SHARE;
  let fallback: number | null = null;

  for (const tier of SPLIT_BOUNDARY_TIERS) {
    let best: number | null = null;
    for (const match of text.matchAll(tier)) {
      const offset = match.index + match[0].length;
      // Both parts must keep some content.
      if (match.index <= contentStart || offset >= contentEnd) continue;
      if (best === null || Math.abs(offset - middle) < Math.abs(best - middle)) best = offset;
    }
    if (best === null) continue;
    if (best - contentStart >= minSide && contentEnd - best >= minSide) return best;
    fallback ??= best;
  }
  if (fallback !== null) return fallback;

  // One unbroken run, such as a long number or URL: cut between graphemes.
  const hardSplit = adjustSplitToTextBoundary(text, contentStart, Math.floor(middle), contentEnd);
  return hardSplit > contentStart && hardSplit < contentEnd ? hardSplit : null;
}

export function rechunkChunkForRetry(
  chunk: TextChunk,
  options: RetryOptions = {},
): TextChunk[] {
  const chunkLength = chunk.end - chunk.start;
  if (chunkLength < 120) return [chunk];

  const base = getAdaptiveChunkLimits(options.runtime);
  const retryMax = clamp(Math.floor(chunkLength * 0.62), 90, Math.max(120, Math.floor(base.maxCharacters * 0.75)));
  if (retryMax >= chunkLength - 8) return [chunk];

  const retryChunks = chunkWithConstraintsDetailed(chunk.text, {
    minCharacters: Math.max(40, Math.floor(retryMax * 0.45)),
    maxCharacters: retryMax,
    runtime: options.runtime,
  });

  if (retryChunks.length <= 1) return [chunk];

  const mapped = retryChunks.map((retryChunk) => ({
    ...retryChunk,
    start: chunk.start + retryChunk.start,
    end: chunk.start + retryChunk.end,
  }));

  // Preserve the parent boundary pause on the final retry chunk.
  mapped[mapped.length - 1] = {
    ...mapped[mapped.length - 1],
    pauseAfterSec: chunk.pauseAfterSec,
    pauseKind: chunk.pauseKind,
  };

  return mapped;
}
