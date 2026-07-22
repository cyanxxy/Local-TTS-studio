import { describe, expect, it } from "vitest";
import {
  buildAudioSignature,
  buildReaderSections,
  calculateReaderProgress,
  chapterAtOffset,
  createReaderDocument,
  estimateWordRanges,
  normalizeReaderDocumentRecord,
  normalizeReaderTextFragment,
  rebaseReaderChapters,
  rebaseReaderTextOffset,
  READER_SECTION_MAX_CHARS,
  readerSectionAtOffset,
  structureTextChapters,
} from "./readerDocument";

describe("readerDocument", () => {
  it("structures markdown and chapter-style headings with stable offsets", () => {
    const text = "Preface text.\n\n# First Chapter\nThe first body.\n\nCHAPTER TWO\nThe second body.";
    const chapters = structureTextChapters(text, "A book");
    expect(chapters.map((chapter) => chapter.title)).toEqual([
      "Introduction",
      "First Chapter",
      "CHAPTER TWO",
    ]);
    expect(text.slice(chapters[1].start, chapters[1].end)).toContain("The first body.");
    expect(text.slice(chapters[2].start, chapters[2].end)).toContain("The second body.");
  });

  it("creates a complete document record with progress and annotations", () => {
    const document = createReaderDocument({
      id: "doc-1",
      title: "Local Reading",
      author: "Open TTS",
      sourceType: "url",
      sourceUrl: "https://example.com/story",
      text: "Chapter One\n\nA useful opening paragraph.",
      now: 123,
    });
    expect(document).toMatchObject({
      id: "doc-1",
      title: "Local Reading",
      author: "Open TTS",
      sourceType: "url",
      createdAt: 123,
      progress: { percent: 0, positionSec: 0 },
      bookmarks: [],
      notes: [],
    });
    expect(document.chapters).toHaveLength(1);
  });

  it("estimates weighted word timings while preserving source offsets", () => {
    const words = estimateWordRanges("Hi extraordinary world", 20, 5, 9);
    expect(words.map((word) => word.word)).toEqual(["Hi", "extraordinary", "world"]);
    expect(words[0]).toMatchObject({ start: 20, end: 22, startSec: 5 });
    expect(words[1].endSec - words[1].startSec).toBeGreaterThan(words[0].endSec - words[0].startSec);
    expect(words.at(-1)?.endSec).toBe(9);
  });

  it("keeps book progress stable when only one section has generated audio", () => {
    expect(calculateReaderProgress(1000, 200, 30, 120)).toBe(20);
    expect(calculateReaderProgress(1000, 200, 0, 0)).toBe(20);
  });

  it("derives bounded reading sections without changing the real table of contents", () => {
    const paragraphs = Array.from({ length: 120 }, (_, index) => (
      `Paragraph ${index + 1}. ${"A long sentence for section planning. ".repeat(8)}`
    ));
    const text = `# One very long chapter\n\n${paragraphs.join("\n\n")}`;
    const document = createReaderDocument({ title: "Long book", text });
    const sections = buildReaderSections(document.text, document.chapters);

    expect(document.chapters).toHaveLength(1);
    expect(sections.length).toBeGreaterThan(1);
    expect(sections.every((section) => section.end - section.start <= READER_SECTION_MAX_CHARS)).toBe(true);
    expect(sections.map((section) => document.text.slice(section.start, section.end)).join(""))
      .toBe(document.text);
    expect(readerSectionAtOffset(sections, sections[1].start)?.id).toBe(sections[1].id);
  });

  it("migrates legacy progress and annotations onto derived sections", () => {
    const document = createReaderDocument({
      id: "legacy-book",
      text: "A long legacy paragraph. ".repeat(900),
      now: 100,
    });
    const sections = buildReaderSections(document.text, document.chapters);
    const textOffset = sections[1].start + 25;
    const legacy = {
      ...document,
      progress: {
        positionSec: 12,
        totalDurationSec: 40,
        textOffset,
        chapterId: document.chapters[0].id,
        percent: 99,
        updatedAt: 200,
      },
      bookmarks: [{
        id: "bookmark-legacy",
        label: "Resume here",
        textOffset,
        chapterId: document.chapters[0].id,
        positionSec: 12,
        createdAt: 200,
      }],
      notes: [{
        id: "note-legacy",
        text: "Remember this",
        quote: "legacy paragraph",
        textOffset,
        chapterId: document.chapters[0].id,
        createdAt: 200,
        updatedAt: 200,
      }],
    } as unknown as typeof document;

    const migrated = normalizeReaderDocumentRecord(legacy);

    expect(migrated.text).toBe(document.text);
    expect(migrated.progress.sectionId).toBe(sections[1].id);
    expect(migrated.progress.percent).toBeCloseTo((textOffset / document.text.length) * 100);
    expect(migrated.bookmarks[0].sectionId).toBe(sections[1].id);
    expect(migrated.notes[0].sectionId).toBe(sections[1].id);
  });

  it("changes audio signatures when generation inputs change", () => {
    const base = { text: "hello", model: "kokoro", voice: "heart", quality: 5 };
    expect(buildAudioSignature(base)).toMatch(/^5-/);
    expect(buildAudioSignature(base)).toBe(buildAudioSignature(base));
    expect(buildAudioSignature(base)).not.toBe(buildAudioSignature({ ...base, voice: "bella" }));
    expect(buildAudioSignature(base)).not.toBe(buildAudioSignature({ ...base, text: "hello!" }));
    expect(buildAudioSignature({ ...base, tuning: { speed: 1, quality: 5 } }))
      .not.toBe(buildAudioSignature({ ...base, tuning: { speed: 1.1, quality: 5 } }));
  });

  it("normalizes chapter gaps and resolves offsets to the preceding range", () => {
    const document = createReaderDocument({
      title: "Gapped",
      text: "First section.\n\nSecond section.",
      chapters: [
        { id: "one", title: "One", order: 0, start: 2, end: 12, level: 1 },
        { id: "two", title: "Two", order: 1, start: 16, end: 30, level: 1 },
      ],
    });
    expect(document.chapters[0]).toMatchObject({ start: 0, end: 16 });
    expect(chapterAtOffset(document.chapters, 14)?.id).toBe("one");
  });

  it("rebases imported chapter boundaries without replacing TOC metadata", () => {
    const previous = "Opening body.\n\nConclusion body.";
    const chapters = [
      { id: "opening", title: "Opening", order: 0, start: 0, end: 15, level: 1 },
      { id: "conclusion", title: "Conclusion", order: 1, start: 15, end: previous.length, level: 2 },
    ];
    const next = `New preface. ${previous}`;
    const rebased = rebaseReaderChapters(previous, next, chapters, "Book");
    expect(rebased.map(({ id, title, level }) => ({ id, title, level }))).toEqual([
      { id: "opening", title: "Opening", level: 1 },
      { id: "conclusion", title: "Conclusion", level: 2 },
    ]);
    expect(next.slice(rebased[1].start)).toContain("Conclusion body.");
  });

  it("normalizes an edited fragment without trimming its section boundaries", () => {
    expect(normalizeReaderTextFragment(" leading  \r\n\r\n\r\n\r\ntrailing "))
      .toBe(" leading\n\n\ntrailing ");
  });

  it("rebases absolute annotation offsets around a localized edit", () => {
    const previous = "before EDIT after";
    const next = "before A MUCH LONGER EDIT after";

    expect(rebaseReaderTextOffset(previous, next, 2)).toBe(2);
    expect(rebaseReaderTextOffset(previous, next, previous.indexOf("after")))
      .toBe(next.indexOf("after"));
  });
});
