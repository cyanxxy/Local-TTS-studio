import type { AudioSegment } from "../../hooks/useAudioPlayer";
import { estimateSegmentWords, findSegmentForTextOffset } from "./readerSegments";
import type { TextBlock } from "./readerTextLayout";

/**
 * Sentence and paragraph boundaries of a reading section, and the mapping
 * between section-local text offsets and estimated playback times that lets
 * the Reader seek to a word instead of to the start of the passage holding it.
 */

export type ReaderStepUnit = "sentence" | "paragraph";
export type ReaderStepDirection = "previous" | "next";

const FALLBACK_SENTENCE_END = /[.!?…。！？]+["'”’)\]]*\s+/gu;
/**
 * A title, a common abbreviation or an initial right before a break. The
 * platform segmenter splits "Dr. Smith" and "J. R. R. Tolkien" apart.
 */
const ABBREVIATION_BEFORE_BREAK = /(?:^|[\s("“‘])(?:mr|mrs|ms|mx|dr|prof|sr|jr|st|mt|rev|gen|col|capt|lt|sgt|vs|e\.g|i\.e|cf|vol|fig|ch|pp?)\.\s*$/iu;
/** "No. 5" abbreviates only before a number; "He said no." ends a sentence. */
const NUMBER_ABBREVIATION_BEFORE_BREAK = /(?:^|[\s("“‘])nos?\.\s*$/iu;
const NUMBER_AFTER_BREAK = /^\s*[\d#]/u;
const INITIAL_BEFORE_BREAK = /(?:^|[\s("“‘])(\p{Lu})\.\s*$/u;
/** "I." is usually the pronoun ending a sentence, unless it sits among initials. */
const INITIAL_BEFORE_PRONOUN = /\p{Lu}\.\s+I\.\s*$/u;
const INITIAL_AFTER_BREAK = /^\s*\p{Lu}\./u;
const ABBREVIATION_WINDOW = 16;

/** Tests only the text around the break, so long paragraphs stay linear. */
function endsWithAbbreviation(paragraph: string, index: number): boolean {
  const from = Math.max(0, index - ABBREVIATION_WINDOW);
  // A cut-off word must not pass for the start of the paragraph.
  const tail = `${from > 0 ? "x" : ""}${paragraph.slice(from, index)}`;
  const head = paragraph.slice(index, index + ABBREVIATION_WINDOW);
  if (ABBREVIATION_BEFORE_BREAK.test(tail)) return true;
  if (NUMBER_ABBREVIATION_BEFORE_BREAK.test(tail)) return NUMBER_AFTER_BREAK.test(head);
  const initial = tail.match(INITIAL_BEFORE_BREAK)?.[1];
  if (initial === undefined) return false;
  return initial !== "I" || INITIAL_BEFORE_PRONOUN.test(tail) || INITIAL_AFTER_BREAK.test(head);
}

function sentenceSegmenter(language: string | undefined): Intl.Segmenter | null {
  if (typeof Intl.Segmenter !== "function") return null;
  try {
    return new Intl.Segmenter(language || undefined, { granularity: "sentence" });
  } catch {
    // A stored language tag the runtime does not accept.
    return new Intl.Segmenter(undefined, { granularity: "sentence" });
  }
}

/** Offsets of the first non-space character at or after each `offsets` entry. */
function firstVisible(text: string, offsets: Iterable<number>, end: number): number[] {
  const starts = new Set<number>();
  for (const offset of offsets) {
    let index = offset;
    while (index < end && /\s/u.test(text[index])) index += 1;
    if (index < end) starts.add(index);
  }
  return [...starts].sort((a, b) => a - b);
}

/** Where each paragraph's first word starts, skipping any indent. */
export function paragraphStarts(text: string, blocks: readonly TextBlock[]): number[] {
  return blocks.flatMap((block) => firstVisible(text, [block.start], block.end));
}

/**
 * Where each sentence of the section starts, in section-local offsets. Every
 * paragraph starts a sentence too, so headings and list items without a full
 * stop are steps of their own. Uses the platform's sentence segmenter for the
 * document's language (which knows CJK punctuation and decimals), or a
 * punctuation split where there is none, and keeps a title, abbreviation or
 * initial with the words after it.
 */
export function sentenceStarts(text: string, blocks: readonly TextBlock[], language?: string): number[] {
  const offsets: number[] = paragraphStarts(text, blocks);
  const segmenter = sentenceSegmenter(language);
  for (const block of blocks) {
    const paragraph = text.slice(block.start, block.end);
    const breaks = segmenter
      ? Array.from(segmenter.segment(paragraph), (sentence) => sentence.index)
      : Array.from(paragraph.matchAll(FALLBACK_SENTENCE_END), (match) => (match.index ?? 0) + match[0].length);
    for (const index of breaks) {
      if (index > 0 && !endsWithAbbreviation(paragraph, index)) offsets.push(block.start + index);
    }
  }
  return firstVisible(text, offsets, text.length);
}

/**
 * The boundary a step lands on. Stepping back from inside a sentence returns
 * to its start, the way a player's back button restarts the track; only from
 * the sentence's first word does it go to the sentence before. Null when the
 * step leaves the section.
 */
export function stepBoundary(
  boundaries: readonly number[],
  currentOffset: number,
  direction: ReaderStepDirection,
): number | null {
  if (direction === "next") return boundaries.find((boundary) => boundary > currentOffset) ?? null;
  let index = -1;
  for (let i = 0; i < boundaries.length && boundaries[i] <= currentOffset; i += 1) index = i;
  if (index === -1) return null;
  if (boundaries[index] < currentOffset) return boundaries[index];
  return index > 0 ? boundaries[index - 1] : null;
}

function hasTextRange(segment: AudioSegment): segment is AudioSegment & { textStart: number; textEnd: number } {
  return typeof segment.textStart === "number" && typeof segment.textEnd === "number";
}

/**
 * Section-local offset of the word being spoken at `timeSec`: the estimated
 * word, or the start of the passage when it is the still-growing
 * `unsettledSegmentId` (its word timing is not final). In the pause after a
 * passage it is the passage's last word. Null without timed audio.
 */
export function offsetAtTime(
  segments: readonly AudioSegment[],
  timeSec: number,
  unsettledSegmentId: string | null,
): number | null {
  const segment = segments.find((entry) => hasTextRange(entry) && timeSec >= entry.startSec && timeSec < entry.endSec)
    ?? [...segments].reverse().find((entry) => hasTextRange(entry) && entry.startSec <= timeSec);
  if (!segment || !hasTextRange(segment)) return null;
  if (segment.id === unsettledSegmentId) return segment.textStart;
  const words = estimateSegmentWords(segment);
  if (words.length === 0) return segment.textStart;
  const word = words.find((entry) => timeSec < entry.endSec) ?? words[words.length - 1];
  return word.start;
}

/**
 * When the word at a section-local offset starts playing. That is the
 * estimated word's start (the word holding the offset, or the next one when
 * the offset falls on a space), or the start of the passage holding the offset
 * when it is the still-growing `unsettledSegmentId`. Null when no generated
 * passage covers it.
 */
export function timeAtOffset(
  segments: readonly AudioSegment[],
  localOffset: number,
  unsettledSegmentId: string | null,
): number | null {
  const segment = findSegmentForTextOffset(segments, localOffset);
  if (!segment) return null;
  if (segment.id === unsettledSegmentId || !hasTextRange(segment)) return segment.startSec;
  const word = estimateSegmentWords(segment).find((entry) => localOffset < entry.end);
  return word ? word.startSec : segment.startSec;
}
