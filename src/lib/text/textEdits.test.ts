import { describe, expect, it } from "vitest";
import { applyTextEdits, chainTextRewrites } from "./textEdits";

describe("applyTextEdits", () => {
  it("returns an identity rewrite without edits", () => {
    const result = applyTextEdits("Hello world", []);
    expect(result.text).toBe("Hello world");
    expect(result.edits).toEqual([]);
    expect(result.toSourceOffset(5)).toBe(5);
    expect(result.toOutputOffset(5)).toBe(5);
    expect(result.toSourceRange({ start: 0, end: 5 })).toEqual({ start: 0, end: 5 });
  });

  it("applies edits in source order regardless of input order", () => {
    const result = applyTextEdits("a 1 b 22 c", [
      { start: 6, end: 8, replacement: "twenty-two", reason: "numbers" },
      { start: 2, end: 3, replacement: "one", reason: "numbers" },
    ]);
    expect(result.text).toBe("a one b twenty-two c");
    expect(result.edits.map((edit) => [edit.start, edit.end, edit.outputStart, edit.outputEnd])).toEqual([
      [2, 3, 2, 5],
      [6, 8, 8, 18],
    ]);
    expect(result.edits[0].reason).toBe("numbers");
  });

  it("drops edits that change nothing", () => {
    const result = applyTextEdits("keep", [{ start: 0, end: 4, replacement: "keep" }]);
    expect(result.text).toBe("keep");
    expect(result.edits).toEqual([]);
  });

  it("supports deletions, insertions and adjacent edits", () => {
    const result = applyTextEdits("ab[1]cd", [
      { start: 2, end: 5, replacement: "" },
      { start: 5, end: 6, replacement: "C" },
      { start: 7, end: 7, replacement: "!" },
    ]);
    expect(result.text).toBe("abCd!");
    // Output "C" (offset 2) comes from source "c" at 5; the deletion leaves no output.
    expect(result.toSourceOffset(2)).toBe(5);
    expect(result.toSourceOffset(3)).toBe(6);
    // The inserted "!" maps to the insertion point.
    expect(result.toSourceOffset(4)).toBe(7);
    expect(result.toSourceOffset(5)).toBe(7);
    expect(result.toOutputOffset(3)).toBe(2);
    expect(result.toOutputOffset(7)).toBe(5);
  });

  it("orders an insertion before a replacement that starts at the same offset", () => {
    const result = applyTextEdits("one two", [
      { start: 4, end: 7, replacement: "2" },
      { start: 4, end: 4, replacement: "[" },
    ]);
    expect(result.text).toBe("one [2");
  });

  it("maps offsets inside a replacement to its source start", () => {
    const result = applyTextEdits("Pay $5 now", [{ start: 4, end: 6, replacement: "five dollars" }]);
    expect(result.text).toBe("Pay five dollars now");
    expect(result.toSourceOffset(4)).toBe(4);
    expect(result.toSourceOffset(9)).toBe(4);
    expect(result.toSourceOffset(16)).toBe(6);
    expect(result.toSourceOffset(17)).toBe(7);
    expect(result.toOutputOffset(5)).toBe(4);
    expect(result.toOutputOffset(6)).toBe(16);
  });

  it("widens output ranges that touch part of a replacement to the whole source", () => {
    const result = applyTextEdits("Pay $5 now", [{ start: 4, end: 6, replacement: "five dollars" }]);
    expect(result.toSourceRange({ start: 9, end: 12 })).toEqual({ start: 4, end: 6 });
    expect(result.toSourceRange({ start: 0, end: 9 })).toEqual({ start: 0, end: 6 });
    expect(result.toSourceRange({ start: 4, end: 16 })).toEqual({ start: 4, end: 6 });
    expect(result.toSourceRange({ start: 17, end: 20 })).toEqual({ start: 7, end: 10 });
    // A reversed range collapses at its start.
    expect(result.toSourceRange({ start: 17, end: 2 })).toEqual({ start: 7, end: 7 });
  });

  it("clamps out-of-range and non-finite offsets", () => {
    const result = applyTextEdits("abc", [{ start: 1, end: 2, replacement: "BB" }]);
    expect(result.toSourceOffset(-4)).toBe(0);
    expect(result.toSourceOffset(99)).toBe(3);
    expect(result.toSourceOffset(Number.POSITIVE_INFINITY)).toBe(3);
    expect(result.toSourceOffset(Number.NaN)).toBe(0);
    expect(result.toOutputOffset(2.7)).toBe(3);
    expect(result.toOutputOffset(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it.each([
    [{ start: -1, end: 1, replacement: "" }],
    [{ start: 2, end: 1, replacement: "" }],
    [{ start: 0, end: 9, replacement: "" }],
    [{ start: 0.5, end: 1, replacement: "" }],
    [{ start: 0, end: Number.NaN, replacement: "" }],
  ])("rejects the invalid range %j", (edit) => {
    expect(() => applyTextEdits("abc", [edit])).toThrow(RangeError);
  });

  it("rejects overlapping edits", () => {
    expect(() => applyTextEdits("abcdef", [
      { start: 0, end: 3, replacement: "x" },
      { start: 2, end: 4, replacement: "y" },
    ])).toThrow(/Overlapping/);
  });
});

describe("chainTextRewrites", () => {
  it("composes two rewrites into one source-to-output map", () => {
    const source = "Dr. Who paid $5.";
    const first = applyTextEdits(source, [{ start: 0, end: 3, replacement: "Doctor" }]);
    const dollar = first.text.indexOf("$5");
    const second = applyTextEdits(first.text, [{ start: dollar, end: dollar + 2, replacement: "five dollars" }]);
    const chained = chainTextRewrites(first, second);

    expect(chained.source).toBe(source);
    expect(chained.text).toBe("Doctor Who paid five dollars.");
    const five = chained.text.indexOf("five");
    expect(chained.toSourceOffset(five + 2)).toBe(source.indexOf("$5"));
    expect(chained.toSourceRange({ start: five, end: five + 4 })).toEqual({
      start: source.indexOf("$5"),
      end: source.indexOf("$5") + 2,
    });
    expect(chained.toOutputOffset(source.indexOf("Who"))).toBe(chained.text.indexOf("Who"));
  });

  it("rejects rewrites that do not chain", () => {
    const first = applyTextEdits("abc", []);
    const second = applyTextEdits("xyz", []);
    expect(() => chainTextRewrites(first, second)).toThrow(/first rewrite's output/);
  });
});
