import { describe, expect, it } from "vitest";
import { buildReaderSections, createReaderDocument } from "../readerDocument";
import {
  audiobookFileName,
  chapterFileName,
  estimateAudiobookSeconds,
  formatAudiobookDuration,
  planAudiobook,
  plannedSections,
  safeFileNamePart,
} from "./plan";

const text = [
  "# One\n\n" + "First chapter sentence. ".repeat(900),
  "# Two\n\n" + "Second chapter sentence. ".repeat(40),
  "# Three\n\n" + "Third chapter sentence. ".repeat(40),
].join("\n\n");
const book = createReaderDocument({ id: "book", title: "A: Long/Book?", author: "An Author", text });
const sections = buildReaderSections(book.text, book.chapters);

describe("planAudiobook", () => {
  it("groups the whole book's sections by chapter in order", () => {
    const plan = planAudiobook(book, sections, { kind: "book" });
    expect(plan.chapters.map((entry) => entry.chapter.title)).toEqual(["One", "Two", "Three"]);
    expect(plan.chapters.map((entry) => entry.number)).toEqual([1, 2, 3]);
    expect(plan.chapters[0].sections.length).toBeGreaterThan(1);
    expect(plan.sectionCount).toBe(sections.length);
    expect(plan.characters).toBeGreaterThan(0);
  });

  it("plans a single chapter", () => {
    const second = book.chapters.find((chapter) => chapter.title === "Two")!;
    const plan = planAudiobook(book, sections, { kind: "chapter", chapterId: second.id });
    expect(plan.chapters.map((entry) => entry.chapter.title)).toEqual(["Two"]);
    expect(plan.chapters[0].number).toBe(1);
  });

  it("plans nothing for a document with no text", () => {
    const blank = createReaderDocument({ id: "blank", text: "   \n\n  " });
    const plan = planAudiobook(blank, buildReaderSections(blank.text, blank.chapters), { kind: "book" });
    expect(plan.chapters).toEqual([]);
    expect(plan.sectionCount).toBe(0);
  });

  it("lists every section's text in listening order", () => {
    const plan = planAudiobook(book, sections, { kind: "book" });
    const planned = plannedSections(plan, book);
    expect(planned).toHaveLength(sections.length);
    expect(planned.map((entry) => entry.section.id)).toEqual(sections.map((section) => section.id));
    expect(planned[0].chapterIndex).toBe(0);
    expect(planned.at(-1)?.chapterIndex).toBe(2);
  });
});

describe("estimates and names", () => {
  it("estimates duration from the characters and formats it", () => {
    expect(estimateAudiobookSeconds({ characters: 14 * 3600 })).toBe(3600);
    expect(formatAudiobookDuration(8 * 3600 + 12 * 60)).toBe("8 h 12 min");
    expect(formatAudiobookDuration(42 * 60)).toBe("42 min");
    expect(formatAudiobookDuration(10)).toBe("under a minute");
  });

  it("makes file names that are safe everywhere", () => {
    expect(safeFileNamePart("A: Long/Book?")).toBe("A Long Book");
    expect(safeFileNamePart("  ..hidden.. ")).toBe("hidden");
    expect(safeFileNamePart("???", "Fallback")).toBe("Fallback");
    expect(safeFileNamePart("x".repeat(500)).length).toBeLessThanOrEqual(80);
  });

  it("numbers chapter files so they sort in order, and names the whole file after the book", () => {
    const plan = planAudiobook(book, sections, { kind: "book" });
    expect(chapterFileName(plan, 0)).toBe("01 - One.mp3");
    expect(chapterFileName(plan, 2, "flac")).toBe("03 - Three.flac");
    expect(audiobookFileName(plan, "mp3")).toBe("A Long Book.mp3");
    const chapterPlan = planAudiobook(book, sections, { kind: "chapter", chapterId: plan.chapters[1].chapter.id });
    expect(audiobookFileName(chapterPlan, "zip")).toBe("A Long Book - Two.zip");
  });
});
