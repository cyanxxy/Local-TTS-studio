/**
 * Whole-script preflight: what each chunk will say, the pause after it, and
 * a duration estimate, before anything is generated.
 *
 * The engine's chunker is a parameter, so the preview splits text exactly as
 * generation will. Break tags force boundaries and their pauses
 * (`chunkWithSpeechBreaks`); every chunk's spoken text comes from
 * `buildSpeechTextRewrite`, with a diff against what was written.
 */
import type { ChunkPauseKind } from "../../types";
import { resolveChunkPauseSeconds, type PronunciationMatchRule } from "../textTuning";
import type { SpeechNormalizationOptions } from "./normalize";
import { chunkWithSpeechBreaks, type BreakAwareChunk } from "./speechMarkup";
import { buildSpeechTextRewrite } from "./speechText";
import { buildTextDiff, type TextDiffPart } from "./textEdits";

/**
 * Typical narration rate at speed 1.0 in spoken characters per second
 * (about 160 words per minute). Pass a measured rate for a specific engine.
 */
export const DEFAULT_CHARACTERS_PER_SECOND = 14;

export interface ScriptPreflightOptions {
  /** The engine's chunker, for example `(text) => chunkTextForModelDetailed(text, model, options)`. */
  chunk: (text: string) => BreakAwareChunk[];
  pronunciationRules?: readonly PronunciationMatchRule[];
  normalization?: SpeechNormalizationOptions | false;
  pauseOverridesSec?: Partial<Record<ChunkPauseKind, number>>;
  /** Generation speed multiplier; defaults to 1. */
  speed?: number;
  charactersPerSecond?: number;
}

export interface PreflightChunk {
  index: number;
  /** Source range of the chunk. */
  start: number;
  end: number;
  /** Written text of the chunk. */
  text: string;
  /** What the engine will be asked to say. */
  spokenText: string;
  /** Differences between `text` and `spokenText`; `sourceStart` indexes the whole script. */
  diff: TextDiffPart[];
  pauseKind: ChunkPauseKind;
  /** Pause after the chunk, with slider overrides and break tags applied. */
  pauseAfterSec: number;
  /** The pause comes from a break tag. */
  isBreak: boolean;
  estimatedSpeechSec: number;
}

export interface ScriptPreflight {
  chunks: PreflightChunk[];
  /** Pause requested by break tags before the first chunk. */
  leadingPauseSec: number;
  /** Spoken text of every chunk, separated by blank lines. */
  spokenText: string;
  totals: {
    chunkCount: number;
    /** Chunks whose spoken text differs from the written text. */
    changedChunkCount: number;
    spokenCharacters: number;
    speechSec: number;
    pauseSec: number;
    durationSec: number;
  };
}

function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function spokenLength(text: string): number {
  return text.replace(/\s+/g, " ").trim().length;
}

function roundSeconds(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

export function buildScriptPreflight(text: string, options: ScriptPreflightOptions): ScriptPreflight {
  const charactersPerSecond = positiveOr(options.charactersPerSecond, DEFAULT_CHARACTERS_PER_SECOND)
    * positiveOr(options.speed, 1);
  const { chunks, leadingPauseSec } = chunkWithSpeechBreaks(text, options.chunk);

  const preflightChunks = chunks.map((chunk, index): PreflightChunk => {
    const rewrite = buildSpeechTextRewrite(chunk.text, {
      pronunciationRules: options.pronunciationRules,
      normalization: options.normalization,
    });
    const isBreak = chunk.breakPauseSec !== undefined;
    return {
      index,
      start: chunk.start,
      end: chunk.end,
      text: chunk.text,
      spokenText: rewrite.text,
      diff: buildTextDiff(rewrite).map((part) => ({ ...part, sourceStart: part.sourceStart + chunk.start })),
      pauseKind: chunk.pauseKind,
      pauseAfterSec: resolveChunkPauseSeconds(chunk, options.pauseOverridesSec),
      isBreak,
      estimatedSpeechSec: roundSeconds(spokenLength(rewrite.text) / charactersPerSecond),
    };
  });

  const spokenCharacters = preflightChunks.reduce((sum, chunk) => sum + spokenLength(chunk.spokenText), 0);
  const speechSec = roundSeconds(spokenCharacters / charactersPerSecond);
  const pauseSec = roundSeconds(leadingPauseSec + preflightChunks.reduce((sum, chunk) => sum + chunk.pauseAfterSec, 0));
  return {
    chunks: preflightChunks,
    leadingPauseSec,
    spokenText: preflightChunks.map((chunk) => chunk.spokenText).join("\n\n"),
    totals: {
      chunkCount: preflightChunks.length,
      changedChunkCount: preflightChunks.filter((chunk) => chunk.spokenText !== chunk.text).length,
      spokenCharacters,
      speechSec,
      pauseSec,
      durationSec: roundSeconds(speechSec + pauseSec),
    },
  };
}
