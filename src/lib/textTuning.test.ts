import { describe, expect, it } from "vitest";
import {
  applyEmphasisMarkup,
  applyPronunciationRules,
  resolvePauseSeconds,
  resolveSentenceSpeed,
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

  it("normalizes and applies emphasis markup by strength", () => {
    expect(applyEmphasisMarkup("This is *key* and [[urgent]].", 0)).toBe("This is key and urgent.");
    expect(applyEmphasisMarkup("This is **key**.", 0.5)).toBe("This is key, key.");
    expect(applyEmphasisMarkup("This is *key*.", 1)).toBe("This is key, key, key.");
    expect(applyEmphasisMarkup("Empty **  ** marker", 1)).toBe("Empty  marker");
  });

  it("combines pronunciation and emphasis tuning", () => {
    expect(tuneChunkText("Say *GIF* now.", [{ from: "GIF", to: "jif" }], 0.7)).toBe("Say jif, jif, jif now.");
  });

  it("resolves pause overrides and clamps invalid values", () => {
    expect(resolvePauseSeconds("comma", 0.5, { comma: 0.25 })).toBe(0.25);
    expect(resolvePauseSeconds("sentence", 0.5, { sentence: Number.NaN })).toBe(0.5);
    expect(resolvePauseSeconds("paragraph", 99)).toBe(2);
    expect(resolvePauseSeconds("none", -1)).toBe(0);
  });

  it("varies sentence speed by sentence length within supported bounds", () => {
    expect(resolveSentenceSpeed(2, 0, "Any text")).toBe(1.15);
    expect(resolveSentenceSpeed(1, 0.2, "Short text")).toBe(1.15);
    expect(resolveSentenceSpeed(1, 0.2, "")).toBe(1);
    expect(resolveSentenceSpeed(1, 0.2, Array.from({ length: 24 }, (_, index) => `word${index}`).join(" "))).toBe(0.85);
    expect(resolveSentenceSpeed(1, 0.2, Array.from({ length: 15 }, (_, index) => `word${index}`).join(" "))).toBeCloseTo(1);
  });
});
