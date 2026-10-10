import { describe, expect, it } from "vitest";
import {
  buildOverlayParts,
  chapterHeadingBlockStart,
  clamp,
  groupPartsByBlock,
  splitTextBlocks,
} from "./readerTextLayout";

describe("splitTextBlocks", () => {
  it("records one block per non-empty line with its source offsets", () => {
    const text = "First line.\nSecond line.\n\n\nAfter a gap.";
    const blocks = splitTextBlocks(text);

    expect(blocks.map((block) => text.slice(block.start, block.end))).toEqual([
      "First line.",
      "Second line.",
      "After a gap.",
    ]);
    expect(blocks.map((block) => block.blankLineBefore)).toEqual([false, false, true]);
  });

  it("returns no blocks for empty or newline-only text", () => {
    expect(splitTextBlocks("")).toEqual([]);
    expect(splitTextBlocks("\n\n")).toEqual([]);
  });
});

describe("buildOverlayParts", () => {
  it("returns nothing for empty text", () => {
    expect(buildOverlayParts("", [], null)).toEqual([]);
  });

  it("splits only at block edges and the spoken range", () => {
    const text = "One two.\nThree four.";
    const blocks = splitTextBlocks(text);
    const parts = buildOverlayParts(text, blocks, { start: 4, end: 13 });

    expect(parts.map((part) => [part.text, part.isActive])).toEqual([
      ["One ", false],
      ["two.", true],
      ["\n", true],
      ["Thre", true],
      ["e four.", false],
    ]);
    expect(parts.map((part) => part.text).join("")).toBe(text);
  });

  it("leaves every span inactive while nothing is spoken", () => {
    const text = "One.\nTwo.";
    const parts = buildOverlayParts(text, splitTextBlocks(text), null);

    expect(parts.map((part) => part.text)).toEqual(["One.", "\n", "Two."]);
    expect(parts.every((part) => !part.isActive)).toBe(true);
  });

  it("clamps a spoken range that runs past the section", () => {
    const text = "Short text.";
    const parts = buildOverlayParts(text, splitTextBlocks(text), { start: -5, end: 400 });

    expect(parts).toEqual([{ text, start: 0, isActive: true }]);
  });
});

describe("groupPartsByBlock", () => {
  it("drops newline separators and keeps every glyph in its paragraph", () => {
    const text = "Alpha.\n\nBeta gamma.";
    const blocks = splitTextBlocks(text);
    const groups = groupPartsByBlock(blocks, buildOverlayParts(text, blocks, { start: 8, end: 12 }));

    expect(groups.map((group) => group.parts.map((part) => part.text))).toEqual([
      ["Alpha."],
      ["Beta", " gamma."],
    ]);
  });

  it("ignores a trailing newline after the last paragraph", () => {
    const text = "Alpha.\n";
    const blocks = splitTextBlocks(text);
    const groups = groupPartsByBlock(blocks, buildOverlayParts(text, blocks, null));

    expect(groups).toEqual([{ block: blocks[0], parts: [{ text: "Alpha.", start: 0, isActive: false }] }]);
  });
});

describe("chapterHeadingBlockStart", () => {
  it("draws a first line that repeats the chapter title as the heading", () => {
    const text = "## the opening\nBody.";
    const [first] = splitTextBlocks(text);

    expect(chapterHeadingBlockStart(text, first, "The Opening")).toBe(0);
  });

  it("keeps an unrelated first line, or no line at all, as body text", () => {
    const text = "Once upon a time.";
    const [first] = splitTextBlocks(text);

    expect(chapterHeadingBlockStart(text, first, "Opening")).toBeNull();
    expect(chapterHeadingBlockStart("", undefined, "Opening")).toBeNull();
    expect(chapterHeadingBlockStart("Café", splitTextBlocks("Café")[0], "Cafe")).toBeNull();
  });
});

describe("clamp", () => {
  it("bounds a value on both sides", () => {
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
    expect(clamp(5, 0, 10)).toBe(5);
  });
});
