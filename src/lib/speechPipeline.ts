/**
 * The spoken-text pipeline every engine shares.
 *
 * Source text goes through, in order: optional cleanup, the pronunciation
 * dictionary, opt-in English normalization, then inline break tags. The result
 * (the plan's `spoken` text) is what an engine is asked to say. The plan keeps
 * an offset map back to the source, so the chunk ranges an engine reports,
 * Reader highlighting and captions all point at the text the user wrote
 * (`createChunkRemapper`).
 *
 * Break tags become real silences without any engine support. The text is cut
 * at each tag and the pieces are joined with a boundary every chunker honours:
 * a blank line, or for engines that merge paragraphs into one request (Qwen3),
 * a pause mark its request plan splits at. The remapper then sets the silence
 * after the chunk that ends at a boundary to exactly the requested length.
 *
 * Text that needs none of this (no rules, no normalization, no cleanup, no
 * tags) takes an identity plan: the engine receives the source untouched.
 */
import { concatFloat32Arrays, createSilence } from "./audio";
import { encodeSpeechBreakMark, stripSpeechBreakMarks } from "./speechBreakMarks";
import { cleanupText, DEFAULT_TEXT_CLEANUP_ACTIONS, type TextCleanupAction } from "./text/cleanup";
import { isSpeechNormalizationSupported } from "./text/normalize";
import { MAX_BREAK_SEC, parseSpeechBreaks } from "./text/speechMarkup";
import { buildSpeechTextRewrite } from "./text/speechText";
import { applyTextEdits, chainTextRewrites, type TextOffsetMap, type TextRange } from "./text/textEdits";
import type { PronunciationMatchRule } from "./textTuning";

export interface SpeechPipelineSettings {
  /** Flattened pronunciation dictionary rules. */
  rules: readonly PronunciationMatchRule[];
  /** Read numbers, dates and symbols as words, where the language has a normalizer. */
  normalize: boolean;
  /** Clean citations, URLs, emoji and Markdown out of the text before speaking it. */
  cleanup: boolean;
  cleanupActions?: readonly TextCleanupAction[];
  /** BCP-47 language of the engine; picks the normalizer. Omitted means English. */
  language?: string;
}

/**
 * How a pause is forced between two pieces of text.
 * - `paragraph`: a blank line, which every chunker treats as a passage boundary.
 * - `mark`: a private-use mark carrying the pause, for engines whose request
 *   plans split on it (Qwen3) and which pause natively there.
 */
export type SpeechBreakBoundary = "paragraph" | "mark";

export const INACTIVE_SPEECH_PIPELINE: SpeechPipelineSettings = Object.freeze({
  rules: [],
  normalize: false,
  cleanup: false,
});

/** A pause in the spoken text: the boundary's character range and the silence it asks for. */
export interface SpokenBreak {
  start: number;
  end: number;
  seconds: number;
}

export interface SpeechPlan {
  source: string;
  /** What the engine is asked to say. */
  spoken: string;
  boundary: SpeechBreakBoundary;
  breaks: readonly SpokenBreak[];
  /** Silence to play before the first passage. */
  leadingPauseSec: number;
  /** The engine receives the source unchanged. */
  identity: boolean;
  /** Maps a range of `spoken` to the smallest range of `source` covering it. */
  toSourceRange(range: TextRange): TextRange;
  /** Maps a range of `source` to the range of `spoken` it became. */
  toSpokenRange(range: TextRange): TextRange;
}

interface Piece {
  sourceStart: number;
  spokenStart: number;
  spokenEnd: number;
  map: TextOffsetMap;
  pauseAfterSec: number | null;
}

const PARAGRAPH_BOUNDARY = "\n\n";

function identityPlan(source: string, boundary: SpeechBreakBoundary): SpeechPlan {
  const clampRange = (range: TextRange): TextRange => {
    const start = Math.min(source.length, Math.max(0, range.start));
    return { start, end: Math.min(source.length, Math.max(start, range.end)) };
  };
  return {
    source,
    spoken: source,
    boundary,
    breaks: [],
    leadingPauseSec: 0,
    identity: true,
    toSourceRange: clampRange,
    toSpokenRange: clampRange,
  };
}

function clampPause(seconds: number): number {
  return Math.min(MAX_BREAK_SEC, Math.round(seconds * 1000) / 1000);
}

/** Whether the settings change spoken text at all (break tags aside). */
export function isSpeechPipelineActive(settings: SpeechPipelineSettings): boolean {
  return settings.rules.length > 0
    || settings.cleanup
    || (settings.normalize && isSpeechNormalizationSupported(settings.language));
}

/**
 * A stable description of what the settings do to text, for cache signatures,
 * or undefined when they do nothing. Break tags live in the text itself, so
 * they are not part of it.
 */
export function describeSpeechPipeline(settings: SpeechPipelineSettings): string | undefined {
  if (!isSpeechPipelineActive(settings)) return undefined;
  return JSON.stringify({
    version: 1,
    rules: settings.rules.map((rule) => [rule.from, rule.to, rule.caseSensitive ?? null, rule.scope ?? null]),
    normalize: settings.normalize && isSpeechNormalizationSupported(settings.language) ? (settings.language ?? "en") : null,
    cleanup: settings.cleanup ? [...(settings.cleanupActions ?? DEFAULT_TEXT_CLEANUP_ACTIONS)] : null,
  });
}

function rewritePiece(text: string, settings: SpeechPipelineSettings, boundary: SpeechBreakBoundary): TextOffsetMap {
  const cleaned = settings.cleanup
    ? cleanupText(text, { actions: settings.cleanupActions })
    : null;
  const normalization = settings.normalize && isSpeechNormalizationSupported(settings.language)
    ? { language: settings.language }
    : false;
  const spoken = buildSpeechTextRewrite(cleaned?.text ?? text, { pronunciationRules: settings.rules, normalization });
  let map: TextOffsetMap = cleaned ? chainTextRewrites(cleaned, spoken) : spoken;
  if (boundary === "mark" && stripSpeechBreakMarks(spoken.text) !== spoken.text) {
    // Text that already contains a pause mark must not split the request.
    const marks = [...spoken.text.matchAll(/[-]/g)]
      .map((match) => ({ start: match.index, end: match.index + 1, replacement: "" }));
    map = chainTextRewrites(map, applyTextEdits(spoken.text, marks));
  }
  return map;
}

/**
 * Builds the spoken form of `source`. Cheap enough to rebuild on every edit:
 * an inactive pipeline on text without break tags returns at once.
 */
export function buildSpeechPlan(
  source: string,
  settings: SpeechPipelineSettings,
  boundary: SpeechBreakBoundary = "paragraph",
): SpeechPlan {
  const parsed = parseSpeechBreaks(source);
  const hasBreaks = parsed.breaks.length > 0;
  const needsMarkStrip = boundary === "mark" && stripSpeechBreakMarks(source) !== source;
  if (!hasBreaks && !needsMarkStrip && !isSpeechPipelineActive(settings)) return identityPlan(source, boundary);

  const sourcePieces = hasBreaks
    ? parsed.segments.map((segment) => ({ start: segment.start, end: segment.end, pause: segment.pauseAfterSec }))
    : [{ start: 0, end: source.length, pause: null }];

  const pieces: Piece[] = [];
  let leadingPauseSec = parsed.leadingPauseSec;
  let spoken = "";
  const breaks: SpokenBreak[] = [];
  const closePiece = (piece: Piece | undefined, pause: number | null) => {
    if (pause === null) return;
    if (!piece) {
      leadingPauseSec = clampPause(leadingPauseSec + pause);
      return;
    }
    piece.pauseAfterSec = clampPause((piece.pauseAfterSec ?? 0) + pause);
  };

  for (const sourcePiece of sourcePieces) {
    const map = rewritePiece(source.slice(sourcePiece.start, sourcePiece.end), settings, boundary);
    if (hasBreaks && map.text.trim() === "") {
      // Nothing left to say; its pause still counts.
      closePiece(pieces.at(-1), sourcePiece.pause);
      continue;
    }
    pieces.push({
      sourceStart: sourcePiece.start,
      spokenStart: 0,
      spokenEnd: 0,
      map,
      pauseAfterSec: sourcePiece.pause,
    });
  }

  for (const piece of pieces) {
    piece.spokenStart = spoken.length;
    spoken += piece.map.text;
    piece.spokenEnd = spoken.length;
    if (piece.pauseAfterSec === null) continue;
    const mark = boundary === "mark" ? encodeSpeechBreakMark(piece.pauseAfterSec) : PARAGRAPH_BOUNDARY;
    breaks.push({ start: spoken.length, end: spoken.length + mark.length, seconds: piece.pauseAfterSec });
    spoken += mark;
  }

  const pieceAt = (offset: number, preferEarlier: boolean): Piece | undefined => {
    let found: Piece | undefined;
    for (const piece of pieces) {
      if (preferEarlier ? piece.spokenStart < offset : piece.spokenStart <= offset) found = piece;
      else break;
    }
    return found;
  };
  const sourceEnd = (piece: Piece) => piece.sourceStart + piece.map.source.length;
  const toSourceRange = (range: TextRange): TextRange => {
    const first = pieces[0];
    if (!first) return { start: 0, end: 0 };
    const startPiece = pieceAt(range.start, false) ?? first;
    const endPiece = pieceAt(range.end, true) ?? first;
    const start = range.start >= startPiece.spokenEnd
      ? sourceEnd(startPiece)
      : startPiece.sourceStart + startPiece.map.toSourceOffset(Math.max(0, range.start - startPiece.spokenStart));
    const end = range.end <= endPiece.spokenStart
      ? endPiece.sourceStart
      : range.end >= endPiece.spokenEnd
        ? sourceEnd(endPiece)
        : endPiece.sourceStart + endPiece.map.toSourceRange({
          start: 0,
          end: range.end - endPiece.spokenStart,
        }).end;
    return { start, end: Math.max(start, end) };
  };

  const toSpokenRange = (range: TextRange): TextRange => {
    const first = pieces[0];
    if (!first) return { start: 0, end: 0 };
    let startPiece = first;
    let endPiece = first;
    for (const piece of pieces) {
      if (piece.sourceStart <= range.start) startPiece = piece;
      if (piece.sourceStart < range.end) endPiece = piece;
    }
    const localOffset = (piece: Piece, offset: number) => (
      offset >= sourceEnd(piece)
        ? piece.spokenEnd
        : piece.spokenStart + piece.map.toOutputOffset(Math.max(0, offset - piece.sourceStart))
    );
    const start = localOffset(startPiece, range.start);
    return { start, end: Math.max(start, localOffset(endPiece, range.end)) };
  };

  return {
    source,
    spoken,
    boundary,
    breaks,
    leadingPauseSec,
    identity: false,
    toSourceRange,
    toSpokenRange,
  };
}

/** The fields of an audio chunk the remapper reads and rewrites. */
export interface RemappableChunk {
  audio: Float32Array;
  samplingRate: number;
  text?: string;
  textStart?: number;
  textEnd?: number;
  pauseAfterSec?: number;
}

export interface ChunkRemapper {
  /** Remaps one chunk, in arrival order. */
  map<T extends RemappableChunk>(chunk: T): T;
  /** Starts a new generation: the leading pause is owed again. */
  reset(): void;
}

/** The break whose boundary a chunk ending at `end` runs up to, if any. */
function breakEndingAt(plan: SpeechPlan, start: number, end: number): SpokenBreak | undefined {
  return plan.breaks.find((boundary) => (
    start < boundary.start && end >= boundary.start && end <= boundary.end
  ));
}

/** Replaces the silence the engine appended after a chunk with `seconds` of it. */
function withPauseAfter(chunk: RemappableChunk, seconds: number): Float32Array {
  const appended = Math.min(chunk.audio.length, Math.round((chunk.pauseAfterSec ?? 0) * chunk.samplingRate));
  return concatFloat32Arrays([
    chunk.audio.subarray(0, chunk.audio.length - appended),
    createSilence(seconds, chunk.samplingRate),
  ]);
}

/**
 * Maps the chunks an engine produced for `plan.spoken` back to the source:
 * ranges and text point at what the user wrote, a break's silence is exact,
 * and the leading pause is prepended to the first chunk.
 */
export function createChunkRemapper(plan: SpeechPlan): ChunkRemapper {
  let leadingOwed = plan.leadingPauseSec > 0;
  return {
    reset() {
      leadingOwed = plan.leadingPauseSec > 0;
    },
    map(chunk) {
      if (plan.identity) return chunk;

      const hasRange = chunk.textStart !== undefined && chunk.textEnd !== undefined;
      const spokenStart = chunk.textStart ?? 0;
      const spokenEnd = chunk.textEnd ?? plan.spoken.length;
      let audio = chunk.audio;
      let pauseAfterSec = chunk.pauseAfterSec;

      if (plan.boundary === "paragraph" && hasRange) {
        const boundary = breakEndingAt(plan, spokenStart, spokenEnd);
        if (boundary) {
          audio = withPauseAfter(chunk, boundary.seconds);
          pauseAfterSec = boundary.seconds;
        }
      }
      if (leadingOwed) {
        leadingOwed = false;
        audio = concatFloat32Arrays([createSilence(plan.leadingPauseSec, chunk.samplingRate), audio]);
      }
      if (!hasRange) return { ...chunk, audio, pauseAfterSec };

      const range = plan.toSourceRange({ start: spokenStart, end: spokenEnd });
      return {
        ...chunk,
        audio,
        pauseAfterSec,
        text: plan.source.slice(range.start, range.end),
        textStart: range.start,
        textEnd: range.end,
      };
    },
  };
}
