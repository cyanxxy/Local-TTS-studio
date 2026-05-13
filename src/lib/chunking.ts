import { MAX_CHUNK_LENGTH, SUPERTONIC_MIN_CHUNK_LENGTH } from "../constants";
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

const PAUSE_SECONDS: Record<ChunkPauseKind, number> = {
  none: 0.08,
  comma: 0.14,
  sentence: 0.24,
  paragraph: 0.44,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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
      if (text[i] === "\n" && text[i + 1] === "\n") break;
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

    for (let i = idealEnd; i > minBreak; i -= 1) {
      const c = text[i];
      if (c === "\n" || c === " " || /[.,;:!?]/.test(c)) {
        splitAt = i + 1;
        break;
      }
    }

    if (splitAt === -1 || splitAt <= cursor) {
      splitAt = idealEnd;
    }

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
  if (/\n{2,}/.test(boundary)) return "paragraph";

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
  let minCharacters = overrides?.minCharacters ?? SUPERTONIC_MIN_CHUNK_LENGTH;
  let maxCharacters = overrides?.maxCharacters ?? MAX_CHUNK_LENGTH;
  let targetCharacters = Math.floor((minCharacters + maxCharacters) / 2);

  if (!overrides?.maxCharacters || !overrides?.minCharacters) {
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

function buildChunkRanges(text: string, units: SemanticUnit[], limits: ChunkingLimits): ChunkRange[] {
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

    const currentLength = current.end - current.start;
    const candidateEnd = unit.end;
    const candidateLength = candidateEnd - current.start;
    const boundary = previousUnit ? text.slice(previousUnit.end, unit.start) : "";
    const paragraphBoundary = /\n{2,}/.test(boundary);
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
  const units = extractSemanticUnits(text, limits.maxCharacters);
  const ranges = buildChunkRanges(text, units, limits);

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

export function chunkTextForModelDetailed(
  text: string,
  model: ModelType,
  options: ChunkingOptions = {},
): TextChunk[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (model === "supertonic") {
    return chunkWithConstraintsDetailed(text, options);
  }

  // Kokoro already does sentence streaming internally; keep preview sentence-level.
  return extractSemanticUnits(text, MAX_CHUNK_LENGTH).map((unit, index, all) => ({
    text: text.slice(unit.start, unit.end),
    start: unit.start,
    end: unit.end,
    pauseAfterSec: index < all.length - 1 ? PAUSE_SECONDS.sentence : 0,
    pauseKind: index < all.length - 1 ? "sentence" : "none",
  }));
}

export function chunkTextForModel(
  text: string,
  model: ModelType,
  options: ChunkingOptions = {},
): string[] {
  return chunkTextForModelDetailed(text, model, options).map((chunk) => chunk.text);
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
