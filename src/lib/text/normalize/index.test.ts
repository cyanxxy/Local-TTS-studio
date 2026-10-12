import { describe, expect, it } from "vitest";
import {
  ALL_SPEECH_NORMALIZATION_RULES,
  isSpeechNormalizationSupported,
  normalizeForSpeech,
} from "./index";

const SAMPLE = "On 3/4/2024 at 7pm, Dr. Smith paid $3.50 for 2 kg (50% off).";

describe("normalizeForSpeech", () => {
  it("defaults to English with every rule", () => {
    const result = normalizeForSpeech(SAMPLE);
    expect(result.text).toBe(
      "On March fourth, twenty twenty-four at seven PM, Doctor Smith paid three dollars and fifty cents for two kilograms (fifty percent off).",
    );
    expect(result.source).toBe(SAMPLE);
    expect(new Set(result.edits.map((edit) => edit.reason))).toEqual(
      new Set(["dates", "times", "abbreviations", "currency", "units", "percentages"]),
    );
  });

  it.each(["", "  ", "en", "EN", "en-US", "en_us"])("treats %j as US English", (language) => {
    expect(normalizeForSpeech("3/4/2024", { language }).text).toBe("March fourth, twenty twenty-four");
  });

  it.each(["en-GB", "en-gb", "en-Latn-GB", "en-AU", "en-IE", "en-NZ", "en-IN", "en-ZA"])(
    "reads numeric dates day first for %s",
    (language) => {
      expect(normalizeForSpeech("3/4/2024", { language }).text).toBe("the third of April, twenty twenty-four");
    },
  );

  it("ignores unknown region subtags", () => {
    expect(normalizeForSpeech("3/4/2024", { language: "en-001" }).text).toBe("March fourth, twenty twenty-four");
  });

  it.each(["de", "de-DE", "ja", "fr-CA"])("passes %s through unchanged", (language) => {
    const result = normalizeForSpeech(SAMPLE, { language });
    expect(result.text).toBe(SAMPLE);
    expect(result.edits).toEqual([]);
    expect(result.toSourceOffset(5)).toBe(5);
  });

  it("applies only the requested rules", () => {
    expect(normalizeForSpeech(SAMPLE, { rules: ["abbreviations", "currency"] }).text).toBe(
      "On 3/4/2024 at 7pm, Doctor Smith paid three dollars and fifty cents for 2 kg (50% off).",
    );
  });

  it("returns an identity rewrite for an empty rule list", () => {
    const result = normalizeForSpeech(SAMPLE, { rules: [] });
    expect(result.text).toBe(SAMPLE);
    expect(result.edits).toEqual([]);
  });

  it("maps output offsets back to the source", () => {
    const text = "Pay $3.50 now.";
    const result = normalizeForSpeech(text);
    const start = result.text.indexOf("three");
    const end = start + "three dollars and fifty cents".length;
    expect(result.toSourceRange({ start, end })).toEqual({ start: 4, end: 9 });
    expect(result.toOutputOffset(text.indexOf("now"))).toBe(result.text.indexOf("now"));
  });

  it("normalizes 100 KB of mixed prose quickly", () => {
    const paragraph = [
      "In 1990, Dr. Smith ran 5 km in 23:15 and paid $3.50 (12.5% less) on 2024-03-15.",
      "Chapter IV covers Henry VIII, the 1990s, 21st-century tools, etc. Visit https://example.com/docs or",
      "mail jane.doe@example.com before March 3, 2024 at 10:30 a.m. Versions like v1.2.3 and",
      "COVID-19 stay; 1,234,567 people read -5 and 3-5 pages. Plain words fill the rest of the line.",
    ].join(" ");
    const text = `${paragraph} `.repeat(Math.ceil(100_000 / (paragraph.length + 1)));
    const started = performance.now();
    const result = normalizeForSpeech(text);
    const elapsed = performance.now() - started;
    expect(text.length).toBeGreaterThanOrEqual(100_000);
    expect(result.edits.length).toBeGreaterThan(1000);
    expect(elapsed).toBeLessThan(200);
  });
});

describe("isSpeechNormalizationSupported", () => {
  it.each([undefined, "", "en", "en-GB", "EN-us"])("supports %j", (language) => {
    expect(isSpeechNormalizationSupported(language)).toBe(true);
  });

  it.each(["de", "ja-JP", "zh"])("does not support %s", (language) => {
    expect(isSpeechNormalizationSupported(language)).toBe(false);
  });
});

describe("ALL_SPEECH_NORMALIZATION_RULES", () => {
  it("lists every rule once and is frozen", () => {
    expect(new Set(ALL_SPEECH_NORMALIZATION_RULES).size).toBe(13);
    expect(Object.isFrozen(ALL_SPEECH_NORMALIZATION_RULES)).toBe(true);
  });
});
