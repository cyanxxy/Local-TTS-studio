import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioSegment } from "../../hooks/useAudioPlayer";
import {
  offsetAtTime,
  paragraphStarts,
  sentenceStarts,
  stepBoundary,
  timeAtOffset,
} from "./readerNavigation";
import { estimateSegmentWords } from "./readerSegments";
import { splitTextBlocks } from "./readerTextLayout";

function startsOf(text: string, language?: string): string[] {
  return sentenceStarts(text, splitTextBlocks(text), language).map((offset) => text.slice(offset, offset + 6));
}

function segment(overrides: Partial<AudioSegment>): AudioSegment {
  return { id: "s", text: "", startSec: 0, endSec: 1, index: 1, total: 1, ...overrides };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sentenceStarts", () => {
  it("starts a sentence at each paragraph and after each full stop", () => {
    expect(startsOf("# Heading\nOne here. Two there!  Three?\n\nLast line")).toEqual([
      "# Head",
      "One he",
      "Two th",
      "Three?",
      "Last l",
    ]);
  });

  it("does not split at common abbreviations or decimals", () => {
    expect(startsOf("Dr. Smith paid 3.5 dollars. Then he left.", "en")).toEqual(["Dr. Sm", "Then h"]);
    expect(startsOf("Written by J. R. R. Tolkien in 1937. He taught.", "en")).toEqual(["Writte", "He tau"]);
    expect(startsOf("It was plan b. Then we left.", "en")).toEqual(["It was", "Then w"]);
    expect(startsOf(`${"word ".repeat(10)}Undr. Next one.`, "en")).toEqual(["word w", "Next o"]);
    expect(startsOf("See No. 5 today. Then go.", "en")).toEqual(["See No", "Then g"]);
    expect(startsOf("I. M. Pei drew it. Then he left.", "en")).toEqual(["I. M. ", "Then h"]);
  });

  it("ends a sentence at a closing \"no.\" or the pronoun \"I.\"", () => {
    expect(startsOf("He said no. Then he left.", "en")).toEqual(["He sai", "Then h"]);
    expect(startsOf("So did I. Then we left.", "en")).toEqual(["So did", "Then w"]);
  });

  it("splits CJK text at its own full stops", () => {
    const text = "今日は晴れです。明日は雨です。";
    expect(sentenceStarts(text, splitTextBlocks(text), "ja")).toEqual([0, text.indexOf("明日")]);
  });

  it("falls back to an unknown language tag, and to punctuation without a segmenter", () => {
    expect(startsOf("One here. Two there.", "not a language!")).toEqual(["One he", "Two th"]);

    vi.stubGlobal("Intl", { ...Intl, Segmenter: undefined });
    expect(startsOf("One here. “Two there.” Three. 終わり。次")).toEqual(["One he", "“Two t", "Three.", "終わり。次"]);
  });

  it("returns nothing for empty text", () => {
    expect(sentenceStarts("", [])).toEqual([]);
    expect(paragraphStarts("", [])).toEqual([]);
  });
});

describe("paragraphStarts", () => {
  it("starts an indented paragraph at its first word, so stepping back from it moves on", () => {
    const text = "First paragraph.\n    Indented second.\n   \nThird.";
    const starts = paragraphStarts(text, splitTextBlocks(text));

    expect(starts).toEqual([0, text.indexOf("Indented"), text.indexOf("Third")]);
    expect(stepBoundary(starts, text.indexOf("Indented"), "previous")).toBe(0);
  });
});

describe("stepBoundary", () => {
  const boundaries = [0, 10, 20];

  it("steps forward to the next boundary, or out of the section", () => {
    expect(stepBoundary(boundaries, 0, "next")).toBe(10);
    expect(stepBoundary(boundaries, 12, "next")).toBe(20);
    expect(stepBoundary(boundaries, 20, "next")).toBeNull();
  });

  it("restarts from inside a sentence and goes back from its start", () => {
    expect(stepBoundary(boundaries, 14, "previous")).toBe(10);
    expect(stepBoundary(boundaries, 10, "previous")).toBe(0);
    expect(stepBoundary(boundaries, 0, "previous")).toBeNull();
    expect(stepBoundary([5], 2, "previous")).toBeNull();
  });
});

describe("offsetAtTime and timeAtOffset", () => {
  const first = segment({ id: "a", text: "Alpha beta gamma.", textStart: 0, textEnd: 17, startSec: 0, endSec: 3, pauseAfterSec: 0.5 });
  const second = segment({ id: "b", text: "Delta epsilon.", textStart: 18, textEnd: 32, startSec: 3, endSec: 5 });
  const words = estimateSegmentWords(first);

  it("finds the word being spoken, and the last word during the trailing pause", () => {
    expect(offsetAtTime([first, second], words[1].startSec + 0.01, null)).toBe(6);
    expect(offsetAtTime([first, second], 2.9, null)).toBe(11);
    const [delta, epsilon] = estimateSegmentWords(second);
    expect(offsetAtTime([first, second], delta.startSec, null)).toBe(18);
    expect(offsetAtTime([first, second], epsilon.startSec, null)).toBe(24);
    // Past the end of the generated audio, the last passage still answers.
    expect(offsetAtTime([first, second], 9, null)).toBe(24);
  });

  it("uses the passage start without stable timing or words", () => {
    expect(offsetAtTime([first, second], 2, "a")).toBe(0);
    expect(offsetAtTime([segment({ text: "   ", textStart: 4, textEnd: 7 })], 0.5, null)).toBe(4);
    expect(offsetAtTime([segment({ text: "No range" })], 0.5, null)).toBeNull();
    expect(offsetAtTime([], 0, null)).toBeNull();
  });

  it("only falls back to the passage start for the segment still growing", () => {
    const epsilon = estimateSegmentWords(second)[1];
    expect(offsetAtTime([first, second], epsilon.startSec, "a")).toBe(24);
    expect(offsetAtTime([first, second], epsilon.startSec, "b")).toBe(18);
    expect(timeAtOffset([first, second], 24, "a")).toBe(epsilon.startSec);
    expect(timeAtOffset([first, second], 24, "b")).toBe(3);
  });

  it("times a word by its estimate, or the next word from a space", () => {
    expect(timeAtOffset([first, second], 8, null)).toBe(words[1].startSec);
    expect(timeAtOffset([first, second], 5, null)).toBe(words[1].startSec);
    expect(timeAtOffset([first, second], 8, "a")).toBe(0);
    expect(timeAtOffset([first, second], 17, null)).toBe(3);
    expect(timeAtOffset([segment({ startSec: 2, text: "x" })], 0, null)).toBeNull();
    expect(timeAtOffset([], 3, null)).toBeNull();
  });
});
