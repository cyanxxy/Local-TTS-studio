import { describe, expect, it } from "vitest";
import type { ReaderChapter, ReaderSection } from "../../lib/readerDocument";
import { chapterStepLabel, contentsButtonLabel, formatVoiceName } from "./readerLabels";

const chapters: ReaderChapter[] = [
  { id: "one", title: "Opening", order: 0, start: 0, end: 100, level: 1 },
  { id: "two", title: "Ending", order: 1, start: 100, end: 200, level: 1 },
];

function section(chapterId: string): ReaderSection {
  return {
    id: `${chapterId}:section-1`,
    chapterId,
    order: 0,
    chapterSectionIndex: 0,
    chapterSectionCount: 1,
    start: 0,
    end: 100,
  };
}

describe("formatVoiceName", () => {
  it("turns voice ids into display names", () => {
    expect(formatVoiceName("af_heart")).toBe("Heart");
    expect(formatVoiceName("am_santa_claus")).toBe("Santa claus");
    expect(formatVoiceName("M1")).toBe("M1");
  });
});

describe("chapterStepLabel", () => {
  it("says whether a page turn stays in the chapter or crosses into another", () => {
    expect(chapterStepLabel(null, true, "one", chapters)).toBe("Next page");
    expect(chapterStepLabel(section("one"), false, "one", chapters)).toBe("Previous part of this chapter");
    expect(chapterStepLabel(section("two"), true, "one", chapters)).toBe("Next chapter: Ending");
    expect(chapterStepLabel(section("missing"), true, "one", chapters)).toBe("Next chapter");
  });
});

describe("contentsButtonLabel", () => {
  it("names the chapter and part for listeners who cannot see the rail", () => {
    expect(contentsButtonLabel(null, 0, 0, 1)).toBe("Contents");
    expect(contentsButtonLabel(chapters[1], 2, 0, 1)).toBe("Contents · Chapter 2 of 2: Ending");
    expect(contentsButtonLabel(chapters[0], 2, 1, 3)).toBe("Contents · Chapter 1 of 2: Opening, part 2 of 3");
  });
});
