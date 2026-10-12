/**
 * Inline audio tags for Chatterbox Turbo.
 *
 * Users write one case-insensitive bracket syntax (`[laughs]`, `[Clears
 * Throat]`, `[whispers]`). Tags the tokenizer knows are rewritten to its exact
 * added-token spelling; every other bracketed direction is removed so it is
 * never read aloud.
 */

/** The tokenizer's added tokens 50257-50275 at the pinned revision. */
export const CHATTERBOX_TAG_TOKENS = [
  "[angry]",
  "[fear]",
  "[surprised]",
  "[whispering]",
  "[advertisement]",
  "[dramatic]",
  "[narration]",
  "[crying]",
  "[happy]",
  "[sarcastic]",
  "[clear throat]",
  "[sigh]",
  "[shush]",
  "[cough]",
  "[groan]",
  "[sniff]",
  "[gasp]",
  "[chuckle]",
  "[laugh]",
] as const;

export type ChatterboxTagToken = (typeof CHATTERBOX_TAG_TOKENS)[number];

const TAG_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "[angry]": ["angrily", "anger", "furious"],
  "[fear]": ["fearful", "afraid", "scared", "frightened", "terrified"],
  "[surprised]": ["surprise", "shocked", "astonished"],
  "[whispering]": ["whisper", "whispers", "whispered"],
  "[advertisement]": ["ad", "advert", "commercial"],
  "[dramatic]": ["dramatically"],
  "[narration]": ["narrator", "narrating"],
  "[crying]": ["cry", "cries", "sob", "sobs", "sobbing", "tearful"],
  "[happy]": ["happily", "cheerful", "cheerfully", "joyful", "excited"],
  "[sarcastic]": ["sarcastically", "sarcasm"],
  "[clear throat]": ["clears throat", "clearing throat", "throat clear", "throat clearing"],
  "[sigh]": ["sighs", "sighing", "exhale", "exhales"],
  "[shush]": ["shushes", "shushing", "shh", "shhh"],
  "[cough]": ["coughs", "coughing"],
  "[groan]": ["groans", "groaning"],
  "[sniff]": ["sniffs", "sniffing", "sniffle", "sniffles"],
  "[gasp]": ["gasps", "gasping"],
  "[chuckle]": ["chuckles", "chuckling"],
  "[laugh]": ["laughs", "laughing", "laughter"],
};

const TAG_LOOKUP: ReadonlyMap<string, ChatterboxTagToken> = new Map(
  CHATTERBOX_TAG_TOKENS.flatMap((token) => [
    [token.slice(1, -1), token] as const,
    ...(TAG_ALIASES[token] ?? []).map((alias) => [alias, token] as const),
  ]),
);

/** Bracketed spans longer than this stay prose; real directions are short. */
const MAX_TAG_CONTENT_LENGTH = 64;
// `[[word]]` is the shared emphasis syntax (textTuning.ts), so it passes through.
const TAG_PATTERN = new RegExp(`\\[\\[[^\\[\\]\\n]+\\]\\]|\\[([^\\[\\]\\n]{1,${MAX_TAG_CONTENT_LENGTH}})\\]`, "g");
// GPT-2 control tokens such as <|endoftext|> would end the prompt early.
const SPECIAL_TOKEN_PATTERN = /<\|[^|<>\n]{0,64}\|>/g;
const DIGIT = /\p{N}/gu;
const SPOKEN_CHARACTER = /[\p{L}\p{N}]/gu;

export type ChatterboxTextSpan =
  | { kind: "text"; text: string }
  | { kind: "tag"; raw: string; token: ChatterboxTagToken | null };

export interface RenderedChatterboxText {
  /** Text ready for the tokenizer, with canonical tags and no unknown ones. */
  text: string;
  /** Canonical tags kept, in order of appearance. */
  tags: ChatterboxTagToken[];
  /** Original spellings of the bracketed directions that were removed. */
  removedTags: string[];
  /** Letters and digits outside tags; zero means nothing would be spoken. */
  spokenCharacters: number;
  /** Digits among spokenCharacters; they need a larger token budget. */
  digitCount: number;
}

export function normalizeChatterboxTagName(name: string): ChatterboxTagToken | null {
  const key = name.trim().toLowerCase().replace(/[\s_-]+/g, " ");
  return TAG_LOOKUP.get(key) ?? null;
}

export function parseChatterboxTags(text: string): ChatterboxTextSpan[] {
  const spans: ChatterboxTextSpan[] = [];
  let cursor = 0;
  for (const match of text.matchAll(TAG_PATTERN)) {
    const content = match[1];
    if (content === undefined) continue;
    if (match.index > cursor) spans.push({ kind: "text", text: text.slice(cursor, match.index) });
    spans.push({ kind: "tag", raw: match[0], token: normalizeChatterboxTagName(content) });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) spans.push({ kind: "text", text: text.slice(cursor) });
  return spans;
}

/**
 * Rewrite tags for the tokenizer. `transformSpeech` runs on the text between
 * tags only, so pronunciation rules can never rewrite a tag's spelling.
 */
export function renderChatterboxText(
  text: string,
  transformSpeech: (speech: string) => string = (speech) => speech,
): RenderedChatterboxText {
  const tags: ChatterboxTagToken[] = [];
  const removedTags: string[] = [];
  let spokenCharacters = 0;
  let digitCount = 0;
  const parts: string[] = [];

  for (const span of parseChatterboxTags(text)) {
    if (span.kind === "tag") {
      if (span.token) {
        tags.push(span.token);
        parts.push(` ${span.token} `);
      } else {
        removedTags.push(span.raw);
        parts.push(" ");
      }
      continue;
    }
    const speech = transformSpeech(span.text.replace(SPECIAL_TOKEN_PATTERN, " "))
      .replace(SPECIAL_TOKEN_PATTERN, " ");
    spokenCharacters += speech.match(SPOKEN_CHARACTER)?.length ?? 0;
    digitCount += speech.match(DIGIT)?.length ?? 0;
    parts.push(speech);
  }

  const rendered = parts.join("")
    .replace(/\s+/g, " ")
    .replace(/ ([,.!?;:])/g, "$1")
    .trim();
  return { text: rendered, tags, removedTags, spokenCharacters, digitCount };
}

const PUNCTUATION_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  ["…", ", "],
  [":", ","],
  ["—", "-"],
  ["–", "-"],
  [" ,", ","],
  ["“", "\""],
  ["”", "\""],
  ["‘", "'"],
  ["’", "'"],
];
const SENTENCE_ENDERS = [".", "!", "?", "-", ","];

/**
 * Port of upstream `punc_norm` (chatterbox/tts_turbo.py): the model was trained
 * on this punctuation, and a missing final stop makes it trail off.
 */
export function normalizeChatterboxPunctuation(text: string): string {
  let normalized = text.split(/\s+/).filter(Boolean).join(" ");
  if (!normalized) return "";
  const first = normalized[0];
  if (first !== first.toUpperCase()) normalized = first.toUpperCase() + normalized.slice(1);
  for (const [from, to] of PUNCTUATION_REPLACEMENTS) normalized = normalized.replaceAll(from, to);
  normalized = normalized.trimEnd();
  if (!SENTENCE_ENDERS.some((ender) => normalized.endsWith(ender))) normalized += ".";
  return normalized;
}
