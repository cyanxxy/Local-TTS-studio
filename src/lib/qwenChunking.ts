import type { TextChunk } from "./chunking";

// Keep this in sync with CUSTOM_VOICE_UNIT_CHARS in
// rust/local-tts-bridge/src/qwen3/runtime.rs.
export const QWEN3_UNIT_MAX_CHARS = 400;

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
