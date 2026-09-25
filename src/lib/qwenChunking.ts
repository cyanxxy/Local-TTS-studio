import type { TextChunk } from "./chunking";
import {
  MAX_LOCAL_TTS_TEXT_LENGTH,
  countUnicodeScalars,
} from "../../electron/localTtsLimits";

// Keep this in sync with CUSTOM_VOICE_UNIT_CHARS in
// rust/local-tts-bridge/src/qwen3/runtime.rs.
export const QWEN3_UNIT_MAX_CHARS = 200;
// Keep this in sync with CJK_CHARACTER_WEIGHT in
// rust/local-tts-bridge/src/qwen3/text.rs. CJK text speaks about twice as long
// per character, so CJK-heavy units are cut at about half the characters.
export const QWEN3_CJK_CHARACTER_WEIGHT = 2;

export interface Qwen3RequestSection extends TextChunk {
  /** Inclusive index of the first Qwen text unit in this request. */
  unitStart: number;
  /** Exclusive index of the final Qwen text unit in this request. */
  unitEnd: number;
}

export interface Qwen3RequestPlan {
  sections: Qwen3RequestSection[];
  /** Every request's units, in the order and ranges the bridge reports them. */
  units: TextChunk[];
}

const SENTENCE_BOUNDARIES = new Set([".", "!", "?", "。", "！", "？", "；", ";", "\n"]);
const CLAUSE_BOUNDARIES = new Set([",", ":", "，", "：", "、"]);

/** Mirrors `is_cjk` in rust/local-tts-bridge/src/qwen3/config.rs. */
function isCjk(codePoint: number): boolean {
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

/** Rust's `char::is_whitespace` (Unicode White_Space), which `str::trim` uses. */
function isRustWhitespace(codeUnit: number): boolean {
  return (codeUnit >= 0x09 && codeUnit <= 0x0d)
    || codeUnit === 0x20
    || codeUnit === 0x85
    || codeUnit === 0xa0
    || codeUnit === 0x1680
    || (codeUnit >= 0x2000 && codeUnit <= 0x200a)
    || codeUnit === 0x2028
    || codeUnit === 0x2029
    || codeUnit === 0x202f
    || codeUnit === 0x205f
    || codeUnit === 0x3000;
}

/**
 * The UTF-16 range of `text` the bridge actually splits. Electron's IPC
 * validation applies JavaScript `trim()`, then Rust trims again with its own
 * whitespace set (which adds U+0085 and drops U+FEFF), so both are replayed.
 */
function bridgeTrimmedRange(text: string): { start: number; end: number } {
  const jsTrimmed = text.trim();
  let start = jsTrimmed ? text.indexOf(jsTrimmed) : 0;
  let end = start + jsTrimmed.length;
  // Every Rust whitespace character is in the BMP, so code-unit checks are exact.
  while (start < end && isRustWhitespace(text.charCodeAt(start))) start += 1;
  while (end > start && isRustWhitespace(text.charCodeAt(end - 1))) end -= 1;
  return { start, end };
}

/** Mirrors Rust's split_text_units over `text[rangeStart, rangeEnd)`. */
function splitTextUnits(text: string, rangeStart: number, rangeEnd: number): TextChunk[] {
  const units: TextChunk[] = [];
  let start = rangeStart;

  while (start < rangeEnd) {
    let weight = 0;
    let preferredEnd: number | null = null;
    let hardEnd = rangeEnd;

    let end = start;
    while (end < rangeEnd) {
      const codePoint = text.codePointAt(end)!;
      const character = String.fromCodePoint(codePoint);
      end += character.length;
      weight += isCjk(codePoint) ? QWEN3_CJK_CHARACTER_WEIGHT : 1;
      if (SENTENCE_BOUNDARIES.has(character) || CLAUSE_BOUNDARIES.has(character)) {
        preferredEnd = end;
      }
      if (weight >= QWEN3_UNIT_MAX_CHARS) {
        hardEnd = end;
        break;
      }
    }

    const unitEnd = preferredEnd ?? hardEnd;
    units.push({
      text: text.slice(start, unitEnd),
      start,
      end: unitEnd,
      pauseAfterSec: 0.2,
      pauseKind: "sentence",
    });
    start = unitEnd;
  }

  if (units.length > 0) units[units.length - 1].pauseAfterSec = 0;
  return units;
}

/**
 * Mirrors the bridge's trim-then-split_text_units for one request while
 * retaining UTF-16 source offsets.
 */
export function buildQwen3TextUnits(text: string): TextChunk[] {
  const { start, end } = bridgeTrimmedRange(text);
  return splitTextUnits(text, start, end);
}

/**
 * Groups Qwen's small inference units into IPC-safe requests. Reader documents
 * can be much longer than a single local-runtime request, so this preserves the
 * natural sentence/clause boundaries and exact source offsets while ensuring
 * every payload stays within the shared Electron/Rust character limit.
 *
 * The bridge trims and re-splits each request's own text, and trimming can
 * move a window's boundaries relative to a whole-document split. The returned
 * units therefore come from splitting each request exactly as the bridge
 * will, so a streamed `textUnitIndex` indexes `units` from `unitStart`.
 */
export function buildQwen3RequestPlan(text: string): Qwen3RequestPlan {
  const groupingUnits = buildQwen3TextUnits(text);
  if (groupingUnits.length === 0) return { sections: [], units: [] };

  const ranges: Array<{ start: number; end: number }> = [];
  let sectionStart = groupingUnits[0].start;
  let sectionCharacterCount = countUnicodeScalars(groupingUnits[0].text);
  for (let index = 1; index < groupingUnits.length; index += 1) {
    const unitCharacterCount = countUnicodeScalars(groupingUnits[index].text);
    if (sectionCharacterCount + unitCharacterCount <= MAX_LOCAL_TTS_TEXT_LENGTH) {
      sectionCharacterCount += unitCharacterCount;
      continue;
    }
    ranges.push({ start: sectionStart, end: groupingUnits[index - 1].end });
    sectionStart = groupingUnits[index].start;
    sectionCharacterCount = unitCharacterCount;
  }
  ranges.push({ start: sectionStart, end: groupingUnits[groupingUnits.length - 1].end });

  const sections: Qwen3RequestSection[] = [];
  const units: TextChunk[] = [];
  ranges.forEach((range, index) => {
    const final = index === ranges.length - 1;
    const sectionText = text.slice(range.start, range.end);
    const unitStart = units.length;
    for (const unit of buildQwen3TextUnits(sectionText)) {
      units.push({ ...unit, start: unit.start + range.start, end: unit.end + range.start });
    }
    if (!final && units.length > unitStart) {
      units[units.length - 1].pauseAfterSec = 0.2;
    }
    sections.push({
      text: sectionText,
      start: range.start,
      end: range.end,
      pauseAfterSec: final ? 0 : 0.2,
      pauseKind: final ? "none" : "sentence",
      unitStart,
      unitEnd: units.length,
    });
  });

  return { sections, units };
}

export function buildQwen3RequestSections(text: string): Qwen3RequestSection[] {
  return buildQwen3RequestPlan(text).sections;
}
