import { describe, expect, it } from "vitest";
import { estimateWordRanges as estimateReaderWordRanges } from "../readerDocument";
import { estimateWordRanges } from "./wordTiming";

describe("estimateWordRanges", () => {
  it("spreads words over the span with source offsets", () => {
    const ranges = estimateWordRanges("Hi there", 10, 1, 2);
    expect(ranges.map((range) => [range.word, range.start, range.end])).toEqual([
      ["Hi", 10, 12],
      ["there", 13, 18],
    ]);
    expect(ranges[0].startSec).toBe(1);
    expect(ranges[0].endSec).toBeCloseTo(1 + 2 / 7);
    expect(ranges[1].startSec).toBe(ranges[0].endSec);
    expect(ranges[1].endSec).toBe(2);
  });

  it("gives words before a full stop or a comma extra time", () => {
    const [stop] = estimateWordRanges("ab. cd", 0, 0, 10);
    const [comma] = estimateWordRanges("ab, cd", 0, 0, 10);
    const [plain] = estimateWordRanges("ab cd", 0, 0, 10);
    expect(stop.endSec).toBeCloseTo(10 * (8 / 10));
    expect(comma.endSec).toBeCloseTo(10 * (5 / 7));
    expect(plain.endSec).toBeCloseTo(5);
    const [quoted] = estimateWordRanges("“Stop!” he said", 0, 0, 9);
    expect(quoted.endSec).toBeCloseTo(9 * (10 / 16));
  });

  it("weighs punctuation-only tokens as one letter", () => {
    const ranges = estimateWordRanges("a • b", 0, 0, 3);
    expect(ranges.map((range) => range.word)).toEqual(["a", "•", "b"]);
    expect(ranges[1].endSec - ranges[1].startSec).toBeCloseTo(1);
  });

  it("returns nothing for empty text or an empty span", () => {
    expect(estimateWordRanges("   ", 0, 0, 1)).toEqual([]);
    expect(estimateWordRanges("word", 0, 2, 2)).toEqual([]);
  });

  it("matches the Reader's estimator", () => {
    for (const text of ["One, two. Three!", "“Quoted,” she said… then left.", "数字 和 文字。", "a — b"]) {
      expect(estimateWordRanges(text, 5, 1, 4)).toEqual(estimateReaderWordRanges(text, 5, 1, 4));
    }
  });
});
