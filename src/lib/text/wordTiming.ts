/**
 * The one word-timing estimator shared by Reader highlighting and caption
 * export. No engine reports word alignment, so word times are interpolated
 * inside each chunk's exact sample-accurate span.
 */

export interface EstimatedWordRange {
  word: string;
  /** Source offsets of the word (`textStart` plus its index in the chunk). */
  start: number;
  end: number;
  startSec: number;
  endSec: number;
}

/** Extra letter-equivalents of time for the pause that follows a word. */
function trailingPauseWeight(word: string): number {
  if (/[.!?…。？！]["'”’)\]]*$/u.test(word)) return 6;
  if (/[,;:—–，；：]["'”’)\]]*$/u.test(word)) return 3;
  return 0;
}

export function estimateWordRanges(
  text: string,
  textStart: number,
  startSec: number,
  endSec: number,
): EstimatedWordRange[] {
  const matches = [...text.matchAll(/\S+/g)];
  if (matches.length === 0 || endSec <= startSec) return [];

  // Speech time tracks letters, plus the pause a voice takes after a comma or
  // a full stop. Without the pause weight the marker ran ahead of the voice
  // after every sentence break inside a multi-sentence passage.
  const weights = matches.map((match) => (
    Math.max(1, match[0].replace(/[^\p{L}\p{N}]/gu, "").length) + trailingPauseWeight(match[0])
  ));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const duration = endSec - startSec;
  let cursorSec = startSec;

  return matches.map((match, index) => {
    const word = match[0];
    const relativeStart = match.index;
    const isLast = index === matches.length - 1;
    const range = {
      word,
      start: textStart + relativeStart,
      end: textStart + relativeStart + word.length,
      startSec: cursorSec,
      endSec: isLast ? endSec : cursorSec + duration * (weights[index] / totalWeight),
    };
    cursorSec = range.endSec;
    return range;
  });
}
