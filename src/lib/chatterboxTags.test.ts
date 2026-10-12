import { describe, expect, it } from "vitest";
import {
  CHATTERBOX_TAG_TOKENS,
  normalizeChatterboxPunctuation,
  normalizeChatterboxTagName,
  parseChatterboxTags,
  renderChatterboxText,
} from "./chatterboxTags";

describe("normalizeChatterboxTagName", () => {
  it("maps every native token name to itself", () => {
    for (const token of CHATTERBOX_TAG_TOKENS) {
      expect(normalizeChatterboxTagName(token.slice(1, -1))).toBe(token);
    }
  });

  it("is case-insensitive and treats spaces, hyphens and underscores alike", () => {
    expect(normalizeChatterboxTagName("Laughs")).toBe("[laugh]");
    expect(normalizeChatterboxTagName("  CLEARS_throat ")).toBe("[clear throat]");
    expect(normalizeChatterboxTagName("clear-throat")).toBe("[clear throat]");
    expect(normalizeChatterboxTagName("whisper")).toBe("[whispering]");
  });

  it("returns null for directions the tokenizer does not know", () => {
    expect(normalizeChatterboxTagName("pause 2s")).toBeNull();
    expect(normalizeChatterboxTagName("")).toBeNull();
    expect(normalizeChatterboxTagName("constructor")).toBeNull();
  });
});

describe("parseChatterboxTags", () => {
  it("splits text into prose and tag spans", () => {
    expect(parseChatterboxTags("Hi [Laughs] there [nope]")).toEqual([
      { kind: "text", text: "Hi " },
      { kind: "tag", raw: "[Laughs]", token: "[laugh]" },
      { kind: "text", text: " there " },
      { kind: "tag", raw: "[nope]", token: null },
    ]);
  });

  it("leaves emphasis syntax and over-long brackets as prose", () => {
    const long = `[${"a".repeat(65)}]`;
    expect(parseChatterboxTags(`Say [[this]] and ${long}`)).toEqual([
      { kind: "text", text: `Say [[this]] and ${long}` },
    ]);
  });
});

describe("renderChatterboxText", () => {
  it("rewrites known tags to the tokenizer spelling and drops unknown ones", () => {
    const rendered = renderChatterboxText("Oh [Chuckles] really? [pause 2s] Yes.");
    expect(rendered.text).toBe("Oh [chuckle] really? Yes.");
    expect(rendered.tags).toEqual(["[chuckle]"]);
    expect(rendered.removedTags).toEqual(["[pause 2s]"]);
    expect(rendered.spokenCharacters).toBe("OhreallyYes".length);
  });

  it("counts only letters and digits outside tags as spoken", () => {
    expect(renderChatterboxText("[laugh]").spokenCharacters).toBe(0);
    expect(renderChatterboxText("[laugh] ok 42!").spokenCharacters).toBe(4);
  });

  it("runs the speech transform on prose only, never on tag spellings", () => {
    const rendered = renderChatterboxText("hello [laugh] world", (speech) => speech.toUpperCase());
    expect(rendered.text).toBe("HELLO [laugh] WORLD");
  });

  it("strips GPT-2 control tokens, including ones a transform produces", () => {
    expect(renderChatterboxText("a <|endoftext|> b").text).toBe("a b");
    expect(renderChatterboxText("a b", () => "x <|endoftext|> y").text).toBe("x y");
  });

  it("detaches punctuation from a removed tag", () => {
    expect(renderChatterboxText("Wait [beep], then go.").text).toBe("Wait, then go.");
  });
});

describe("normalizeChatterboxPunctuation", () => {
  it("capitalizes, replaces typographic punctuation and ends the sentence", () => {
    expect(normalizeChatterboxPunctuation("it’s “fine”")).toBe("It's \"fine\".");
    expect(normalizeChatterboxPunctuation("wait…what: yes")).toBe("Wait, what, yes.");
  });

  it("keeps an existing sentence ender and collapses whitespace", () => {
    expect(normalizeChatterboxPunctuation("  Hello   there!  ")).toBe("Hello there!");
  });

  it("returns an empty string for blank input", () => {
    expect(normalizeChatterboxPunctuation("   ")).toBe("");
  });
});
