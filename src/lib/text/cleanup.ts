/**
 * One-click text cleanup for narration: citations, footnote markers, URLs,
 * emoji, Markdown syntax, PDF artifacts, HTML entities, repeated punctuation
 * and stray whitespace.
 *
 * Every action describes its work as edits against the original text, so the
 * result carries an offset map (see `applyTextEdits`) and a preview diff can
 * show exactly what changes. Actions never overlap: a span one action edits
 * (or protects, like the inside of a code span) is skipped by later actions.
 * With the default actions, or any single action, running cleanup on its own
 * output changes nothing.
 *
 * `pdfArtifacts` is opt-in: besides ligatures, soft hyphens and page-number
 * lines it re-flows hard-wrapped lines, which suits PDF and OCR text but
 * would join intentional line breaks elsewhere.
 */
import { applyTextEdits, type TextEdit, type TextRewrite } from "./textEdits";

export type TextCleanupAction =
  | "markdown"
  | "citations"
  | "footnotes"
  | "urls"
  | "emoji"
  | "pdfArtifacts"
  | "htmlEntities"
  | "repeatedPunctuation"
  | "whitespace";

/** Every action, in the order they run. */
export const ALL_TEXT_CLEANUP_ACTIONS: readonly TextCleanupAction[] = Object.freeze([
  "markdown",
  "citations",
  "footnotes",
  "urls",
  "emoji",
  "pdfArtifacts",
  "htmlEntities",
  "repeatedPunctuation",
  "whitespace",
]);

/** Actions a one-click cleanup runs: everything except the line re-flowing `pdfArtifacts`. */
export const DEFAULT_TEXT_CLEANUP_ACTIONS: readonly TextCleanupAction[] = Object.freeze(
  ALL_TEXT_CLEANUP_ACTIONS.filter((action) => action !== "pdfArtifacts"),
);

export interface TextCleanupOptions {
  /** Actions to run; defaults to `DEFAULT_TEXT_CLEANUP_ACTIONS`. */
  actions?: readonly TextCleanupAction[];
  /** "domain" (default) keeps a URL's host ("example.com"); "remove" drops the URL. */
  urlMode?: "domain" | "remove";
}

export interface TextCleanupResult extends TextRewrite {
  /** Number of edits each action made. */
  counts: Record<TextCleanupAction, number>;
}

interface Cleanup {
  readonly text: string;
  readonly claimed: Uint8Array;
  readonly edits: TextEdit[];
}

function isFree(cleanup: Cleanup, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    if (cleanup.claimed[index]) return false;
  }
  return true;
}

/**
 * Adds the edits when none of their spans is taken, and claims those spans
 * (plus `protect`ed ranges, which later actions must leave alone).
 */
function claim(cleanup: Cleanup, edits: readonly TextEdit[], protect: readonly [number, number][] = []): void {
  const spans: [number, number][] = [...edits.map((edit): [number, number] => [edit.start, edit.end]), ...protect];
  if (!spans.every(([start, end]) => isFree(cleanup, start, end))) return;
  for (const [start, end] of spans) cleanup.claimed.fill(1, start, end);
  cleanup.edits.push(...edits);
}

const INLINE_SPACE = /[ \t]/;
const CLOSING_PUNCTUATION = /[\s.,;:!?)\]}"'”’»]/;

/**
 * Edit that deletes an inline token without leaving a doubled or dangling
 * space: "a [1] b" -> "a b", "word [1]." -> "word.", "🎉 Party" -> "Party".
 */
function removal(text: string, start: number, end: number, reason: TextCleanupAction): TextEdit {
  let from = start;
  let to = end;
  const next = text[end];
  if (INLINE_SPACE.test(text[start - 1] ?? "") && (next === undefined || CLOSING_PUNCTUATION.test(next))) {
    while (INLINE_SPACE.test(text[from - 1] ?? "")) from -= 1;
  } else if (start === 0 || text[start - 1] === "\n") {
    while (INLINE_SPACE.test(text[to] ?? "")) to += 1;
  }
  return { start: from, end: to, replacement: "", reason };
}

function deletion(start: number, end: number, reason: TextCleanupAction): TextEdit {
  return { start, end, replacement: "", reason };
}

/**
 * Deletes a whole line (including its line break); between two blank lines
 * it also drops one of them, so no extra gap is left behind.
 */
function lineDeletion(text: string, start: number, end: number, reason: TextCleanupAction): TextEdit {
  const betweenBlankLines = text[end] === "\n" && text.endsWith("\n\n", start);
  return deletion(start, betweenBlankLines ? end + 1 : end, reason);
}

function removeLines(cleanup: Cleanup, pattern: RegExp, reason: TextCleanupAction, keepFirstLine = false): void {
  for (const match of cleanup.text.matchAll(pattern)) {
    if (keepFirstLine && match.index === 0) continue;
    claim(cleanup, [lineDeletion(cleanup.text, match.index, match.index + match[0].length, reason)]);
  }
}

// ---------------------------------------------------------------------------
// Markdown

const CODE_FENCE_LINE = /^[ \t]*(?:```|~~~)[^\n]*(?:\n|$)/gm;
const HEADING_MARKER = /^[ \t]{0,3}(#{1,6})[ \t]+/gm;
const HEADING_CLOSING = /[ \t]+#+[ \t]*$/gm;
const BLOCKQUOTE_MARKER = /^[ \t]{0,3}(?:>[ \t]?)+/gm;
const BULLET_MARKER = /^[ \t]*[-*+][ \t]+(?=\S)/gm;
const HORIZONTAL_RULE = /^[ \t]*(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})(?:\n|$)/gm;
const CODE_SPAN = /(?<!`)(`+)(?!`)([^\n]+?)(?<!`)\1(?!`)/dg;
const IMAGE = /!\[([^\]\n]+)\]\([^)\n]*\)/dg;
const IMAGE_WITHOUT_ALT = /!\[[ \t]*\]\([^)\n]*\)/g;
const LINK = /\[([^\]\n]+)\](?:\([^)\n]*\)|\[[^\]\n]*\])/dg;
const AUTOLINK = /<(https?:\/\/[^>\s]+)>/dg;
const STRONG = /(\*\*|__)(?=\S)([^\n]+?)(?<=\S)\1/dg;
const EMPHASIS_STAR = /(?<![\w*])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![\w*])/dg;
const EMPHASIS_UNDERSCORE = /(?<![\w_])_(?=[^\s_])([^_\n]+?)(?<=[^\s_])_(?![\w_])/dg;
const STRIKETHROUGH = /~~(?=\S)([^\n]+?)(?<=\S)~~/dg;
/** "[^1]" footnote references (definitions keep their text). */
const MARKDOWN_FOOTNOTE = /\[\^[^\]\s]+\](?!:)/g;

/** Deletes the markers around a captured group (patterns use the `d` flag), keeping the group's text. */
function unwrap(cleanup: Cleanup, pattern: RegExp, group = 1, protectContent = false): void {
  for (const match of cleanup.text.matchAll(pattern)) {
    const [contentStart, contentEnd] = match.indices![group] as [number, number];
    const edits = [
      deletion(match.index, contentStart, "markdown"),
      deletion(contentEnd, match.index + match[0].length, "markdown"),
    ].filter((edit) => edit.end > edit.start);
    claim(cleanup, edits, protectContent ? [[contentStart, contentEnd]] : []);
  }
}

function removeAll(cleanup: Cleanup, pattern: RegExp, reason: TextCleanupAction): void {
  for (const match of cleanup.text.matchAll(pattern)) {
    claim(cleanup, [deletion(match.index, match.index + match[0].length, reason)]);
  }
}

/** Removes inline tokens with `removal`, so no doubled space is left behind. */
function removeInline(cleanup: Cleanup, pattern: RegExp, reason: TextCleanupAction): void {
  for (const match of cleanup.text.matchAll(pattern)) {
    claim(cleanup, [removal(cleanup.text, match.index, match.index + match[0].length, reason)]);
  }
}

function cleanMarkdown(cleanup: Cleanup): void {
  // Code first, so emphasis-like characters inside code are left alone.
  removeLines(cleanup, CODE_FENCE_LINE, "markdown");
  unwrap(cleanup, CODE_SPAN, 2, true);
  removeLines(cleanup, HORIZONTAL_RULE, "markdown");
  removeAll(cleanup, HEADING_MARKER, "markdown");
  removeAll(cleanup, HEADING_CLOSING, "markdown");
  removeAll(cleanup, BLOCKQUOTE_MARKER, "markdown");
  removeAll(cleanup, BULLET_MARKER, "markdown");
  removeAll(cleanup, MARKDOWN_FOOTNOTE, "markdown");
  removeInline(cleanup, IMAGE_WITHOUT_ALT, "markdown");
  unwrap(cleanup, IMAGE);
  unwrap(cleanup, LINK);
  unwrap(cleanup, AUTOLINK);
  unwrap(cleanup, STRONG, 2);
  unwrap(cleanup, EMPHASIS_STAR);
  unwrap(cleanup, EMPHASIS_UNDERSCORE);
  unwrap(cleanup, STRIKETHROUGH);
}

// ---------------------------------------------------------------------------
// Citations and footnote markers

/** "[1]", "[1, 2]", "[3–5]", "[citation needed]", "[note 2]", "[a]"; adjacent ones form one run. */
const CITATION_TOKEN = "\\[(?:\\d{1,4}(?:[ \\t]*[,–-][ \\t]*\\d{1,4})*|citation needed|clarification needed|note[ \\t]+\\d{1,3}|[a-z])\\]";
const CITATION = new RegExp(`${CITATION_TOKEN}(?:[ \\t]*${CITATION_TOKEN})*`, "giu");
/** Superscript digits after sentence punctuation or a word of three or more letters ("m²" stays). */
const SUPERSCRIPT_MARKER = /(?<=[.,;:!?)"'”’\]]|\p{L}{3})[⁰¹²³⁴⁵⁶⁷⁸⁹]+(?![\p{L}\p{N}])/gu;
const DAGGER_MARKER = /(?<=[\p{L}.,;:!?)])[†‡]+(?![\p{L}\p{N}])/gu;

function cleanCitations(cleanup: Cleanup): void {
  removeInline(cleanup, CITATION, "citations");
}

function cleanFootnotes(cleanup: Cleanup): void {
  removeAll(cleanup, SUPERSCRIPT_MARKER, "footnotes");
  removeAll(cleanup, DAGGER_MARKER, "footnotes");
}

// ---------------------------------------------------------------------------
// URLs

const URL = /(?<![\p{L}\p{N}_@./-])(?:https?:\/\/|www\.)[^\s<>"'`]+/giu;
const URL_HOST = /^(?:https?:\/\/)?(?:www\.)?([^/?#:\s]+)/i;
const URL_TRAILING_PUNCTUATION = ".,;:!?'\"]}>";

function countOf(text: string, character: string): number {
  return text.split(character).length - 1;
}

/** Sentence punctuation and unbalanced closing parentheses are not part of a URL. */
function trimUrl(url: string): string {
  let trimmed = url;
  while (
    URL_TRAILING_PUNCTUATION.includes(trimmed.at(-1) as string)
    || (trimmed.endsWith(")") && countOf(trimmed, ")") > countOf(trimmed, "("))
  ) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

function cleanUrls(cleanup: Cleanup, mode: "domain" | "remove"): void {
  for (const match of cleanup.text.matchAll(URL)) {
    const end = match.index + trimUrl(match[0]).length;
    // URL matches start with "http" or "www", so the host group always matches.
    const host = (URL_HOST.exec(match[0]) as RegExpExecArray)[1];
    const edit = mode === "domain" && host.includes(".")
      ? { start: match.index, end, replacement: host.toLowerCase(), reason: "urls" }
      : removal(cleanup.text, match.index, end, "urls");
    claim(cleanup, [edit]);
  }
}

// ---------------------------------------------------------------------------
// Emoji

/**
 * Emoji presentation characters (or text-style pictographs forced to emoji
 * with U+FE0F), keycaps and flags, with skin tones and ZWJ sequences. "©",
 * "®" and "™" without U+FE0F are text and stay.
 */
const EMOJI_TOKEN = "(?:[#*0-9]\\uFE0F?\\u20E3|(?:\\p{Emoji_Presentation}|\\p{Extended_Pictographic}\\uFE0F)(?:\\uFE0F|[\\u{1F3FB}-\\u{1F3FF}])*(?:\\u200D(?:\\p{Emoji_Presentation}|\\p{Extended_Pictographic})\\uFE0F?[\\u{1F3FB}-\\u{1F3FF}]?)*)";
/** A run of emoji, possibly separated by spaces ("🎉 🎉"), is removed as one. */
const EMOJI = new RegExp(`${EMOJI_TOKEN}(?:[ \\t]*${EMOJI_TOKEN})*`, "gu");

function cleanEmoji(cleanup: Cleanup): void {
  removeInline(cleanup, EMOJI, "emoji");
}

// ---------------------------------------------------------------------------
// PDF artifacts

const LIGATURES: Readonly<Record<string, string>> = {
  "ﬀ": "ff",
  "ﬁ": "fi",
  "ﬂ": "fl",
  "ﬃ": "ffi",
  "ﬄ": "ffl",
};
const LIGATURE = /[ﬀﬁﬂﬃﬄ]/g;
const SOFT_HYPHEN = /­/g;
/** A line holding only a page number: "12", "Page 12", "- 12 -", "12 of 300". */
const PAGE_NUMBER_LINE = /^[ \t]*(?:[-–—][ \t]*)?(?:page[ \t]+)?\d{1,4}(?:[ \t]+of[ \t]+\d{1,4})?(?:[ \t]*[-–—])?[ \t]*(?:\n|$)/gim;
/** A single line break (never part of a paragraph break) with the spaces around it. */
const SINGLE_LINE_BREAK = /(?<!\n[ \t]*)[ \t]*\n[ \t]*(?![ \t]*\n)/g;
const LIST_ITEM_START = /^(?:[-*•]|\d+[.)])\s/u;

function lineBefore(text: string, index: number): string {
  return text.slice(text.lastIndexOf("\n", index - 1) + 1, index);
}

function lineAfter(text: string, index: number): string {
  const end = text.indexOf("\n", index);
  return text.slice(index, end < 0 ? text.length : end);
}

/** Same continuation rules as the Reader's PDF import (`unwrapHardLineBreaks`). */
function cleanPdfArtifacts(cleanup: Cleanup): void {
  const { text } = cleanup;
  for (const match of text.matchAll(LIGATURE)) {
    claim(cleanup, [{ start: match.index, end: match.index + 1, replacement: LIGATURES[match[0]], reason: "pdfArtifacts" }]);
  }
  removeAll(cleanup, SOFT_HYPHEN, "pdfArtifacts");
  // A page number is a line of its own; the first line of the text is a title or a heading, not a page.
  removeLines(cleanup, PAGE_NUMBER_LINE, "pdfArtifacts", true);
  for (const match of text.matchAll(SINGLE_LINE_BREAK)) {
    const start = match.index;
    const end = start + match[0].length;
    const previous = lineBefore(text, start);
    const next = lineAfter(text, end);
    if (!previous.trim() || !next || LIST_ITEM_START.test(next)) continue;
    const hyphenBreak = /\p{L}-$/u.test(previous) && /^\p{Ll}/u.test(next);
    const continues = hyphenBreak
      || /[,;–—]$/.test(previous)
      || (!/[.!?:…"'”’)\]]$/.test(previous) && /^[\p{Ll}\d(“"‘']/u.test(next));
    if (!continues) continue;
    const edit = hyphenBreak
      ? { start: start - 1, end, replacement: "", reason: "pdfArtifacts" }
      : { start, end, replacement: " ", reason: "pdfArtifacts" };
    claim(cleanup, [edit]);
  }
}

// ---------------------------------------------------------------------------
// HTML entities, punctuation and whitespace

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  euro: "€",
  pound: "£",
};
const HTML_ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/g;

function decodeEntity(decimal: string | undefined, hex: string | undefined, name: string | undefined): string | undefined {
  if (name !== undefined) return NAMED_ENTITIES[name];
  const code = decimal !== undefined ? Number(decimal) : Number.parseInt(hex as string, 16);
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return undefined;
  return String.fromCodePoint(code);
}

/** Non-breaking space entities with the spaces around them, read as one space. */
const SPACE_ENTITY_RUN = /[ \t]*(?:&nbsp;|&#160;|&#[xX]0*[aA]0;)(?:[ \t]|&nbsp;|&#160;|&#[xX]0*[aA]0;)*/g;

function cleanHtmlEntities(cleanup: Cleanup): void {
  const { text } = cleanup;
  for (const match of text.matchAll(SPACE_ENTITY_RUN)) {
    const start = match.index;
    const end = start + match[0].length;
    const atLineEdge = start === 0 || text[start - 1] === "\n" || end === text.length || text[end] === "\n";
    claim(cleanup, [{ start, end, replacement: atLineEdge ? "" : " ", reason: "htmlEntities" }]);
  }
  for (const match of text.matchAll(HTML_ENTITY)) {
    const replacement = decodeEntity(match[1], match[2], match[3]);
    if (replacement === undefined) continue;
    claim(cleanup, [{ start: match.index, end: match.index + match[0].length, replacement, reason: "htmlEntities" }]);
  }
}

/** "!!!" -> "!", "???" -> "?", "?!?!" -> "?!", ",," -> ",", "....." -> "...". */
const REPEATED_PUNCTUATION = /[!?]{2,}|,{2,}|\.{4,}/g;

function collapsePunctuation(run: string): string {
  if (run[0] === ",") return ",";
  if (run[0] === ".") return "...";
  const hasQuestion = run.includes("?");
  const hasExclamation = run.includes("!");
  if (hasQuestion && hasExclamation) return run[0] === "?" ? "?!" : "!?";
  return run[0];
}

function cleanRepeatedPunctuation(cleanup: Cleanup): void {
  for (const match of cleanup.text.matchAll(REPEATED_PUNCTUATION)) {
    const replacement = collapsePunctuation(match[0]);
    if (replacement === match[0]) continue;
    claim(cleanup, [{ start: match.index, end: match.index + match[0].length, replacement, reason: "repeatedPunctuation" }]);
  }
}

const CARRIAGE_RETURN = /\r\n?/g;
const SPACE_RUN = /(?<=\S)[ \t\u00A0]{2,}(?=\S)|\t/g;
const TRAILING_SPACE = /[ \t\u00A0]+$/gm;
const LEADING_SPACE = /^[ \t\u00A0]+/gm;
const BLANK_LINE_RUN = /\n{3,}/g;

function cleanWhitespace(cleanup: Cleanup): void {
  const replaceAll = (pattern: RegExp, replacement: string) => {
    for (const match of cleanup.text.matchAll(pattern)) {
      claim(cleanup, [{ start: match.index, end: match.index + match[0].length, replacement, reason: "whitespace" }]);
    }
  };
  replaceAll(CARRIAGE_RETURN, "\n");
  replaceAll(TRAILING_SPACE, "");
  replaceAll(LEADING_SPACE, "");
  replaceAll(SPACE_RUN, " ");
  replaceAll(BLANK_LINE_RUN, "\n\n");
}

// ---------------------------------------------------------------------------

function emptyCounts(): Record<TextCleanupAction, number> {
  return Object.fromEntries(ALL_TEXT_CLEANUP_ACTIONS.map((action) => [action, 0])) as Record<TextCleanupAction, number>;
}

function runOnce(text: string, actions: ReadonlySet<TextCleanupAction>, urlMode: "domain" | "remove"): TextEdit[] {
  const cleanup: Cleanup = { text, claimed: new Uint8Array(text.length), edits: [] };
  const passes: Record<TextCleanupAction, () => void> = {
    markdown: () => cleanMarkdown(cleanup),
    citations: () => cleanCitations(cleanup),
    footnotes: () => cleanFootnotes(cleanup),
    urls: () => cleanUrls(cleanup, urlMode),
    emoji: () => cleanEmoji(cleanup),
    pdfArtifacts: () => cleanPdfArtifacts(cleanup),
    htmlEntities: () => cleanHtmlEntities(cleanup),
    repeatedPunctuation: () => cleanRepeatedPunctuation(cleanup),
    whitespace: () => cleanWhitespace(cleanup),
  };
  for (const action of ALL_TEXT_CLEANUP_ACTIONS) {
    if (actions.has(action)) passes[action]();
  }
  return cleanup.edits;
}

/**
 * Cleans `text` for narration. The result's offset maps point back at the
 * original text and `counts` says how many edits each action made.
 */
export function cleanupText(text: string, options: TextCleanupOptions = {}): TextCleanupResult {
  const actions = new Set(options.actions ?? DEFAULT_TEXT_CLEANUP_ACTIONS);
  const rewrite = applyTextEdits(text, runOnce(text, actions, options.urlMode ?? "domain"));
  const counts = emptyCounts();
  for (const edit of rewrite.edits) counts[edit.reason as TextCleanupAction] += 1;
  return { ...rewrite, counts };
}
