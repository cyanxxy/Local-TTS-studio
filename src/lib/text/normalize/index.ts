/**
 * Opt-in text normalization for speech: rewrites numbers, dates, currency,
 * abbreviations, URLs and similar tokens into the words a listener expects,
 * through `applyTextEdits` so every output offset maps back to the source.
 *
 * Pure and deterministic (no DOM, no Intl), so it can run in workers. Each
 * language registers one normalizer below; unsupported languages pass through
 * unchanged.
 */
import { applyTextEdits, type TextRewrite } from "../textEdits";
import { normalizeEnglish } from "./en";
import type { LanguageSpeechNormalizer, SpeechNormalizationRule } from "./types";

export type { LanguageSpeechNormalizer, SpeechNormalizationRule } from "./types";

export const ALL_SPEECH_NORMALIZATION_RULES: readonly SpeechNormalizationRule[] = Object.freeze([
  "numbers",
  "ordinals",
  "decimals",
  "years",
  "dates",
  "times",
  "currency",
  "percentages",
  "units",
  "abbreviations",
  "urls",
  "emails",
  "romanNumerals",
]);

export interface SpeechNormalizationOptions {
  /** BCP-47 tag such as "en", "en-US" or "en-GB". Defaults to English. */
  language?: string;
  /** Rules to apply. Defaults to all of them. */
  rules?: readonly SpeechNormalizationRule[];
}

/** Normalizers keyed by lowercase primary language subtag. */
const NORMALIZERS: ReadonlyMap<string, LanguageSpeechNormalizer> = new Map([
  ["en", normalizeEnglish],
]);

const DEFAULT_LANGUAGE = "en";
const REGION_SUBTAG = /^(?:[A-Za-z]{2}|\d{3})$/;

function parseLanguage(language: string | undefined): { primary: string; region?: string } {
  const [primary, ...subtags] = (language?.trim() || DEFAULT_LANGUAGE).split(/[-_]/);
  return {
    primary: primary.toLowerCase(),
    region: subtags.find((subtag) => REGION_SUBTAG.test(subtag))?.toUpperCase(),
  };
}

/** Whether `language` (default English) has a normalizer. */
export function isSpeechNormalizationSupported(language?: string): boolean {
  return NORMALIZERS.has(parseLanguage(language).primary);
}

/**
 * Rewrites `text` for speech. Unsupported languages and an empty rule list
 * return an identity rewrite.
 */
export function normalizeForSpeech(
  text: string,
  options: SpeechNormalizationOptions = {},
): TextRewrite {
  const { primary, region } = parseLanguage(options.language);
  const normalizer = NORMALIZERS.get(primary);
  const rules = new Set(options.rules ?? ALL_SPEECH_NORMALIZATION_RULES);
  if (!normalizer || rules.size === 0) return applyTextEdits(text, []);
  return applyTextEdits(text, normalizer(text, rules, region));
}
