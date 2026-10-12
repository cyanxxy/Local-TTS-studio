import { describe, expect, it } from "vitest";
import { findSpeechBreaks } from "../text/speechMarkup";
import { BREAK_PRESETS_SEC, formatBreakTag, insertBreakTag } from "./breakInsert";

describe("formatBreakTag", () => {
  it("writes milliseconds below a second and seconds from one up", () => {
    expect(formatBreakTag(0.3)).toBe('<break time="300ms"/>');
    expect(formatBreakTag(1)).toBe('<break time="1s"/>');
    expect(formatBreakTag(2.25)).toBe('<break time="2.25s"/>');
  });

  it("keeps the pause inside what the parser accepts", () => {
    expect(formatBreakTag(0)).toBe('<break time="100ms"/>');
    expect(formatBreakTag(Number.NaN)).toBe('<break time="100ms"/>');
    expect(formatBreakTag(99)).toBe('<break time="10s"/>');
    for (const seconds of [...BREAK_PRESETS_SEC, 0.1, 7.77, 10]) {
      const [tag] = findSpeechBreaks(formatBreakTag(seconds));
      expect(tag.seconds).toBeCloseTo(seconds, 2);
      expect(tag.invalid).toBe(false);
    }
  });
});

describe("insertBreakTag", () => {
  it("separates the tag from words on both sides", () => {
    const result = insertBreakTag("Hello world", 5, 5, 1);
    expect(result.text).toBe('Hello <break time="1s"/> world');
    expect(result.caret).toBe('Hello <break time="1s"/>'.length);
  });

  it("does not double the spaces that are already there", () => {
    expect(insertBreakTag("Hello  world", 6, 6, 0.5).text).toBe('Hello <break time="500ms"/> world');
    expect(insertBreakTag("Hello \nworld", 6, 6, 0.5).text).toBe('Hello <break time="500ms"/>\nworld');
  });

  it("works at either end of the text and replaces a selection", () => {
    expect(insertBreakTag("", 0, 0, 2)).toEqual({ text: '<break time="2s"/>', caret: 18 });
    expect(insertBreakTag("Hi", 2, 2, 2).text).toBe('Hi <break time="2s"/>');
    expect(insertBreakTag("Hi", 0, 0, 2).text).toBe('<break time="2s"/> Hi');
    expect(insertBreakTag("one two three", 8, 4, 1).text).toBe('one <break time="1s"/> three');
  });

  it("clamps a selection outside the text", () => {
    expect(insertBreakTag("Hi", -5, 99, 1).text).toBe('<break time="1s"/>');
  });
});
