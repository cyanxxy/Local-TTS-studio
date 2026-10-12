import { MAX_BREAK_SEC } from "../text/speechMarkup";

/** Pause lengths the insert menu offers, in seconds. */
export const BREAK_PRESETS_SEC: readonly number[] = Object.freeze([0.3, 0.5, 1, 2]);
export const MIN_BREAK_SEC = 0.1;

function clampBreak(seconds: number): number {
  const value = Number.isFinite(seconds) ? seconds : MIN_BREAK_SEC;
  return Math.round(Math.min(MAX_BREAK_SEC, Math.max(MIN_BREAK_SEC, value)) * 100) / 100;
}

/** `<break time="1.5s"/>` for a pause of `seconds`, in milliseconds below one second. */
export function formatBreakTag(seconds: number): string {
  const clamped = clampBreak(seconds);
  return clamped < 1
    ? `<break time="${Math.round(clamped * 1000)}ms"/>`
    : `<break time="${clamped}s"/>`;
}

export interface BreakInsertion {
  text: string;
  /** Caret position after the inserted tag. */
  caret: number;
}

/**
 * Puts a break tag at the selection, replacing any selected text, with a
 * space on each side unless a space or line break is already there.
 */
export function insertBreakTag(text: string, selectionStart: number, selectionEnd: number, seconds: number): BreakInsertion {
  const start = Math.max(0, Math.min(text.length, Math.min(selectionStart, selectionEnd)));
  const end = Math.max(start, Math.min(text.length, Math.max(selectionStart, selectionEnd)));
  const before = text.slice(0, start);
  const after = text.slice(end);
  const lead = before === "" || /\s$/u.test(before) ? "" : " ";
  const trail = after === "" || /^\s/u.test(after) ? "" : " ";
  const tag = `${lead}${formatBreakTag(seconds)}${trail}`;
  return { text: `${before}${tag}${after}`, caret: before.length + tag.length - trail.length };
}
