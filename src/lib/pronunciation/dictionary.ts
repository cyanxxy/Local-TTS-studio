/**
 * Pronunciation dictionaries (model v2).
 *
 * A dictionary is a named, toggleable list of rules. Alias rules replace the
 * written form with other text and work on every engine. Phoneme rules carry
 * an IPA transcription for engines that accept phonemes, plus an optional
 * alias that text-only engines speak instead. The legacy single lexicon
 * (`from=to` lines, version 1) converts into one dictionary of alias rules.
 *
 * Everything imported from a file goes through `validatePronunciationDictionary`,
 * which rejects unknown shapes and enforces size limits instead of trusting
 * the input.
 */
import type { PronunciationRule } from "../../types";
import type { PronunciationMatchRule, PronunciationRuleScope } from "../textTuning";

export const PRONUNCIATION_DICTIONARY_VERSION = 2;
/** `format` tag of the native JSON exchange file. */
export const PRONUNCIATION_DICTIONARY_FORMAT = "open-tts-pronunciation-dictionaries";

export const MAX_DICTIONARY_RULES = 5000;
export const MAX_DICTIONARIES_PER_FILE = 50;
const MAX_NAME_LENGTH = 120;
const MAX_ID_LENGTH = 120;
const MAX_LANGUAGE_LENGTH = 35;
const MAX_FROM_LENGTH = 200;
const MAX_TO_LENGTH = 500;
const MAX_PHONEME_LENGTH = 500;
/** Largest JSON file `parsePronunciationDictionaryJson` accepts, in UTF-16 units. */
export const MAX_DICTIONARY_FILE_CHARS = 4 * 1024 * 1024;

export type PhonemeAlphabet = "ipa";

interface RuleOptions {
  /** See `PronunciationMatchRule.caseSensitive`; omitted means the automatic policy. */
  caseSensitive?: boolean;
  /** See `PronunciationMatchRule.scope`; omitted means "word". */
  scope?: PronunciationRuleScope;
}

export interface PronunciationAliasRule extends RuleOptions {
  type: "alias";
  from: string;
  to: string;
}

export interface PronunciationPhonemeRule extends RuleOptions {
  type: "phoneme";
  from: string;
  phoneme: string;
  alphabet: PhonemeAlphabet;
  /** Spoken by engines that cannot take phonemes; without it they skip the rule. */
  alias?: string;
}

export type PronunciationDictionaryRule = PronunciationAliasRule | PronunciationPhonemeRule;

export interface PronunciationDictionary {
  version: typeof PRONUNCIATION_DICTIONARY_VERSION;
  id: string;
  name: string;
  enabled: boolean;
  /** BCP-47 tag; the dictionary applies only to matching languages. Omitted applies to all. */
  language?: string;
  rules: PronunciationDictionaryRule[];
}

export class PronunciationDictionaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PronunciationDictionaryError";
  }
}

const LONE_SURROGATE = /\p{Cs}/u;

/**
 * C0 controls except tab, LF and CR, DEL, C1 controls, and lone surrogates.
 * None of them can appear in an XML document, and none belong in a lexicon.
 */
function hasForbiddenCharacters(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return LONE_SURROGATE.test(text);
}

const LANGUAGE_TAG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const RULE_KEYS: Readonly<Record<PronunciationDictionaryRule["type"], ReadonlySet<string>>> = {
  alias: new Set(["type", "from", "to", "caseSensitive", "scope"]),
  phoneme: new Set(["type", "from", "phoneme", "alphabet", "alias", "caseSensitive", "scope"]),
};
const DICTIONARY_KEYS: ReadonlySet<string> = new Set(["version", "id", "name", "enabled", "language", "rules"]);

/** Loose BCP-47 shape check: a 2-8 letter primary subtag and alphanumeric subtags. */
export function isLanguageTag(value: string): boolean {
  return LANGUAGE_TAG.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string, message: string): never {
  throw new PronunciationDictionaryError(`${path}: ${message}`);
}

function readString(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== "string") fail(path, "must be a string.");
  const trimmed = value.trim();
  if (!trimmed) fail(path, "must not be empty.");
  if (trimmed.length > maxLength) fail(path, `must be at most ${maxLength} characters.`);
  if (hasForbiddenCharacters(trimmed)) fail(path, "contains control characters.");
  return trimmed;
}

function readOptionalString(value: unknown, path: string, maxLength: number): string | undefined {
  return value === undefined ? undefined : readString(value, path, maxLength);
}

function readUnknownKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown !== undefined) fail(path, `has an unknown field "${unknown}".`);
}

function readRuleOptions(record: Record<string, unknown>, path: string): RuleOptions {
  const options: RuleOptions = {};
  if (record.caseSensitive !== undefined) {
    if (typeof record.caseSensitive !== "boolean") fail(`${path}.caseSensitive`, "must be true or false.");
    options.caseSensitive = record.caseSensitive;
  }
  if (record.scope !== undefined) {
    if (record.scope !== "word" && record.scope !== "anywhere") fail(`${path}.scope`, 'must be "word" or "anywhere".');
    options.scope = record.scope;
  }
  return options;
}

function readRule(value: unknown, path: string): PronunciationDictionaryRule {
  if (!isRecord(value)) fail(path, "must be an object.");
  const type = value.type;
  if (type !== "alias" && type !== "phoneme") fail(`${path}.type`, 'must be "alias" or "phoneme".');
  readUnknownKeys(value, RULE_KEYS[type], path);
  const from = readString(value.from, `${path}.from`, MAX_FROM_LENGTH);
  const options = readRuleOptions(value, path);
  if (type === "alias") {
    return { type, from, to: readString(value.to, `${path}.to`, MAX_TO_LENGTH), ...options };
  }
  if (value.alphabet !== "ipa") fail(`${path}.alphabet`, 'must be "ipa".');
  const phoneme = readString(value.phoneme, `${path}.phoneme`, MAX_PHONEME_LENGTH);
  const alias = readOptionalString(value.alias, `${path}.alias`, MAX_TO_LENGTH);
  return { type, from, phoneme, alphabet: "ipa", ...(alias === undefined ? {} : { alias }), ...options };
}

/** Checks an untrusted value and returns a normalized copy (strings trimmed). Throws `PronunciationDictionaryError`. */
export function validatePronunciationDictionary(value: unknown, path = "dictionary"): PronunciationDictionary {
  if (!isRecord(value)) fail(path, "must be an object.");
  readUnknownKeys(value, DICTIONARY_KEYS, path);
  if (value.version !== PRONUNCIATION_DICTIONARY_VERSION) {
    fail(`${path}.version`, `must be ${PRONUNCIATION_DICTIONARY_VERSION}.`);
  }
  const id = readString(value.id, `${path}.id`, MAX_ID_LENGTH);
  const name = readString(value.name, `${path}.name`, MAX_NAME_LENGTH);
  if (typeof value.enabled !== "boolean") fail(`${path}.enabled`, "must be true or false.");
  const language = readOptionalString(value.language, `${path}.language`, MAX_LANGUAGE_LENGTH);
  if (language !== undefined && !isLanguageTag(language)) fail(`${path}.language`, "must be a BCP-47 language tag.");
  if (!Array.isArray(value.rules)) fail(`${path}.rules`, "must be an array.");
  if (value.rules.length > MAX_DICTIONARY_RULES) {
    fail(`${path}.rules`, `must have at most ${MAX_DICTIONARY_RULES} rules.`);
  }
  return {
    version: PRONUNCIATION_DICTIONARY_VERSION,
    id,
    name,
    enabled: value.enabled,
    ...(language === undefined ? {} : { language }),
    rules: value.rules.map((rule, index) => readRule(rule, `${path}.rules[${index}]`)),
  };
}

function createId(): string {
  return `dict-${globalThis.crypto.randomUUID()}`;
}

export interface CreateDictionaryInput {
  name: string;
  rules?: PronunciationDictionaryRule[];
  enabled?: boolean;
  language?: string;
  id?: string;
}

/** Builds and validates a new dictionary; a missing id is generated. */
export function createPronunciationDictionary(input: CreateDictionaryInput): PronunciationDictionary {
  return validatePronunciationDictionary({
    version: PRONUNCIATION_DICTIONARY_VERSION,
    id: input.id ?? createId(),
    name: input.name,
    enabled: input.enabled ?? true,
    ...(input.language === undefined ? {} : { language: input.language }),
    rules: input.rules ?? [],
  });
}

/**
 * Converts the legacy single lexicon (version 1 `from=to` rules) into a v2
 * dictionary of alias rules with the automatic case policy, which is how the
 * lexicon has always matched. Empty rules are dropped.
 */
export function dictionaryFromLegacyRules(
  rules: readonly PronunciationRule[],
  options: { name?: string; id?: string } = {},
): PronunciationDictionary {
  return createPronunciationDictionary({
    name: options.name ?? "Quick rules",
    id: options.id,
    rules: rules
      .map((rule) => ({ type: "alias" as const, from: rule.from.trim(), to: rule.to.trim() }))
      .filter((rule) => rule.from && rule.to),
  });
}

/** Serializes dictionaries as the native JSON exchange file. */
export function serializePronunciationDictionaries(dictionaries: readonly PronunciationDictionary[]): string {
  return `${JSON.stringify({
    format: PRONUNCIATION_DICTIONARY_FORMAT,
    version: PRONUNCIATION_DICTIONARY_VERSION,
    dictionaries: dictionaries.map((dictionary, index) => validatePronunciationDictionary(dictionary, `dictionaries[${index}]`)),
  }, null, 2)}\n`;
}

/**
 * Parses a JSON dictionary file: the native exchange file, a single
 * dictionary object, or a legacy array of `{from, to}` rules. Throws
 * `PronunciationDictionaryError` with the offending path.
 */
export function parsePronunciationDictionaryJson(text: string): PronunciationDictionary[] {
  if (text.length > MAX_DICTIONARY_FILE_CHARS) {
    throw new PronunciationDictionaryError("The dictionary file is too large.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PronunciationDictionaryError("The file is not valid JSON.");
  }

  if (Array.isArray(parsed)) {
    if (parsed.length > MAX_DICTIONARY_RULES) fail("rules", `must have at most ${MAX_DICTIONARY_RULES} rules.`);
    const rules = parsed.map((rule, index) => {
      const path = `rules[${index}]`;
      if (!isRecord(rule)) fail(path, "must be an object.");
      readUnknownKeys(rule, new Set(["from", "to"]), path);
      return {
        from: readString(rule.from, `${path}.from`, MAX_FROM_LENGTH),
        to: readString(rule.to, `${path}.to`, MAX_TO_LENGTH),
      };
    });
    return [dictionaryFromLegacyRules(rules, { name: "Imported rules" })];
  }
  if (isRecord(parsed) && parsed.format === PRONUNCIATION_DICTIONARY_FORMAT) {
    readUnknownKeys(parsed, new Set(["format", "version", "dictionaries"]), "file");
    if (parsed.version !== PRONUNCIATION_DICTIONARY_VERSION) {
      fail("file.version", `must be ${PRONUNCIATION_DICTIONARY_VERSION}.`);
    }
    if (!Array.isArray(parsed.dictionaries)) fail("file.dictionaries", "must be an array.");
    if (parsed.dictionaries.length > MAX_DICTIONARIES_PER_FILE) {
      fail("file.dictionaries", `must have at most ${MAX_DICTIONARIES_PER_FILE} dictionaries.`);
    }
    return parsed.dictionaries.map((dictionary, index) => validatePronunciationDictionary(dictionary, `dictionaries[${index}]`));
  }
  return [validatePronunciationDictionary(parsed)];
}

function primaryLanguage(language: string | undefined): string | undefined {
  return language?.split(/[-_]/)[0].toLowerCase() || undefined;
}

export interface FlattenDictionariesOptions {
  /** Generation language; dictionaries tagged with another language are skipped. */
  language?: string;
}

export interface FlattenedPronunciationRules {
  /** Rules for `compilePronunciationMatcher` / `applyPronunciationRules`, earlier dictionaries first. */
  rules: PronunciationMatchRule[];
  /** Phoneme rules for engines that accept IPA input. */
  phonemeRules: PronunciationPhonemeRule[];
  /** Phoneme rules without an alias, which text-only engines cannot speak. */
  phonemeRulesWithoutAlias: PronunciationPhonemeRule[];
}

/**
 * Flattens the enabled dictionaries that apply to `language` into matcher
 * rules. Phoneme rules contribute their alias, so text-only engines keep
 * working; when two rules share a written form, the earlier one wins.
 */
export function flattenPronunciationDictionaries(
  dictionaries: readonly PronunciationDictionary[],
  options: FlattenDictionariesOptions = {},
): FlattenedPronunciationRules {
  const language = primaryLanguage(options.language);
  const result: FlattenedPronunciationRules = { rules: [], phonemeRules: [], phonemeRulesWithoutAlias: [] };
  for (const dictionary of dictionaries) {
    if (!dictionary.enabled) continue;
    const dictionaryLanguage = primaryLanguage(dictionary.language);
    if (language !== undefined && dictionaryLanguage !== undefined && dictionaryLanguage !== language) continue;
    for (const rule of dictionary.rules) {
      const options = {
        ...(rule.caseSensitive === undefined ? {} : { caseSensitive: rule.caseSensitive }),
        ...(rule.scope === undefined ? {} : { scope: rule.scope }),
      };
      if (rule.type === "alias") {
        result.rules.push({ from: rule.from, to: rule.to, ...options });
        continue;
      }
      result.phonemeRules.push(rule);
      if (rule.alias === undefined) {
        result.phonemeRulesWithoutAlias.push(rule);
      } else {
        result.rules.push({ from: rule.from, to: rule.alias, ...options });
      }
    }
  }
  return result;
}
