import { describe, expect, it } from "vitest";
import { PronunciationDictionaryError, createPronunciationDictionary } from "../pronunciation/dictionary";
import {
  appendRules,
  dictionariesJson,
  dictionaryFileName,
  dictionaryPls,
  mergeImportedDictionaries,
  parseBulkRules,
  readDictionaryFile,
} from "./dictionaryFiles";

const brand = createPronunciationDictionary({
  id: "brand",
  name: "Brand",
  language: "en",
  rules: [
    { type: "alias", from: "GIF", to: "jif" },
    { type: "phoneme", from: "Nguyen", phoneme: "wɪn", alphabet: "ipa", alias: "win" },
  ],
});

describe("readDictionaryFile", () => {
  it("reads the native JSON exchange file", () => {
    const { dictionaries, warnings } = readDictionaryFile("my.json", dictionariesJson([brand]));
    expect(dictionaries).toEqual([brand]);
    expect(warnings).toEqual([]);
  });

  it("reads a W3C PLS lexicon and names the dictionary after the file", () => {
    const { dictionaries } = readDictionaryFile("C:\\lexicons\\Brand names.pls", dictionaryPls(brand));
    expect(dictionaries).toHaveLength(1);
    expect(dictionaries[0].name).toBe("Brand names");
    expect(dictionaries[0].rules).toEqual([
      { type: "alias", from: "GIF", to: "jif" },
      { type: "phoneme", from: "Nguyen", phoneme: "wɪn", alphabet: "ipa", alias: "win" },
    ]);
    expect(readDictionaryFile("", dictionaryPls(brand)).dictionaries[0].name).toBe("Imported lexicon");
  });

  it("explains a file that is neither", () => {
    expect(() => readDictionaryFile("x.json", "{nope")).toThrow(PronunciationDictionaryError);
    expect(() => readDictionaryFile("x.pls", "<lexicon")).toThrow(/well-formed/);
  });
});

describe("mergeImportedDictionaries", () => {
  it("appends dictionaries and re-ids the ones whose id is taken", () => {
    const merged = mergeImportedDictionaries([brand], [brand, createPronunciationDictionary({ id: "other", name: "Other" })]);
    expect(merged.map((dictionary) => dictionary.name)).toEqual(["Brand", "Brand", "Other"]);
    expect(new Set(merged.map((dictionary) => dictionary.id)).size).toBe(3);
    expect(merged[1].rules).toEqual(brand.rules);
    expect(merged[2].id).toBe("other");
  });

  it("refuses to go past the dictionary limit", () => {
    const many = Array.from({ length: 50 }, (_, index) => createPronunciationDictionary({ name: `D${index}` }));
    expect(() => mergeImportedDictionaries(many, [brand])).toThrow(/room for 50/);
  });
});

describe("parseBulkRules", () => {
  it("makes alias rules from pasted lines and reports the rest", () => {
    const { rules, skipped } = parseBulkRules("route=root\nNASA => nassa\n# note\nnot a rule");
    expect(rules).toEqual([
      { type: "alias", from: "route", to: "root", caseSensitive: false },
      { type: "alias", from: "NASA", to: "nassa", caseSensitive: true },
    ]);
    expect(skipped).toEqual(["not a rule"]);
  });
});

describe("appendRules", () => {
  it("adds validated rules", () => {
    const next = appendRules(brand, [{ type: "alias", from: "SQL", to: "sequel" }]);
    expect(next.rules).toHaveLength(3);
    expect(next.id).toBe("brand");
  });

  it("refuses more than a dictionary can hold", () => {
    const rule = { type: "alias" as const, from: "a", to: "b" };
    const full = { ...brand, rules: Array.from({ length: 5000 }, () => rule) };
    expect(() => appendRules(full, [rule])).toThrow(/at most 5000/);
  });
});

describe("dictionaryFileName", () => {
  it("keeps names safe on every platform", () => {
    expect(dictionaryFileName("Brand names", "pls")).toBe("Brand-names.pls");
    expect(dictionaryFileName('a/b:c*"?', "json")).toBe("a-b-c.json");
    expect(dictionaryFileName("///", "json")).toBe("pronunciation.json");
  });
});
