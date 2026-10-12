/**
 * Pause marks for engines that synthesize several passages in one request.
 *
 * Most engines treat a blank line as a hard passage boundary, which is how the
 * speech pipeline forces a pause position. Qwen3 merges short paragraphs into
 * one text unit, so a blank line cannot guarantee a boundary there. Its
 * request plan instead splits at one private-use character per pause, which
 * carries the pause length in hundredths of a second and is never sent to the
 * bridge.
 */

const MARK_BASE = 0xe000;
/** Longest pause a mark can carry: ten seconds, the same ceiling as break tags. */
const MARK_MAX_CENTISECONDS = 1000;

const MARK_PATTERN = /[-]/g;

export interface SpeechBreakMark {
  /** UTF-16 offset of the mark in the text. */
  index: number;
  seconds: number;
}

/** The one-character mark for a pause of `seconds`, rounded to 10 ms and capped at 10 s. */
export function encodeSpeechBreakMark(seconds: number): string {
  const centiseconds = Math.min(MARK_MAX_CENTISECONDS, Math.max(0, Math.round(seconds * 100)));
  return String.fromCharCode(MARK_BASE + centiseconds);
}

/** Every pause mark in `text`, in order. */
export function findSpeechBreakMarks(text: string): SpeechBreakMark[] {
  return Array.from(text.matchAll(MARK_PATTERN), (match) => ({
    index: match.index,
    seconds: (match[0].charCodeAt(0) - MARK_BASE) / 100,
  }));
}

/** `text` without any pause mark. */
export function stripSpeechBreakMarks(text: string): string {
  return text.replace(MARK_PATTERN, "");
}
