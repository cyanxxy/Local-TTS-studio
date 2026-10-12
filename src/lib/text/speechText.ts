/**
 * The text an engine speaks for a piece of source text, as one rewrite with
 * an offset map back to the source.
 *
 * Every transform runs against the source and the edits are merged by
 * precedence, so no transform sees another's output: pause tags are dropped
 * first, then emphasis markers, then pronunciation rules, then (opt-in)
 * normalization. A lower-precedence edit that overlaps a higher one is
 * skipped, so "GIF=jif" wins over anything the normalizer would do there.
 *
 * Without normalization the text equals `tuneChunkText` for the same rules.
 */
import {
  EMPHASIS_MARKUP,
  compilePronunciationMatcher,
  type PronunciationMatcher,
  type PronunciationMatchRule,
} from "../textTuning";
import { normalizeForSpeech, type SpeechNormalizationOptions } from "./normalize";
import { findSpeechBreaks } from "./speechMarkup";
import { applyTextEdits, type TextEdit, type TextRewrite } from "./textEdits";

export interface SpeechTextOptions {
  pronunciationRules?: readonly PronunciationMatchRule[];
  /** Normalization options, or omitted/false to leave numbers and symbols as written. */
  normalization?: SpeechNormalizationOptions | false;
}

// Settings keep one rules array until the dictionary changes, so a script
// edited keystroke by keystroke compiles its dictionary once.
const matchers = new WeakMap<readonly PronunciationMatchRule[], PronunciationMatcher>();

function matcherFor(rules: readonly PronunciationMatchRule[]): PronunciationMatcher {
  let matcher = matchers.get(rules);
  if (!matcher) {
    matcher = compilePronunciationMatcher(rules);
    matchers.set(rules, matcher);
  }
  return matcher;
}

const INLINE_SPACE = /[ \t]/;

/**
 * Same spacing as `stripSpeechBreakMarkup`: tags separated only by spaces go
 * as one run, which leaves one space between words and none at a line edge.
 */
function breakTagEdits(text: string): TextEdit[] {
  const runs: [number, number][] = [];
  for (const tag of findSpeechBreaks(text)) {
    let start = tag.start;
    let end = tag.end;
    while (INLINE_SPACE.test(text[start - 1] ?? "")) start -= 1;
    while (INLINE_SPACE.test(text[end] ?? "")) end += 1;
    const previous = runs.at(-1);
    if (previous && start <= previous[1]) {
      previous[1] = end;
    } else {
      runs.push([start, end]);
    }
  }
  return runs.map(([start, end]) => {
    const before = text[start - 1];
    const after = text[end];
    const atEdge = before === undefined || after === undefined || /\s/u.test(before) || /\s/u.test(after);
    return { start, end, replacement: atEdge ? "" : " ", reason: "break" };
  });
}

/** Opening and closing marker deletions of each `[[word]]`, `**word**` or `*word*`. */
function emphasisEdits(text: string): TextEdit[][] {
  return [...text.matchAll(EMPHASIS_MARKUP)].map((match) => {
    const start = match.index;
    const end = start + match[0].length;
    const markerLength = match[3] === undefined ? 2 : 1;
    return [
      { start, end: start + markerLength, replacement: "", reason: "emphasis" },
      { start: end - markerLength, end, replacement: "", reason: "emphasis" },
    ];
  });
}

/** Builds the spoken form of `text` with an offset map back to it. */
export function buildSpeechTextRewrite(text: string, options: SpeechTextOptions = {}): TextRewrite {
  const claimed = new Uint8Array(text.length);
  const accepted: TextEdit[] = [];
  const isFree = (start: number, end: number) => {
    for (let index = start; index < end; index += 1) {
      if (claimed[index]) return false;
    }
    return true;
  };
  // Each group is all-or-nothing, so an emphasis marker is never removed without its partner.
  const accept = (groups: readonly (readonly TextEdit[])[]) => {
    for (const group of groups) {
      if (!group.every((edit) => isFree(edit.start, edit.end))) continue;
      for (const edit of group) {
        claimed.fill(1, edit.start, edit.end);
        accepted.push(edit);
      }
    }
  };
  const single = (edits: readonly TextEdit[]) => edits.map((edit) => [edit]);

  accept(single(breakTagEdits(text)));
  accept(emphasisEdits(text));
  if (options.pronunciationRules && options.pronunciationRules.length > 0) {
    accept(single(matcherFor(options.pronunciationRules).rewrite(text).edits));
  }
  if (options.normalization) {
    accept(single(normalizeForSpeech(text, options.normalization).edits));
  }
  return applyTextEdits(text, accepted.map(({ start, end, replacement, reason }) => ({ start, end, replacement, reason })));
}
