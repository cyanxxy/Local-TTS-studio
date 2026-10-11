import { describe, expect, it } from "vitest";
import { createReaderDocument, type ReaderDocumentRecord } from "../../lib/readerDocument";
import {
  buildReaderAnnotationFile,
  buildReaderAnnotationsJson,
  buildReaderAnnotationsMarkdown,
  countReaderAnnotations,
  READER_ANNOTATION_EXPORT_FORMAT,
} from "./readerAnnotationExport";

const EXPORTED_AT = new Date(2026, 9, 11, 12, 0, 0);
const CREATED_AT = Date.UTC(2026, 9, 1, 9, 30, 0);

function annotatedBook(): ReaderDocumentRecord {
  const text = "# Loomings\nCall me Ishmael. Some years ago I went to sea.\n\n# The Carpet-Bag\nI stuffed a shirt or two into my old carpet-bag.";
  const book = createReaderDocument({ id: "moby", title: "Moby-Dick: or, The Whale", author: "Herman Melville", language: "en", text });
  const ishmael = text.indexOf("Call me Ishmael");
  const sea = text.indexOf("went to sea");
  const bag = text.indexOf("carpet-bag.");
  return {
    ...book,
    bookmarks: [
      { id: "bm-1", label: "Chapter two", textOffset: book.chapters[1].start, positionSec: 3723, chapterId: null, sectionId: null, createdAt: CREATED_AT },
    ],
    notes: [
      { id: "note-1", text: "  The famous opening.  ", quote: "Call me Ishmael.", textOffset: ishmael, chapterId: null, sectionId: null, createdAt: CREATED_AT, updatedAt: CREATED_AT },
    ],
    highlights: [
      { id: "hl-2", start: bag, end: bag + 10, color: "blue", quote: "carpet-bag", createdAt: CREATED_AT, updatedAt: CREATED_AT },
      { id: "hl-1", start: ishmael, end: ishmael + 15, color: "yellow", quote: "Call me Ishmael", createdAt: CREATED_AT, updatedAt: CREATED_AT },
      // Edited away: exported from its saved quote.
      { id: "hl-3", start: sea, end: sea + 11, color: "pink", quote: "sailed away", createdAt: CREATED_AT, updatedAt: CREATED_AT },
    ],
  };
}

describe("readerAnnotationExport", () => {
  it("counts every kind of annotation, including records without highlights", () => {
    const book = annotatedBook();
    expect(countReaderAnnotations(book)).toBe(5);
    expect(countReaderAnnotations({ ...book, highlights: undefined })).toBe(2);
  });

  it("writes Markdown grouped by chapter in reading order", () => {
    expect(buildReaderAnnotationsMarkdown(annotatedBook(), EXPORTED_AT)).toBe([
      "# Moby-Dick: or, The Whale",
      "",
      "by Herman Melville",
      "",
      "3 highlights · 1 note · 1 bookmark · exported from Open TTS on 2026-10-11",
      "",
      "## Loomings",
      "",
      "> Call me Ishmael",
      "",
      "*Yellow highlight · 9% through*",
      "",
      "> Call me Ishmael.",
      "",
      "The famous opening.",
      "",
      "*Note · 9% through*",
      "",
      "> sailed away",
      "",
      "*Pink highlight · 36% through*",
      "",
      "## The Carpet-Bag",
      "",
      "- Bookmark: Chapter two (48% through, 1:02:03)",
      "",
      "> carpet-bag",
      "",
      "*Blue highlight · 91% through*",
      "",
    ].join("\n"));
  });

  it("leaves chapter headings out of a one-chapter document and quotes multi-line passages line by line", () => {
    const text = "First line\n\nSecond line of the passage.";
    const book: ReaderDocumentRecord = {
      ...createReaderDocument({ id: "plain", title: "Plain", text }),
      highlights: [{ id: "hl", start: 0, end: text.length, color: "green", quote: text, createdAt: 1, updatedAt: 1 }],
    };

    const markdown = buildReaderAnnotationsMarkdown(book, EXPORTED_AT);

    expect(markdown).not.toContain("## ");
    expect(markdown).not.toContain("by ");
    expect(markdown).toContain("> First line\n>\n> Second line of the passage.\n\n*Green highlight · 0% through*");
  });

  it("writes versioned JSON with offsets, chapters and ISO times", () => {
    const parsed = JSON.parse(buildReaderAnnotationsJson(annotatedBook(), EXPORTED_AT));

    expect(parsed).toMatchObject({
      format: READER_ANNOTATION_EXPORT_FORMAT,
      version: 1,
      exportedAt: EXPORTED_AT.toISOString(),
      document: { id: "moby", title: "Moby-Dick: or, The Whale", author: "Herman Melville", language: "en" },
    });
    expect(parsed.highlights.map((entry: { id: string; text: string; chapter: string }) => [entry.id, entry.text, entry.chapter])).toEqual([
      ["hl-1", "Call me Ishmael", "Loomings"],
      ["hl-3", "sailed away", "Loomings"],
      ["hl-2", "carpet-bag", "The Carpet-Bag"],
    ]);
    expect(parsed.highlights[0]).toMatchObject({ color: "yellow", createdAt: "2026-10-01T09:30:00.000Z" });
    expect(parsed.notes[0]).toMatchObject({ id: "note-1", text: "  The famous opening.  ", chapter: "Loomings" });
    expect(parsed.bookmarks[0]).toMatchObject({ id: "bm-1", positionSec: 3723, chapter: "The Carpet-Bag" });
  });

  it("names the file after the title and picks the matching type", () => {
    const book = annotatedBook();

    expect(buildReaderAnnotationFile(book, "markdown", EXPORTED_AT)).toMatchObject({
      fileName: "Moby-Dick-or-The-Whale-annotations.md",
      mimeType: "text/markdown",
    });
    expect(buildReaderAnnotationFile(book, "json", EXPORTED_AT)).toMatchObject({
      fileName: "Moby-Dick-or-The-Whale-annotations.json",
      mimeType: "application/json",
    });
    expect(buildReaderAnnotationFile({ ...book, title: "???" }, "json", EXPORTED_AT).fileName)
      .toBe("reader-annotations.json");
  });
});
