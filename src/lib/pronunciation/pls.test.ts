import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_DICTIONARY_RULES, PronunciationDictionaryError, type PronunciationDictionary } from "./dictionary";
import { MAX_PLS_FILE_CHARS, PLS_NAMESPACE, parsePls, serializePls } from "./pls";

function lexicon(body: string, attributes = `alphabet="ipa" xml:lang="en-US"`): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<lexicon version="1.0" xmlns="${PLS_NAMESPACE}" ${attributes}>
${body}
</lexicon>`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parsePls", () => {
  it("reads alias and IPA phoneme lexemes", () => {
    const { dictionary, warnings } = parsePls(lexicon(`
  <lexeme>
    <grapheme>tomato</grapheme>
    <phoneme>təˈmeɪtoʊ</phoneme>
  </lexeme>
  <lexeme>
    <grapheme>UN</grapheme>
    <grapheme>U.N.</grapheme>
    <alias>United   Nations</alias>
  </lexeme>
  <lexeme>
    <grapheme>Nguyen</grapheme>
    <phoneme alphabet="x-sampa">w_IN</phoneme>
    <phoneme>wɪn</phoneme>
    <alias>win</alias>
    <alias>ignored</alias>
  </lexeme>`), { id: "pls", name: "Brands" });

    expect(warnings).toEqual([]);
    expect(dictionary).toEqual({
      version: 2,
      id: "pls",
      name: "Brands",
      enabled: true,
      language: "en-US",
      rules: [
        { type: "phoneme", from: "tomato", phoneme: "təˈmeɪtoʊ", alphabet: "ipa" },
        { type: "alias", from: "UN", to: "United Nations" },
        { type: "alias", from: "U.N.", to: "United Nations" },
        { type: "phoneme", from: "Nguyen", phoneme: "wɪn", alphabet: "ipa", alias: "win" },
      ],
    });
  });

  it("uses a per-phoneme IPA alphabet over the lexicon alphabet", () => {
    const { dictionary } = parsePls(lexicon(`
  <lexeme><grapheme>data</grapheme><phoneme alphabet="ipa">ˈdeɪtə</phoneme></lexeme>`, 'alphabet="x-sampa" xml:lang="en"'));
    expect(dictionary.rules).toEqual([{ type: "phoneme", from: "data", phoneme: "ˈdeɪtə", alphabet: "ipa" }]);
  });

  it("skips unusable lexemes with warnings", () => {
    const { dictionary, warnings } = parsePls(lexicon(`
  <lexeme><alias>orphan</alias></lexeme>
  <lexeme><grapheme>  </grapheme><alias>blank</alias></lexeme>
  <lexeme><grapheme>either</grapheme><phoneme>"aI.D@r</phoneme></lexeme>
  <lexeme><grapheme>empty</grapheme><alias> </alias></lexeme>
  <lexeme><grapheme>ok</grapheme><alias>okay</alias></lexeme>`, 'alphabet="x-sampa" xml:lang="en"'));
    expect(dictionary.rules).toEqual([{ type: "alias", from: "ok", to: "okay" }]);
    expect(warnings).toEqual([
      "Entry 1 has no grapheme and was skipped.",
      "Entry 2 has no grapheme and was skipped.",
      "Entry 3 (either) only has phonemes in an alphabet other than IPA and was skipped.",
      "Entry 4 (empty) has no alias or phoneme and was skipped.",
    ]);
  });

  it("reads a lexicon outside the PLS namespace and without a language", () => {
    const { dictionary, warnings } = parsePls('<lexicon version="1.0"><lexeme><grapheme>a</grapheme><alias>b</alias></lexeme></lexicon>');
    expect(dictionary).toMatchObject({ name: "Imported lexicon", rules: [{ type: "alias", from: "a", to: "b" }] });
    expect(dictionary).not.toHaveProperty("language");
    expect(warnings).toEqual(["The lexicon does not use the PLS namespace; reading it anyway."]);
  });

  it("drops an invalid language tag", () => {
    const { dictionary, warnings } = parsePls(lexicon("", 'alphabet="ipa" xml:lang="not a tag"'));
    expect(dictionary).not.toHaveProperty("language");
    expect(warnings).toEqual(['Ignored the invalid language tag "not a tag".']);
  });

  it.each([
    ["<lexicon><lexeme>", "The PLS file is not well-formed XML."],
    ['<?xml version="1.0"?><dictionary/>', "The file is not a PLS lexicon (expected a <lexicon> root element)."],
    ['<!DOCTYPE lexicon [<!ENTITY a "aaaa">]><lexicon>&a;</lexicon>', "PLS files with a DOCTYPE are not supported."],
  ])("rejects %s", (xml, message) => {
    expect(() => parsePls(xml)).toThrow(new PronunciationDictionaryError(message));
  });

  it("rejects oversized files and lexicons", () => {
    expect(() => parsePls(" ".repeat(MAX_PLS_FILE_CHARS + 1))).toThrow(/too large/);
    const lexemes = Array.from({ length: MAX_DICTIONARY_RULES + 1 }, (_, index) => (
      `<lexeme><grapheme>w${index}</grapheme><alias>x</alias></lexeme>`
    )).join("");
    expect(() => parsePls(lexicon(lexemes))).toThrow(/more than 5000 entries/);
  });

  it("rejects a single lexeme with more graphemes than the rule limit", () => {
    const graphemes = "<grapheme>a</grapheme>".repeat(MAX_DICTIONARY_RULES + 1000);
    expect(() => parsePls(lexicon(`<lexeme>${graphemes}<alias>x</alias></lexeme>`)))
      .toThrow(new PronunciationDictionaryError(`The lexicon has more than ${MAX_DICTIONARY_RULES} entries.`));
  });

  it("validates imported strings like any dictionary", () => {
    expect(() => parsePls(lexicon(`<lexeme><grapheme>${"x".repeat(201)}</grapheme><alias>y</alias></lexeme>`)))
      .toThrow(/at most 200 characters/);
  });

  it("explains when DOMParser is unavailable", () => {
    vi.stubGlobal("DOMParser", undefined);
    expect(() => parsePls(lexicon(""))).toThrow(/DOMParser/);
  });
});

describe("serializePls", () => {
  const source: PronunciationDictionary = {
    version: 2,
    id: "d1",
    name: "Mixed",
    enabled: true,
    language: "en-GB",
    rules: [
      { type: "alias", from: "AT&T", to: "A T and T" },
      { type: "phoneme", from: "<tomato>", phoneme: "təˈmɑːtəʊ", alphabet: "ipa" },
      { type: "phoneme", from: "Siobhan", phoneme: "ʃɪˈvɔːn", alphabet: "ipa", alias: "shi-'vawn\"" },
    ],
  };

  it("writes escaped PLS 1.0 with alphabet ipa", () => {
    const xml = serializePls(source);
    expect(xml).toContain(`<lexicon version="1.0" xmlns="${PLS_NAMESPACE}" alphabet="ipa" xml:lang="en-GB">`);
    expect(xml).toContain("<grapheme>AT&amp;T</grapheme>");
    expect(xml).toContain("<grapheme>&lt;tomato&gt;</grapheme>");
    expect(xml).toContain("<alias>shi-&apos;vawn&quot;</alias>");
  });

  it("round-trips through parsePls", () => {
    const { dictionary, warnings } = parsePls(serializePls(source), { id: "d1", name: "Mixed" });
    expect(warnings).toEqual([]);
    expect(dictionary).toEqual(source);
  });

  it("defaults the language to English and drops case and scope options", () => {
    const xml = serializePls({
      version: 2,
      id: "d",
      name: "n",
      enabled: true,
      rules: [{ type: "alias", from: "US", to: "United States", caseSensitive: true, scope: "anywhere" }],
    });
    expect(xml).toContain('xml:lang="en"');
    expect(parsePls(xml).dictionary.rules).toEqual([{ type: "alias", from: "US", to: "United States" }]);
  });
});
