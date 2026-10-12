import type { TextEdit } from "../textEdits";

/** Rule ids accepted by `normalizeForSpeech`; each edit's `reason` is one of them. */
export type SpeechNormalizationRule =
  | "numbers"
  | "ordinals"
  | "decimals"
  | "years"
  | "dates"
  | "times"
  | "currency"
  | "percentages"
  | "units"
  | "abbreviations"
  | "urls"
  | "emails"
  | "romanNumerals";

/**
 * A language's normalizer: returns non-overlapping edits against `text` for
 * the enabled rules. `region` is the BCP-47 region subtag (e.g. "GB"), if any.
 */
export type LanguageSpeechNormalizer = (
  text: string,
  rules: ReadonlySet<SpeechNormalizationRule>,
  region?: string,
) => TextEdit[];
