/**
 * Moving pronunciation dictionaries in and out of the app: reading a JSON or
 * W3C PLS file the user picked, merging it with the dictionaries they have,
 * and turning pasted `word=replacement` lines into rules.
 */
import { analyzePronunciationLexicon } from "../appState";
import {
  MAX_DICTIONARIES_PER_FILE,
  MAX_DICTIONARY_RULES,
  PronunciationDictionaryError,
  createPronunciationDictionary,
  parsePronunciationDictionaryJson,
  serializePronunciationDictionaries,
  validatePronunciationDictionary,
  type PronunciationAliasRule,
  type PronunciationDictionary,
} from "../pronunciation/dictionary";
import { parsePls, serializePls } from "../pronunciation/pls";
import { isAcronymRule } from "../textTuning";

export interface ImportedDictionaries {
  dictionaries: PronunciationDictionary[];
  /** Entries that were skipped or adjusted. */
  warnings: string[];
}

function baseName(fileName: string): string {
  const name = fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "").trim();
  return name || "Imported lexicon";
}

/**
 * Reads a dictionary file by its content: PLS when it looks like XML,
 * otherwise JSON. Throws `PronunciationDictionaryError` with a message the
 * user can act on.
 */
export function readDictionaryFile(fileName: string, text: string): ImportedDictionaries {
  if (text.trimStart().startsWith("<")) {
    const { dictionary, warnings } = parsePls(text, { name: baseName(fileName) });
    return { dictionaries: [dictionary], warnings };
  }
  return { dictionaries: parsePronunciationDictionaryJson(text), warnings: [] };
}

/** Gives every imported dictionary an id none of `existing` uses, so an import never replaces one. */
export function mergeImportedDictionaries(
  existing: readonly PronunciationDictionary[],
  imported: readonly PronunciationDictionary[],
): PronunciationDictionary[] {
  const taken = new Set(existing.map((dictionary) => dictionary.id));
  const merged = [...existing];
  for (const dictionary of imported) {
    if (merged.length >= MAX_DICTIONARIES_PER_FILE) {
      throw new PronunciationDictionaryError(`There is room for ${MAX_DICTIONARIES_PER_FILE} dictionaries.`);
    }
    const fresh = taken.has(dictionary.id)
      ? createPronunciationDictionary({ ...dictionary, id: undefined })
      : dictionary;
    taken.add(fresh.id);
    merged.push(fresh);
  }
  return merged;
}

export interface BulkRules {
  rules: PronunciationAliasRule[];
  /** Lines that were not `word=replacement`, as written. */
  skipped: string[];
}

/** Alias rules from pasted lines (`word=replacement`, `=>` and `->` also work; `#` starts a comment). */
export function parseBulkRules(text: string): BulkRules {
  const { rules, issues } = analyzePronunciationLexicon(text);
  return {
    rules: rules.map((rule) => ({
      type: "alias" as const,
      from: rule.from,
      to: rule.to,
      caseSensitive: isAcronymRule(rule.from),
    })),
    skipped: issues.map((issue) => issue.value),
  };
}

/** The dictionary with `rules` appended, or an error when it would hold too many. */
export function appendRules(
  dictionary: PronunciationDictionary,
  rules: PronunciationDictionary["rules"],
): PronunciationDictionary {
  if (dictionary.rules.length + rules.length > MAX_DICTIONARY_RULES) {
    throw new PronunciationDictionaryError(`A dictionary holds at most ${MAX_DICTIONARY_RULES} rules.`);
  }
  return validatePronunciationDictionary({ ...dictionary, rules: [...dictionary.rules, ...rules] });
}

export function dictionariesJson(dictionaries: readonly PronunciationDictionary[]): string {
  return serializePronunciationDictionaries(dictionaries);
}

export function dictionaryPls(dictionary: PronunciationDictionary): string {
  return serializePls(dictionary);
}

/** A file name for an exported dictionary, safe on every platform. */
export function dictionaryFileName(name: string, extension: "json" | "pls"): string {
  const safe = name.normalize("NFKC").replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ").replace(/\s+/g, "-").trim().slice(0, 60);
  return `${safe.replace(/^-+|-+$/g, "") || "pronunciation"}.${extension}`;
}
