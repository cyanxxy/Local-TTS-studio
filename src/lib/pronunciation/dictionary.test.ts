import { describe, expect, it } from "vitest";
import { compilePronunciationMatcher } from "../textTuning";
import {
  MAX_DICTIONARIES_PER_FILE,
  MAX_DICTIONARY_FILE_CHARS,
  MAX_DICTIONARY_RULES,
  PRONUNCIATION_DICTIONARY_FORMAT,
  PronunciationDictionaryError,
  createPronunciationDictionary,
  dictionaryFromLegacyRules,
  flattenPronunciationDictionaries,
  isLanguageTag,
  parsePronunciationDictionaryJson,
  serializePronunciationDictionaries,
  validatePronunciationDictionary,
  type PronunciationDictionary,
} from "./dictionary";

function dictionary(overrides: Partial<PronunciationDictionary> = {}): PronunciationDictionary {
  return {
    version: 2,
    id: "d1",
    name: "Brand names",
    enabled: true,
    rules: [{ type: "alias", from: "GIF", to: "jif" }],
    ...overrides,
  };
}

describe("validatePronunciationDictionary", () => {
  it("accepts alias and phoneme rules and trims strings", () => {
    const result = validatePronunciationDictionary({
      version: 2,
      id: " d1 ",
      name: " Brands ",
      enabled: false,
      language: "en-US",
      rules: [
        { type: "alias", from: " US ", to: " United States ", caseSensitive: true, scope: "word" },
        { type: "phoneme", from: "tomato", phoneme: "təˈmeɪtoʊ", alphabet: "ipa", alias: "tuh-may-toe", scope: "anywhere" },
        { type: "phoneme", from: "Nguyen", phoneme: "wɪn", alphabet: "ipa", caseSensitive: false },
      ],
    });
    expect(result).toEqual({
      version: 2,
      id: "d1",
      name: "Brands",
      enabled: false,
      language: "en-US",
      rules: [
        { type: "alias", from: "US", to: "United States", caseSensitive: true, scope: "word" },
        { type: "phoneme", from: "tomato", phoneme: "təˈmeɪtoʊ", alphabet: "ipa", alias: "tuh-may-toe", scope: "anywhere" },
        { type: "phoneme", from: "Nguyen", phoneme: "wɪn", alphabet: "ipa", caseSensitive: false },
      ],
    });
  });

  it.each([
    [null, "dictionary: must be an object."],
    [[], "dictionary: must be an object."],
    [{ ...dictionary(), extra: 1 }, 'dictionary: has an unknown field "extra".'],
    [{ ...dictionary(), version: 1 }, "dictionary.version: must be 2."],
    [{ ...dictionary(), id: 7 }, "dictionary.id: must be a string."],
    [{ ...dictionary(), name: "   " }, "dictionary.name: must not be empty."],
    [{ ...dictionary(), name: "x".repeat(121) }, "dictionary.name: must be at most 120 characters."],
    [{ ...dictionary(), name: "bad\u0000name" }, "dictionary.name: contains control characters."],
    [{ ...dictionary(), name: "bad\u0085name" }, "dictionary.name: contains control characters."],
    [{ ...dictionary(), name: "bad\uD800name" }, "dictionary.name: contains control characters."],
    [{ ...dictionary(), enabled: "yes" }, "dictionary.enabled: must be true or false."],
    [{ ...dictionary(), language: "english please" }, "dictionary.language: must be a BCP-47 language tag."],
    [{ ...dictionary(), rules: {} }, "dictionary.rules: must be an array."],
    [{ ...dictionary(), rules: ["GIF=jif"] }, "dictionary.rules[0]: must be an object."],
    [{ ...dictionary(), rules: [{ type: "regex", from: "a", to: "b" }] }, 'dictionary.rules[0].type: must be "alias" or "phoneme".'],
    [{ ...dictionary(), rules: [{ type: "alias", from: "a", to: "b", phoneme: "x" }] }, 'dictionary.rules[0]: has an unknown field "phoneme".'],
    [{ ...dictionary(), rules: [{ type: "alias", from: "a", to: "" }] }, "dictionary.rules[0].to: must not be empty."],
    [{ ...dictionary(), rules: [{ type: "alias", from: "a", to: "b", caseSensitive: 1 }] }, "dictionary.rules[0].caseSensitive: must be true or false."],
    [{ ...dictionary(), rules: [{ type: "alias", from: "a", to: "b", scope: "line" }] }, 'dictionary.rules[0].scope: must be "word" or "anywhere".'],
    [{ ...dictionary(), rules: [{ type: "phoneme", from: "a", phoneme: "b", alphabet: "x-sampa" }] }, 'dictionary.rules[0].alphabet: must be "ipa".'],
    [{ ...dictionary(), rules: [{ type: "phoneme", from: "a", phoneme: "b", alphabet: "ipa", alias: 3 }] }, "dictionary.rules[0].alias: must be a string."],
  ])("rejects %j", (value, message) => {
    expect(() => validatePronunciationDictionary(value)).toThrow(new PronunciationDictionaryError(message));
  });

  it("limits the number of rules", () => {
    const rules = Array.from({ length: MAX_DICTIONARY_RULES + 1 }, (_, index) => ({ type: "alias", from: `w${index}`, to: "x" }));
    expect(() => validatePronunciationDictionary({ ...dictionary(), rules })).toThrow(/at most 5000 rules/);
  });

  it("allows tabs and line breaks inside strings", () => {
    expect(validatePronunciationDictionary(dictionary({ name: "Two\twords\nhere" })).name).toBe("Two\twords\nhere");
  });
});

describe("createPronunciationDictionary and dictionaryFromLegacyRules", () => {
  it("fills defaults and generates an id", () => {
    const created = createPronunciationDictionary({ name: "New" });
    expect(created).toMatchObject({ version: 2, name: "New", enabled: true, rules: [] });
    expect(created.id).toMatch(/^dict-[0-9a-f-]{36}$/);
    expect(created).not.toHaveProperty("language");
    expect(createPronunciationDictionary({ name: "Fr", id: "fr", language: "fr", enabled: false })).toMatchObject({
      id: "fr",
      language: "fr",
      enabled: false,
    });
  });

  it("migrates the legacy lexicon into a Quick rules dictionary", () => {
    const migrated = dictionaryFromLegacyRules([
      { from: " GIF ", to: " jif " },
      { from: "", to: "ignored" },
      { from: "route", to: " " },
    ], { id: "quick" });
    expect(migrated).toEqual({
      version: 2,
      id: "quick",
      name: "Quick rules",
      enabled: true,
      rules: [{ type: "alias", from: "GIF", to: "jif", caseSensitive: true }],
    });
    expect(dictionaryFromLegacyRules([])).toMatchObject({ name: "Quick rules", rules: [] });
  });

  it("keeps stored rules matching case-insensitively unless they are all-caps acronyms", () => {
    const legacy = [
      { from: "Kokoro", to: "koh-koh-roh" },
      { from: "Open TTS", to: "open tee tee ess" },
      { from: "route", to: "root" },
      { from: "I", to: "eye" },
      { from: "US", to: "United States" },
    ];
    const migrated = dictionaryFromLegacyRules(legacy);
    expect(migrated.rules.map((rule) => [rule.from, rule.caseSensitive])).toEqual([
      ["Kokoro", false], ["Open TTS", false], ["route", false], ["I", false], ["US", true],
    ]);
    const text = "KOKORO and kokoro, open tts, ROUTE, us and US, i";
    expect(compilePronunciationMatcher(flattenPronunciationDictionaries([migrated]).rules).apply(text))
      .toBe("koh-koh-roh and koh-koh-roh, open tee tee ess, root, us and United States, eye");
  });
});

describe("JSON exchange", () => {
  it("round-trips dictionaries through the native file", () => {
    const dictionaries = [
      dictionary(),
      dictionary({
        id: "d2",
        name: "Names",
        language: "en-GB",
        rules: [{ type: "phoneme", from: "Siobhan", phoneme: "ʃɪˈvɔːn", alphabet: "ipa", alias: "shi-vawn", caseSensitive: true }],
      }),
    ];
    const json = serializePronunciationDictionaries(dictionaries);
    expect(JSON.parse(json)).toMatchObject({ format: PRONUNCIATION_DICTIONARY_FORMAT, version: 2 });
    expect(json.endsWith("\n")).toBe(true);
    expect(parsePronunciationDictionaryJson(json)).toEqual(dictionaries);
  });

  it("refuses to serialize an invalid dictionary", () => {
    expect(() => serializePronunciationDictionaries([dictionary({ name: "" })])).toThrow("dictionaries[0].name: must not be empty.");
  });

  it("reads a single dictionary object", () => {
    expect(parsePronunciationDictionaryJson(JSON.stringify(dictionary()))).toEqual([dictionary()]);
  });

  it("reads a legacy array of from/to rules", () => {
    const [imported] = parsePronunciationDictionaryJson('[{"from":"SQL","to":"sequel"}]');
    expect(imported).toMatchObject({ name: "Imported rules", enabled: true, rules: [{ type: "alias", from: "SQL", to: "sequel" }] });
  });

  it.each([
    ["{", "The file is not valid JSON."],
    ["[1]", "rules[0]: must be an object."],
    ['[{"from":"a","to":"b","x":1}]', 'rules[0]: has an unknown field "x".'],
    ['[{"from":"a"}]', "rules[0].to: must be a string."],
    [`{"format":"${PRONUNCIATION_DICTIONARY_FORMAT}","version":1,"dictionaries":[]}`, "file.version: must be 2."],
    [`{"format":"${PRONUNCIATION_DICTIONARY_FORMAT}","version":2}`, "file.dictionaries: must be an array."],
    [`{"format":"${PRONUNCIATION_DICTIONARY_FORMAT}","version":2,"dictionaries":[],"x":1}`, 'file: has an unknown field "x".'],
    [`{"format":"${PRONUNCIATION_DICTIONARY_FORMAT}","version":2,"dictionaries":[{}]}`, "dictionaries[0].version: must be 2."],
    ['"text"', "dictionary: must be an object."],
  ])("rejects %s", (text, message) => {
    expect(() => parsePronunciationDictionaryJson(text)).toThrow(message);
  });

  it("enforces file, dictionary-count and legacy rule-count limits", () => {
    expect(() => parsePronunciationDictionaryJson(" ".repeat(MAX_DICTIONARY_FILE_CHARS + 1))).toThrow(/too large/);
    const many = JSON.stringify({
      format: PRONUNCIATION_DICTIONARY_FORMAT,
      version: 2,
      dictionaries: Array.from({ length: MAX_DICTIONARIES_PER_FILE + 1 }, () => dictionary()),
    });
    expect(() => parsePronunciationDictionaryJson(many)).toThrow(/at most 50 dictionaries/);
    const legacy = JSON.stringify(Array.from({ length: MAX_DICTIONARY_RULES + 1 }, () => ({ from: "a", to: "b" })));
    expect(() => parsePronunciationDictionaryJson(legacy)).toThrow(/at most 5000 rules/);
  });
});

describe("flattenPronunciationDictionaries", () => {
  const brands = dictionary({
    rules: [
      { type: "alias", from: "US", to: "United States", caseSensitive: true },
      { type: "phoneme", from: "tomato", phoneme: "təˈmeɪtoʊ", alphabet: "ipa", alias: "tuh-may-toe", scope: "anywhere" },
      { type: "phoneme", from: "Nguyen", phoneme: "wɪn", alphabet: "ipa" },
    ],
  });

  it("returns matcher rules with options, phoneme rules and aliasless phoneme rules", () => {
    const flattened = flattenPronunciationDictionaries([brands]);
    expect(flattened.rules).toEqual([
      { from: "US", to: "United States", caseSensitive: true },
      { from: "tomato", to: "tuh-may-toe", scope: "anywhere" },
    ]);
    expect(flattened.phonemeRules.map((rule) => rule.from)).toEqual(["tomato", "Nguyen"]);
    expect(flattened.phonemeRulesWithoutAlias.map((rule) => rule.from)).toEqual(["Nguyen"]);
  });

  it("skips disabled dictionaries and other languages, keeping untagged ones", () => {
    const french = dictionary({ id: "fr", language: "fr-FR", rules: [{ type: "alias", from: "SNCF", to: "ess enn say eff" }] });
    const english = dictionary({ id: "en", language: "en", rules: [{ type: "alias", from: "SQL", to: "sequel" }] });
    const off = dictionary({ id: "off", enabled: false, rules: [{ type: "alias", from: "AI", to: "ay eye" }] });
    const untagged = dictionary({ id: "all", rules: [{ type: "alias", from: "GIF", to: "jif" }] });
    const froms = (language?: string) => (
      flattenPronunciationDictionaries([french, english, off, untagged], { language }).rules.map((rule) => rule.from)
    );
    expect(froms("en-US")).toEqual(["SQL", "GIF"]);
    expect(froms("fr")).toEqual(["SNCF", "GIF"]);
    expect(froms()).toEqual(["SNCF", "SQL", "GIF"]);
    expect(froms("")).toEqual(["SNCF", "SQL", "GIF"]);
  });

  it("lets the earlier dictionary win when two rules share a written form", () => {
    const first = dictionary({ id: "a", rules: [{ type: "alias", from: "GIF", to: "jif" }] });
    const second = dictionary({ id: "b", rules: [{ type: "alias", from: "GIF", to: "gift" }] });
    const matcher = compilePronunciationMatcher(flattenPronunciationDictionaries([first, second]).rules);
    expect(matcher.apply("A GIF")).toBe("A jif");
  });
});

describe("isLanguageTag", () => {
  it.each(["en", "en-US", "zh-Hant-TW", "yue"])("accepts %s", (tag) => {
    expect(isLanguageTag(tag)).toBe(true);
  });

  it.each(["", "e", "en_US", "en-", "english language"])("rejects %j", (tag) => {
    expect(isLanguageTag(tag)).toBe(false);
  });
});
