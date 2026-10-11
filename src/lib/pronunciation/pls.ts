/**
 * W3C Pronunciation Lexicon Specification (PLS 1.0) import and export.
 *
 * Supported: `<lexeme>` entries with one or more `<grapheme>`s and an
 * `<alias>` and/or a `<phoneme>` in the IPA alphabet (lexicon-wide or per
 * phoneme). The first alias and the first IPA phoneme of a lexeme are used,
 * as PLS ranks them by order. Phonemes in other alphabets (X-SAMPA, ARPAbet)
 * are skipped with a warning unless the lexeme also has an alias.
 *
 * Case and scope options have no PLS equivalent: they are not exported, and
 * imported rules use the automatic case policy and whole-word scope.
 *
 * Parsing needs `DOMParser` (renderer only). Documents with a DOCTYPE are
 * rejected so entity declarations can never expand or reach outside the file.
 */
import {
  MAX_DICTIONARY_RULES,
  PronunciationDictionaryError,
  createPronunciationDictionary,
  isLanguageTag,
  type PronunciationDictionary,
  type PronunciationDictionaryRule,
} from "./dictionary";

export const PLS_NAMESPACE = "http://www.w3.org/2005/01/pronunciation-lexicon";
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
/** Largest PLS file accepted, in UTF-16 units. */
export const MAX_PLS_FILE_CHARS = 4 * 1024 * 1024;
const DOCTYPE = /<!DOCTYPE/i;

export interface PlsImportResult {
  dictionary: PronunciationDictionary;
  /** Entries that were skipped or adjusted, for display to the user. */
  warnings: string[];
}

export interface PlsImportOptions {
  /** Dictionary name; defaults to "Imported lexicon". */
  name?: string;
  id?: string;
}

function collapseWhitespace(text: string | null): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function childElements(parent: Element, localName: string): Element[] {
  return Array.from(parent.children).filter((child) => child.localName === localName);
}

function isIpa(alphabet: string | null | undefined): boolean {
  return alphabet?.trim().toLowerCase() === "ipa";
}

function parseXml(xml: string): Document {
  if (typeof DOMParser === "undefined") {
    throw new PronunciationDictionaryError("PLS files can only be read where DOMParser is available.");
  }
  const document = new DOMParser().parseFromString(xml, "application/xml");
  if (document.getElementsByTagName("parsererror").length > 0) {
    throw new PronunciationDictionaryError("The PLS file is not well-formed XML.");
  }
  return document;
}

/**
 * Reads a PLS document into a dictionary of alias and IPA phoneme rules.
 * Throws `PronunciationDictionaryError` when the file is not a usable lexicon.
 */
export function parsePls(xml: string, options: PlsImportOptions = {}): PlsImportResult {
  if (xml.length > MAX_PLS_FILE_CHARS) throw new PronunciationDictionaryError("The PLS file is too large.");
  if (DOCTYPE.test(xml)) throw new PronunciationDictionaryError("PLS files with a DOCTYPE are not supported.");

  const root = parseXml(xml).documentElement;
  if (root.localName !== "lexicon") {
    throw new PronunciationDictionaryError("The file is not a PLS lexicon (expected a <lexicon> root element).");
  }
  const warnings: string[] = [];
  if (root.namespaceURI !== PLS_NAMESPACE) {
    warnings.push("The lexicon does not use the PLS namespace; reading it anyway.");
  }

  const lexiconAlphabet = root.getAttribute("alphabet");
  const rawLanguage = root.getAttributeNS(XML_NAMESPACE, "lang") ?? root.getAttribute("xml:lang");
  const language = collapseWhitespace(rawLanguage) || undefined;
  const rules: PronunciationDictionaryRule[] = [];

  childElements(root, "lexeme").forEach((lexeme, index) => {
    const label = `Entry ${index + 1}`;
    const graphemes = childElements(lexeme, "grapheme").map((element) => collapseWhitespace(element.textContent)).filter(Boolean);
    if (graphemes.length === 0) {
      warnings.push(`${label} has no grapheme and was skipped.`);
      return;
    }
    const alias = childElements(lexeme, "alias").map((element) => collapseWhitespace(element.textContent)).find(Boolean);
    const phonemes = childElements(lexeme, "phoneme")
      .map((element) => ({
        text: collapseWhitespace(element.textContent),
        ipa: isIpa(element.getAttribute("alphabet") ?? lexiconAlphabet),
      }))
      .filter((phoneme) => phoneme.text);
    const phoneme = phonemes.find((candidate) => candidate.ipa)?.text;

    let toRule: ((from: string) => PronunciationDictionaryRule) | undefined;
    if (phoneme !== undefined) {
      toRule = (from) => ({ type: "phoneme", from, phoneme, alphabet: "ipa", ...(alias === undefined ? {} : { alias }) });
    } else if (alias !== undefined) {
      toRule = (from) => ({ type: "alias", from, to: alias });
    }
    if (!toRule) {
      warnings.push(phonemes.length > 0
        ? `${label} (${graphemes[0]}) only has phonemes in an alphabet other than IPA and was skipped.`
        : `${label} (${graphemes[0]}) has no alias or phoneme and was skipped.`);
      return;
    }
    rules.push(...graphemes.map(toRule));
  });

  if (rules.length > MAX_DICTIONARY_RULES) {
    throw new PronunciationDictionaryError(`The lexicon has more than ${MAX_DICTIONARY_RULES} entries.`);
  }
  let dictionaryLanguage = language;
  if (language !== undefined && !isLanguageTag(language)) {
    warnings.push(`Ignored the invalid language tag "${language}".`);
    dictionaryLanguage = undefined;
  }
  return {
    dictionary: createPronunciationDictionary({
      name: options.name ?? "Imported lexicon",
      id: options.id,
      language: dictionaryLanguage,
      rules,
    }),
    warnings,
  };
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Writes a dictionary as a PLS 1.0 document with alphabet="ipa". */
export function serializePls(dictionary: PronunciationDictionary): string {
  const lexemes = dictionary.rules.map((rule) => {
    const lines = [`    <grapheme>${escapeXml(rule.from)}</grapheme>`];
    if (rule.type === "phoneme") lines.push(`    <phoneme>${escapeXml(rule.phoneme)}</phoneme>`);
    const alias = rule.type === "alias" ? rule.to : rule.alias;
    if (alias !== undefined) lines.push(`    <alias>${escapeXml(alias)}</alias>`);
    return `  <lexeme>\n${lines.join("\n")}\n  </lexeme>\n`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    `<lexicon version="1.0" xmlns="${PLS_NAMESPACE}" alphabet="ipa" xml:lang="${escapeXml(dictionary.language ?? "en")}">\n`,
    ...lexemes,
    "</lexicon>\n",
  ].join("");
}
