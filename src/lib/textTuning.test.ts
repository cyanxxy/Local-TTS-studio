import { describe, expect, it } from "vitest";
import {
  applyEmphasisMarkup,
  applyPronunciationRules,
  compilePronunciationMatcher,
  isAcronymRule,
  resolveChunkPauseSeconds,
  resolvePauseSeconds,
  resolveSentenceSpeed,
  stripEmphasisMarkup,
  tuneChunkText,
} from "./textTuning";

describe("textTuning", () => {
  it("applies pronunciation rules longest-first with word boundaries", () => {
    expect(applyPronunciationRules("OpenAI makes AI tools.", [
      { from: "AI", to: "ay eye" },
      { from: "OpenAI", to: "open ay eye" },
      { from: "", to: "ignored" },
      { from: "tools", to: "" },
    ])).toBe("open ay eye makes ay eye tools.");

    expect(applyPronunciationRules("C++ and C+ are tokens.", [
      { from: "C++", to: "see plus plus" },
      { from: "C+", to: "see plus" },
    ])).toContain("see plus plus");
  });

  it("treats replacement dollar tokens as literal pronunciation text", () => {
    expect(applyPronunciationRules("Say GIF then GIF.", [
      { from: "GIF", to: "$& literally $1" },
    ])).toBe("Say $& literally $1 then $& literally $1.");
  });

  it("does not let the replacement of one rule feed another", () => {
    expect(applyPronunciationRules("NASA and A", [
      { from: "NASA", to: "A nasa" },
      { from: "A", to: "ay" },
    ])).toBe("A nasa and ay");
    expect(applyPronunciationRules("cat", [
      { from: "cat", to: "dog" },
      { from: "dog", to: "wolf" },
    ])).toBe("dog");
  });

  it("keeps acronym rules from rewriting ordinary lowercase words", () => {
    const rules = [{ from: "US", to: "United States" }, { from: "IT", to: "I T" }];
    expect(applyPronunciationRules("Tell us about the US economy.", rules)).toBe(
      "Tell us about the United States economy.",
    );
    expect(applyPronunciationRules("Is it IT or it?", rules)).toBe("Is it I T or it?");
  });

  it("matches all-lowercase rules case-insensitively", () => {
    expect(applyPronunciationRules("Route one, route two, ROUTE three.", [{ from: "route", to: "root" }])).toBe(
      "root one, root two, root three.",
    );
  });

  it("keeps matching stored rules with capitals case-insensitively unless they are acronyms", () => {
    expect(applyPronunciationRules("KOKORO, kokoro and Kokoro", [{ from: "Kokoro", to: "koh-koh-roh" }])).toBe(
      "koh-koh-roh, koh-koh-roh and koh-koh-roh",
    );
    expect(applyPronunciationRules("open tts", [{ from: "Open TTS", to: "open tee tee ess" }])).toBe("open tee tee ess");
  });

  it("treats only all-caps text with two or more capitals as an acronym", () => {
    for (const acronym of ["US", "NASA", " TTS ", "U.S.", "A4B"]) expect(isAcronymRule(acronym)).toBe(true);
    for (const other of ["I", "A4", "iOS", "Kokoro", "Open TTS", "route", "", "42"]) expect(isAcronymRule(other)).toBe(false);
  });

  it("honors an explicit case option", () => {
    expect(compilePronunciationMatcher([{ from: "us", to: "you ess", caseSensitive: true }]).apply("Us and us")).toBe(
      "Us and you ess",
    );
    expect(compilePronunciationMatcher([{ from: "NaN", to: "not a number", caseSensitive: false }]).apply("nan NAN")).toBe(
      "not a number not a number",
    );
  });

  it("uses Unicode word boundaries", () => {
    const rules = [{ from: "über", to: "ueber" }];
    expect(applyPronunciationRules("Über alles, keine Überraschung.", rules)).toBe("ueber alles, keine Überraschung.");
    expect(applyPronunciationRules("café_bar café2 café.", [{ from: "café", to: "kafay" }])).toBe("café_bar café2 kafay.");
    expect(applyPronunciationRules("Москва и москвич", [{ from: "москва", to: "Moskva" }])).toBe("Moskva и москвич");
  });

  it("matches inside words in scripts written without spaces", () => {
    expect(applyPronunciationRules("東京都に行く", [{ from: "東京", to: "とうきょう" }])).toBe("とうきょう都に行く");
  });

  it("can match inside words when the rule's scope is anywhere", () => {
    const matcher = compilePronunciationMatcher([{ from: "graph", to: "graf", scope: "anywhere" }]);
    expect(matcher.apply("Photographs graph")).toBe("Photografs graf");
  });

  it("finds a case-sensitive match right after a candidate with the wrong case", () => {
    const matcher = compilePronunciationMatcher([{ from: "US", to: "U.S.", scope: "anywhere" }]);
    expect(matcher.apply("usUS")).toBe("usU.S.");
  });

  it("reports an empty matcher and maps rewrites back to the source", () => {
    expect(compilePronunciationMatcher([{ from: " ", to: "x" }]).empty).toBe(true);
    const empty = compilePronunciationMatcher([]);
    expect(empty.apply("same")).toBe("same");

    const matcher = compilePronunciationMatcher([{ from: "GIF", to: "jif" }]);
    expect(matcher.empty).toBe(false);
    const rewrite = matcher.rewrite("A GIF here");
    expect(rewrite.text).toBe("A jif here");
    expect(rewrite.edits).toEqual([
      { start: 2, end: 5, replacement: "jif", reason: "pronunciation", outputStart: 2, outputEnd: 5 },
    ]);
    expect(rewrite.toSourceOffset(rewrite.text.indexOf("here"))).toBe(6);
  });

  it("reuses the compiled matcher for the same rules array", () => {
    const rules = [{ from: "GIF", to: "jif" }];
    expect(applyPronunciationRules("GIF", rules)).toBe("jif");
    rules[0] = { from: "GIF", to: "gift" };
    // The cache is keyed by array identity; callers pass a fresh array per request.
    expect(applyPronunciationRules("GIF", rules)).toBe("jif");
    expect(applyPronunciationRules("GIF", [...rules])).toBe("gift");
  });

  it("strips emphasis markers and ignores the legacy strength", () => {
    expect(stripEmphasisMarkup("This is *key* and [[urgent]] and **bold**.")).toBe("This is key and urgent and bold.");
    expect(applyEmphasisMarkup("This is **key**.", 0.5)).toBe("This is key.");
    expect(applyEmphasisMarkup("This is *key*.", 1)).toBe("This is key.");
    expect(applyEmphasisMarkup("This is *key*.")).toBe("This is key.");
  });

  it("tunes chunk text: drops pause tags, applies rules and strips emphasis", () => {
    expect(tuneChunkText("Say *GIF* now.", [{ from: "GIF", to: "jif" }], 0.7)).toBe("Say jif now.");
    expect(tuneChunkText("Wait <break time=\"1s\"/> then [pause 2s] go.", [])).toBe("Wait then go.");
  });

  it("resolves pause overrides and clamps invalid values", () => {
    expect(resolvePauseSeconds("comma", 0.5, { comma: 0.25 })).toBe(0.25);
    expect(resolvePauseSeconds("sentence", 0.5, { sentence: Number.NaN })).toBe(0.5);
    expect(resolvePauseSeconds("paragraph", 99)).toBe(2);
    expect(resolvePauseSeconds("none", -1)).toBe(0);
  });

  it("uses an explicit break pause as written and falls back to the pause kind", () => {
    expect(resolveChunkPauseSeconds({ pauseKind: "comma", pauseAfterSec: 0.14, breakPauseSec: 3.5 }, { comma: 0.2 })).toBe(3.5);
    expect(resolveChunkPauseSeconds({ pauseKind: "none", pauseAfterSec: 0, breakPauseSec: 99 })).toBe(10);
    expect(resolveChunkPauseSeconds({ pauseKind: "comma", pauseAfterSec: 0.14, breakPauseSec: Number.NaN }, { comma: 0.2 })).toBe(0.2);
    expect(resolveChunkPauseSeconds({ pauseKind: "sentence", pauseAfterSec: 0.24 })).toBe(0.24);
  });

  it("varies sentence speed by sentence length within supported bounds", () => {
    expect(resolveSentenceSpeed(2, 0, "Any text")).toBe(1.15);
    expect(resolveSentenceSpeed(1, 0.2, "Short text")).toBe(1.15);
    expect(resolveSentenceSpeed(1, 0.2, "")).toBe(1);
    expect(resolveSentenceSpeed(1, 0.2, Array.from({ length: 24 }, (_, index) => `word${index}`).join(" "))).toBe(0.85);
    expect(resolveSentenceSpeed(1, 0.2, Array.from({ length: 15 }, (_, index) => `word${index}`).join(" "))).toBeCloseTo(1);
  });
});

describe("compilePronunciationMatcher with very large dictionaries", () => {
  it("handles tens of thousands of rules without hitting a regular expression limit", () => {
    const rules = Array.from({ length: 30000 }, (_, index) => ({ from: `word${index}x`, to: `w${index}` }));
    const matcher = compilePronunciationMatcher([...rules, { from: "GIF", to: "jif" }]);
    expect(matcher.apply("A GIF and word29999x and word7x.")).toBe("A jif and w29999 and w7.");
  });

  it("stays fast on a long script with thousands of rules", () => {
    const rules = Array.from({ length: 5000 }, (_, index) => ({ from: `term${index}`, to: `t${index}` }));
    const matcher = compilePronunciationMatcher(rules);
    const text = Array.from({ length: 4000 }, (_, index) => `plain term${index % 5000} words`).join(" ");
    const started = performance.now();
    const spoken = matcher.apply(text);
    expect(spoken.startsWith("plain t0 words plain t1 words")).toBe(true);
    // The old combined pattern took many seconds here.
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it("finds rules written in another case, including characters that change length when lowercased", () => {
    const matcher = compilePronunciationMatcher([
      { from: "Straße", to: "street" },
      { from: "ab", to: "AB", caseSensitive: true },
      { from: "x", to: "ex" },
      { from: "xy", to: "ex why" },
    ]);
    expect(matcher.apply("STRAẞE ab aB X xY")).toBe("street AB aB ex ex why");
  });

  it("sees letters outside the basic plane and stray surrogates when checking word boundaries", () => {
    const matcher = compilePronunciationMatcher([{ from: "cat", to: "kitty" }, { from: "ab", to: "AB", caseSensitive: true }]);
    // U+1D49C is a letter written as a surrogate pair; U+DC00 alone is not a letter.
    expect(matcher.apply("\u{1D49C}cat cat\u{1D49C} \udc00cat \udc00")).toBe("\u{1D49C}cat cat\u{1D49C} \udc00kitty \udc00");
    expect(matcher.apply("cat")).toBe("kitty");
    expect(matcher.apply("AB aB ab")).toBe("AB aB AB");
    expect(matcher.apply("")).toBe("");
  });

  it("tries rules that share a written form in order", () => {
    const matcher = compilePronunciationMatcher([
      { from: "US", to: "you ess" },
      { from: "us", to: "we", caseSensitive: false },
    ]);
    expect(matcher.apply("US us Us")).toBe("you ess we we");
  });
});
