import { describe, expect, it } from "vitest";
import { encodeSpeechBreakMark, findSpeechBreakMarks, stripSpeechBreakMarks } from "./speechBreakMarks";

describe("speech break marks", () => {
  it("round-trips pause lengths in hundredths of a second", () => {
    const text = `One${encodeSpeechBreakMark(1.5)}Two${encodeSpeechBreakMark(0.25)}`;
    expect(findSpeechBreakMarks(text)).toEqual([
      { index: 3, seconds: 1.5 },
      { index: 7, seconds: 0.25 },
    ]);
  });

  it("clamps pauses to zero through ten seconds", () => {
    expect(findSpeechBreakMarks(encodeSpeechBreakMark(-4))[0].seconds).toBe(0);
    expect(findSpeechBreakMarks(encodeSpeechBreakMark(99))[0].seconds).toBe(10);
  });

  it("removes every mark and leaves other text alone", () => {
    const text = `a${encodeSpeechBreakMark(2)}bé`;
    expect(stripSpeechBreakMarks(text)).toBe("abé");
    expect(findSpeechBreakMarks("plain")).toEqual([]);
  });
});
