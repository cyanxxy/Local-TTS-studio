import type { TextChunk } from "./chunking";
import {
  MAX_LOCAL_TTS_TEXT_LENGTH,
  countUnicodeScalars,
} from "../../electron/localTtsLimits";

// Keep this in sync with CUSTOM_VOICE_UNIT_CHARS in
// rust/local-tts-bridge/src/qwen3/runtime.rs.
export const QWEN3_UNIT_MAX_CHARS = 400;

export interface Qwen3RequestSection extends TextChunk {
  /** Inclusive index of the first Qwen text unit in this request. */
  unitStart: number;
  /** Exclusive index of the final Qwen text unit in this request. */
  unitEnd: number;
}

const SENTENCE_BOUNDARIES = new Set([".", "!", "?", "。", "！", "？", "；", ";", "\n"]);
const CLAUSE_BOUNDARIES = new Set([",", ":", "，", "：", "、"]);

/** Mirrors Rust's split_text_units while retaining UTF-16 source offsets. */
export function buildQwen3TextUnits(text: string): TextChunk[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const sourceStart = text.indexOf(trimmed);
  const units: TextChunk[] = [];
  let start = 0;

  while (start < trimmed.length) {
    let charCount = 0;
    let preferredEnd: number | null = null;
    let hardEnd = trimmed.length;

    let relativeUtf16Offset = 0;
    for (const character of trimmed.slice(start)) {
      relativeUtf16Offset += character.length;
      const end = start + relativeUtf16Offset;
      charCount += 1;
      if (SENTENCE_BOUNDARIES.has(character) || CLAUSE_BOUNDARIES.has(character)) {
        preferredEnd = end;
      }
      if (charCount === QWEN3_UNIT_MAX_CHARS) {
        hardEnd = end;
        break;
      }
    }

    const end = preferredEnd ?? hardEnd;
    const unitStart = sourceStart + start;
    const unitEnd = sourceStart + end;
    units.push({
      text: text.slice(unitStart, unitEnd),
      start: unitStart,
      end: unitEnd,
      pauseAfterSec: 0.2,
      pauseKind: "sentence",
    });
    start = end;
  }

  units[units.length - 1].pauseAfterSec = 0;
  return units;
}

/**
 * Groups Qwen's small inference units into IPC-safe requests. Reader documents
 * can be much longer than a single local-runtime request, so this preserves the
 * natural sentence/clause boundaries and exact source offsets while ensuring
 * every payload stays within the shared Electron/Rust character limit.
 */
export function buildQwen3RequestSections(text: string): Qwen3RequestSection[] {
  const units = buildQwen3TextUnits(text);
  if (units.length === 0) return [];

  const sections: Qwen3RequestSection[] = [];
  let unitStart = 0;
  let sectionStart = units[0].start;
  let sectionCharacterCount = countUnicodeScalars(units[0].text);

  const pushSection = (unitEnd: number) => {
    const end = units[unitEnd - 1].end;
    sections.push({
      text: text.slice(sectionStart, end),
      start: sectionStart,
      end,
      pauseAfterSec: unitEnd < units.length ? 0.2 : 0,
      pauseKind: unitEnd < units.length ? "sentence" : "none",
      unitStart,
      unitEnd,
    });
  };

  for (let index = 1; index < units.length; index += 1) {
    const unitCharacterCount = countUnicodeScalars(units[index].text);
    if (sectionCharacterCount + unitCharacterCount <= MAX_LOCAL_TTS_TEXT_LENGTH) {
      sectionCharacterCount += unitCharacterCount;
      continue;
    }
    pushSection(index);
    unitStart = index;
    sectionStart = units[index].start;
    sectionCharacterCount = unitCharacterCount;
  }
  pushSection(units.length);

  return sections;
}
