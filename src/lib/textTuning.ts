import type { ChunkPauseKind, PronunciationRule } from "../types";
import { SPEED_MAX, SPEED_MIN } from "../constants";
import { MAX_BREAK_SEC, stripSpeechBreakMarkup } from "./text/speechMarkup";
import { applyTextEdits, type TextEdit, type TextRewrite } from "./text/textEdits";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Where a pronunciation rule may match. */
export type PronunciationRuleScope = "word" | "anywhere";

export interface PronunciationMatchRule {
  from: string;
  to: string;
  /**
   * `true` matches the exact case, `false` ignores case. When omitted, a rule
   * whose `from` contains an uppercase letter is case-sensitive, so "US" never
   * rewrites "us", while an all-lowercase rule such as "route" still matches
   * "Route" at the start of a sentence.
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
  pattern: RegExp;
  to: string;
}

// Word characters for boundary checks: letters, combining marks, digits and
// underscore in any script, unlike `\b`, which only knows ASCII.
const WORD_CHAR = "[\\p{L}\\p{M}\\p{N}_]";
// Scripts written without spaces between words. A boundary requirement would
// stop "東京" from ever matching inside "東京都", so rule edges in these scripts
// match anywhere.
const UNSPACED_SCRIPT_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const WORD_EDGE_CHAR = /[\p{L}\p{M}\p{N}_]/u;
const UPPERCASE_LETTER = /\p{Lu}/u;

function needsBoundary(edgeChar: string): boolean {
  return WORD_EDGE_CHAR.test(edgeChar) && !UNSPACED_SCRIPT_CHAR.test(edgeChar);
}

function compileRule(rule: PronunciationMatchRule): CompiledRule | null {
  const from = rule.from.trim();
  const to = rule.to.trim();
  if (!from || !to) return null;

  const caseSensitive = rule.caseSensitive ?? UPPERCASE_LETTER.test(from);
  const chars = Array.from(from);
  const wordScope = (rule.scope ?? "word") === "word";
  const before = wordScope && needsBoundary(chars[0]) ? `(?<!${WORD_CHAR})` : "";
  const after = wordScope && needsBoundary(chars[chars.length - 1]) ? `(?!${WORD_CHAR})` : "";
  return {
    pattern: new RegExp(`${before}${escapeRegExp(from)}${after}`, caseSensitive ? "uy" : "iuy"),
    to,
  };
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

  // Case-insensitive alternation of every rule finds candidate positions; the
  // per-rule sticky patterns then decide case and word boundaries.
  const candidates = compiled.length > 0
    ? new RegExp(compiled.map((rule) => `(?:${rule.pattern.source})`).join("|"), "giu")
    : null;

  const findEdits = (text: string): TextEdit[] => {
    if (!candidates) return [];
    const edits: TextEdit[] = [];
    candidates.lastIndex = 0;
    let candidate: RegExpExecArray | null;
    while ((candidate = candidates.exec(text)) !== null) {
      const position = candidate.index;
      let matched = false;
      for (const rule of compiled) {
        rule.pattern.lastIndex = position;
        const match = rule.pattern.exec(text);
        if (!match) continue;
        edits.push({ start: position, end: position + match[0].length, replacement: rule.to, reason: "pronunciation" });
        candidates.lastIndex = position + match[0].length;
        matched = true;
        break;
      }
      // The candidate only matched with the wrong case; resume one code unit
      // later so overlapping candidates are still found.
      if (!matched) candidates.lastIndex = position + 1;
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
