import type { ChunkPauseKind, PronunciationRule } from "../types";
import { SPEED_MAX, SPEED_MIN } from "../constants";
import { MAX_BREAK_SEC, stripSpeechBreakMarkup } from "./text/speechMarkup";
import { applyTextEdits, type TextEdit, type TextRewrite } from "./text/textEdits";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Where a pronunciation rule may match. */
export type PronunciationRuleScope = "word" | "anywhere";

export interface PronunciationMatchRule {
  from: string;
  to: string;
  /**
   * `true` matches the exact case, `false` ignores case. When omitted (which
   * is every stored version 1 rule), `isAcronymRule(from)` decides: an
   * all-caps acronym such as "US" is case-sensitive so it never rewrites "us",
   * and anything else, "route", "Kokoro" or "Open TTS", ignores case as
   * version 1 rules always did.
   */
  caseSensitive?: boolean;
  /**
   * "word" (the default) only matches where the rule is not glued to other
   * letters or digits; "anywhere" also matches inside words.
   */
  scope?: PronunciationRuleScope;
}

export interface PronunciationMatcher {
  /** True when the matcher has no usable rules and `apply` is the identity. */
  readonly empty: boolean;
  apply(text: string): string;
  /** Same replacements as `apply`, with an offset map back to `text`. */
  rewrite(text: string): TextRewrite;
}

interface CompiledRule {
  to: string;
  /** The rule's written form, trimmed. */
  from: string;
  caseSensitive: boolean;
  /** No letter or digit may touch the match on this side. */
  boundaryBefore: boolean;
  boundaryAfter: boolean;
}

// Word characters for boundary checks: letters, combining marks, digits and
// underscore in any script, unlike `\b`, which only knows ASCII.
// Scripts written without spaces between words. A boundary requirement would
// stop "東京" from ever matching inside "東京都", so rule edges in these scripts
// match anywhere.
const UNSPACED_SCRIPT_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const WORD_EDGE_CHAR = /[\p{L}\p{M}\p{N}_]/u;
const UPPERCASE_LETTER = /\p{Lu}/gu;
const LOWERCASE_LETTER = /\p{Ll}/u;

/**
 * True when `from` is an all-caps acronym: two or more uppercase letters and
 * no lowercase ones ("US", "NASA", "U.S."). This is the case policy for rules
 * that do not say whether they are case-sensitive.
 */
export function isAcronymRule(from: string): boolean {
  const text = from.trim();
  return !LOWERCASE_LETTER.test(text) && (text.match(UPPERCASE_LETTER)?.length ?? 0) >= 2;
}

function needsBoundary(edgeChar: string): boolean {
  return WORD_EDGE_CHAR.test(edgeChar) && !UNSPACED_SCRIPT_CHAR.test(edgeChar);
}

function compileRule(rule: PronunciationMatchRule): CompiledRule | null {
  const from = rule.from.trim();
  const to = rule.to.trim();
  if (!from || !to) return null;

  const caseSensitive = rule.caseSensitive ?? isAcronymRule(from);
  const chars = Array.from(from);
  const wordScope = (rule.scope ?? "word") === "word";
  return {
    to,
    from,
    caseSensitive,
    boundaryBefore: wordScope && needsBoundary(chars[0]),
    boundaryAfter: wordScope && needsBoundary(chars[chars.length - 1]),
  };
}

/** Whether the code point just before `index` is a word character. */
function wordCharBefore(text: string, index: number): boolean {
  if (index === 0) return false;
  const low = text.charCodeAt(index - 1);
  const start = low >= 0xdc00 && low <= 0xdfff && index >= 2 ? index - 2 : index - 1;
  return WORD_EDGE_CHAR.test(String.fromCodePoint(text.codePointAt(start)!));
}

/** Whether the code point at `index` is a word character. */
function wordCharAt(text: string, index: number): boolean {
  return index < text.length && WORD_EDGE_CHAR.test(String.fromCodePoint(text.codePointAt(index)!));
}

/** Whether `rule` matches `text` at `position`; the candidate already matches its form ignoring case. */
function ruleMatchesAt(rule: CompiledRule, text: string, position: number): boolean {
  const end = position + rule.from.length;
  if (rule.caseSensitive && text.slice(position, end) !== rule.from) return false;
  if (rule.boundaryBefore && wordCharBefore(text, position)) return false;
  return !(rule.boundaryAfter && wordCharAt(text, end));
}

/**
 * Compiles rules into a single-pass matcher.
 *
 * At each position the longest matching rule wins (earlier rules win ties),
 * and replacement text is never matched again, so a rule cannot rewrite the
 * output of another rule.
 */
export function compilePronunciationMatcher(
  rules: readonly PronunciationMatchRule[],
): PronunciationMatcher {
  const compiled = rules
    .map((rule) => ({ rule, compiled: compileRule(rule) }))
    .filter((entry): entry is { rule: PronunciationMatchRule; compiled: CompiledRule } => entry.compiled !== null)
    .sort((a, b) => b.rule.from.trim().length - a.rule.from.trim().length)
    .map((entry) => entry.compiled);

  // Rules are looked up by their whole written form, lowercased: at a position
  // only the lengths some rule has are tried, longest first, so the cost does
  // not grow with the number of rules. The rule's own case and
  // word-boundary checks then decide. `compiled` is sorted longest first, so
  // each list keeps earlier rules ahead of later ones of the same length.
  const byForm = new Map<string, CompiledRule[]>();
  for (const rule of compiled) {
    const key = rule.from.toLowerCase();
    const list = byForm.get(key);
    if (list) list.push(rule);
    else byForm.set(key, [rule]);
  }
  const lengths = [...new Set(compiled.map((rule) => rule.from.length))].sort((a, b) => b - a);
  const candidatesAt = function* (text: string, position: number): Generator<CompiledRule> {
    for (const length of lengths) {
      if (position + length > text.length) continue;
      const list = byForm.get(text.slice(position, position + length).toLowerCase());
      if (list) yield* list;
    }
  };

  const findEdits = (text: string): TextEdit[] => {
    if (compiled.length === 0) return [];
    const edits: TextEdit[] = [];
    let position = 0;
    while (position < text.length) {
      let matchedLength = 0;
      for (const rule of candidatesAt(text, position)) {
        if (!ruleMatchesAt(rule, text, position)) continue;
        matchedLength = rule.from.length;
        edits.push({ start: position, end: position + matchedLength, replacement: rule.to, reason: "pronunciation" });
        break;
      }
      position += matchedLength || 1;
    }
    return edits;
  };

  return {
    empty: compiled.length === 0,
    apply: (text) => applyTextEdits(text, findEdits(text)).text,
    rewrite: (text) => applyTextEdits(text, findEdits(text)),
  };
}

const legacyMatchers = new WeakMap<readonly PronunciationRule[], PronunciationMatcher>();

/**
 * Applies `from=to` lexicon rules with the case policy documented on
 * `PronunciationMatchRule`. Workers call this once per chunk with the same
 * rules array, so the compiled matcher is cached per array.
 */
export function applyPronunciationRules(text: string, rules: readonly PronunciationRule[]): string {
  if (rules.length === 0) return text;
  let matcher = legacyMatchers.get(rules);
  if (!matcher) {
    matcher = compilePronunciationMatcher(rules);
    legacyMatchers.set(rules, matcher);
  }
  return matcher.apply(text);
}

/**
 * `[[word]]`, `**word**` or `*word*`, scanned left to right in one pass.
 * Shared with the spoken-text pipeline (`buildSpeechTextRewrite`).
 */
export const EMPHASIS_MARKUP = /\[\[([^[\]]+)\]\]|\*\*([^*]+)\*\*|\*([^*]+)\*/dg;

/** Removes `*word*`, `**word**` and `[[word]]` emphasis markers, keeping the words. */
export function stripEmphasisMarkup(text: string): string {
  return text.replace(EMPHASIS_MARKUP, (match: string) => {
    // "[[" and "**" are two characters; a single "*" is never followed by another.
    const markerLength = match[0] === "[" || match[1] === "*" ? 2 : 1;
    return match.slice(markerLength, -markerLength);
  });
}

/**
 * @deprecated No engine can render emphasis, and the old strength setting
 * repeated the word instead ("key, key, key"). Markers are always stripped;
 * the strength argument is ignored and kept so stored settings stay valid.
 */
export function applyEmphasisMarkup(text: string, emphasisStrength?: number): string {
  void emphasisStrength;
  return stripEmphasisMarkup(text);
}

/**
 * Text actually sent to an engine for one chunk: break tags are dropped (the
 * chunker turns them into pauses), pronunciation rules applied, and emphasis
 * markers stripped. `emphasisStrength` is ignored; see `applyEmphasisMarkup`.
 */
export function tuneChunkText(
  text: string,
  pronunciationRules: readonly PronunciationRule[],
  emphasisStrength?: number,
): string {
  void emphasisStrength;
  return stripEmphasisMarkup(applyPronunciationRules(stripSpeechBreakMarkup(text), pronunciationRules));
}

export function resolvePauseSeconds(
  pauseKind: ChunkPauseKind,
  defaultPauseSec: number,
  overrides?: Partial<Record<ChunkPauseKind, number>>,
): number {
  const override = overrides?.[pauseKind];
  if (typeof override === "number" && Number.isFinite(override)) {
    return clamp(override, 0, 2);
  }
  return clamp(defaultPauseSec, 0, 2);
}

/**
 * Pause after a chunk: an explicit break tag's pause (see `chunkWithSpeechBreaks`)
 * is used as written, up to `MAX_BREAK_SEC`; otherwise the pause-kind default
 * and slider overrides apply through `resolvePauseSeconds`.
 */
export function resolveChunkPauseSeconds(
  chunk: { pauseKind: ChunkPauseKind; pauseAfterSec: number; breakPauseSec?: number },
  overrides?: Partial<Record<ChunkPauseKind, number>>,
): number {
  if (typeof chunk.breakPauseSec === "number" && Number.isFinite(chunk.breakPauseSec)) {
    return clamp(chunk.breakPauseSec, 0, MAX_BREAK_SEC);
  }
  return resolvePauseSeconds(chunk.pauseKind, chunk.pauseAfterSec, overrides);
}

export function resolveSentenceSpeed(
  baseSpeed: number,
  sentenceSpeedVariance: number,
  text: string,
): number {
  const normalizedBaseSpeed = clamp(baseSpeed, SPEED_MIN, SPEED_MAX);
  const variance = clamp(sentenceSpeedVariance, 0, 0.5);
  if (variance <= 0) return normalizedBaseSpeed;

  const words = text.trim().length > 0 ? text.trim().split(/\s+/).length : 0;
  if (words === 0) return normalizedBaseSpeed;

  if (words <= 6) return clamp(normalizedBaseSpeed * (1 + variance), SPEED_MIN, SPEED_MAX);
  if (words >= 24) return clamp(normalizedBaseSpeed * (1 - variance), SPEED_MIN, SPEED_MAX);

  // Smooth interpolation from short to long sentence behavior.
  const t = (words - 6) / (24 - 6);
  const multiplier = (1 + variance) * (1 - t) + (1 - variance) * t;
  return clamp(normalizedBaseSpeed * multiplier, SPEED_MIN, SPEED_MAX);
}
