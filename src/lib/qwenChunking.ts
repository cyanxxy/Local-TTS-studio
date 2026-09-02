import type { TextChunk } from "./chunking";
import {
  MAX_LOCAL_TTS_TEXT_LENGTH,
  countUnicodeScalars,
} from "../../electron/localTtsLimits";

// Keep these in sync with CUSTOM_VOICE_UNIT_CHARS and CJK_CHAR_WEIGHT in
// rust/local-tts-bridge/src/qwen3/runtime.rs and .../qwen3/text.rs. Rust
// reports textUnitIndex against the units it splits; the renderer maps those
// onto the units built here, so both splitters must agree exactly.
export const QWEN3_UNIT_MAX_CHARS = 200;
export const QWEN3_CJK_CHAR_WEIGHT = 2;

export interface Qwen3RequestSection extends TextChunk {
  /** Inclusive index of the first Qwen text unit in this request. */
  unitStart: number;
  /** Exclusive index of the final Qwen text unit in this request. */
  unitEnd: number;
}

const SENTENCE_BOUNDARIES = new Set([".", "!", "?", "。", "！", "？", "；", ";", "\n"]);
const CLAUSE_BOUNDARIES = new Set([",", ":", "，", "：", "、"]);

/** Mirrors Rust's `is_cjk`. */
export function isQwen3CjkCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return false;
  return (codePoint >= 0x2e80 && codePoint <= 0x2fff)
    || (codePoint >= 0x3040 && codePoint <= 0x30ff)
    || (codePoint >= 0x3100 && codePoint <= 0x312f)
    || (codePoint >= 0x31a0 && codePoint <= 0x31bf)
    || (codePoint >= 0x31f0 && codePoint <= 0x31ff)
    || (codePoint >= 0x3400 && codePoint <= 0x4dbf)
    || (codePoint >= 0x4e00 && codePoint <= 0x9fff)
    || (codePoint >= 0xac00 && codePoint <= 0xd7af)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0x20000 && codePoint <= 0x2fa1f);
}

function isAsciiDigit(character: string | undefined): boolean {
  return character !== undefined && character >= "0" && character <= "9" && character.length === 1;
}

/** Mirrors Rust's `is_boundary`: punctuation inside a number is not a pause. */
function isBoundary(character: string, previous: string | undefined, next: string | undefined): boolean {
  if (!SENTENCE_BOUNDARIES.has(character) && !CLAUSE_BOUNDARIES.has(character)) return false;
  return !(isAsciiDigit(previous) && isAsciiDigit(next));
}

/** Mirrors Rust's split_text_units while retaining UTF-16 source offsets. */
export function buildQwen3TextUnits(text: string): TextChunk[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const sourceStart = text.indexOf(trimmed);
  const units: TextChunk[] = [];
  let start = 0;

  while (start < trimmed.length) {
    let weight = 0;
    let preferredEnd: number | null = null;
    let hardEnd = trimmed.length;
    let previous: string | undefined;

    const characters = Array.from(trimmed.slice(start));
    let relativeUtf16Offset = 0;
    for (let index = 0; index < characters.length; index += 1) {
      const character = characters[index];
      relativeUtf16Offset += character.length;
      const end = start + relativeUtf16Offset;
      weight += isQwen3CjkCharacter(character) ? QWEN3_CJK_CHAR_WEIGHT : 1;
      if (isBoundary(character, previous, characters[index + 1])) {
        preferredEnd = end;
      }
      if (weight >= QWEN3_UNIT_MAX_CHARS) {
        hardEnd = end;
        break;
      }
      previous = character;
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
