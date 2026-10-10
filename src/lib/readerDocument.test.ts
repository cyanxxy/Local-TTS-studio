import { describe, expect, it } from "vitest";
import {
  buildAudioSignature,
  buildReaderSections,
  calculateReaderProgress,
  chapterAtOffset,
  createReaderDocument,
  createReaderOffsetRebaser,
  estimateWordRanges,
  unwrapHardLineBreaks,
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

  it("holds the marker on a word through the pause that follows its punctuation", () => {
    const [plain] = estimateWordRanges("word word", 0, 0, 2);
    const [stop] = estimateWordRanges("word. word", 0, 0, 2);
    const [comma] = estimateWordRanges("word, word", 0, 0, 2);
    const span = (range: { startSec: number; endSec: number }) => range.endSec - range.startSec;
    expect(span(stop)).toBeGreaterThan(span(comma));
    expect(span(comma)).toBeGreaterThan(span(plain));
  });

  it("rejoins lines a PDF layout wrapped mid-sentence", () => {
    expect(unwrapHardLineBreaks(
      "The committee met on Tuesday to discuss the\nproposal, which had been circulated\nearlier in the week. Members raised\nseveral concerns about compre-\nhensive reform.",
    )).toBe(
      "The committee met on Tuesday to discuss the proposal, which had been circulated earlier in the week. Members raised several concerns about comprehensive reform.",
    );
  });

  it("keeps headings, list items, and paragraph breaks on their own lines", () => {
    const text = "Introduction\nThis report covers\nthree areas:\n- budget\n- staffing\n\nSecond paragraph.";
    expect(unwrapHardLineBreaks(text)).toBe(
      "Introduction\nThis report covers three areas:\n- budget\n- staffing\n\nSecond paragraph.",
    );
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
    expect(buildAudioSignature({ ...base, tuning: { speed: 1, quality: 5, language: "en" } }))
      .not.toBe(buildAudioSignature({ ...base, tuning: { speed: 1, quality: 5, language: "fr" } }));
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

/** The per-offset whole-text scan the single-pass rebaser replaces. */
function referenceRebase(previousText: string, nextText: string, offset: number): number {
  let prefixLength = 0;
  const sharedLimit = Math.min(previousText.length, nextText.length);
  while (prefixLength < sharedLimit && previousText[prefixLength] === nextText[prefixLength]) prefixLength += 1;
  let suffixLength = 0;
  while (
    suffixLength < sharedLimit - prefixLength
    && previousText[previousText.length - suffixLength - 1] === nextText[nextText.length - suffixLength - 1]
  ) suffixLength += 1;
  const previousChangeEnd = previousText.length - suffixLength;
  const nextChangeEnd = nextText.length - suffixLength;
  const safeOffset = Math.max(0, Math.min(previousText.length, offset));
  if (safeOffset < prefixLength) return safeOffset;
  if (safeOffset >= previousChangeEnd) return safeOffset + nextText.length - previousText.length;
  return prefixLength + Math.min(safeOffset - prefixLength, nextChangeEnd - prefixLength);
}

/** Deterministic PRNG so a failing case can be replayed. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("createReaderOffsetRebaser", () => {
  it("maps every offset exactly like a whole-text scan per offset", () => {
    const random = seededRandom(20_261_010);
    // A tiny alphabet makes repeated runs, where prefix and suffix overlap.
    const alphabet = "ab \n";
    const word = (length: number) => Array.from(
      { length },
      () => alphabet[Math.floor(random() * alphabet.length)],
    ).join("");

    for (let round = 0; round < 300; round += 1) {
      const previous = word(Math.floor(random() * 40));
      const start = Math.floor(random() * (previous.length + 1));
      const previousEnd = start + Math.floor(random() * (previous.length - start + 1));
      const replacement = word(Math.floor(random() * 8));
      const next = previous.slice(0, start) + replacement + previous.slice(previousEnd);
      const hint = { start, previousEnd, nextEnd: start + replacement.length };
      const rebase = createReaderOffsetRebaser(previous, next);
      const hinted = createReaderOffsetRebaser(previous, next, hint);

      for (let offset = -2; offset <= previous.length + 2; offset += 1) {
        const expected = referenceRebase(previous, next, offset);
        expect(rebase(offset)).toBe(expected);
        expect(hinted(offset)).toBe(expected);
        expect(rebaseReaderTextOffset(previous, next, offset)).toBe(expected);
      }
    }
  });

  it("only needs to scan the edited span when told where the edit is", () => {
    const filler = "Unchanged prose that the scan never has to visit. ".repeat(2_000);
    const previous = `${filler}The old line.${filler}`;
    const next = `${filler}A brand new, longer line.${filler}`;
    const rebase = createReaderOffsetRebaser(previous, next, {
      start: filler.length,
      previousEnd: filler.length + "The old line.".length,
      nextEnd: filler.length + "A brand new, longer line.".length,
    });

    expect(rebase(10)).toBe(10);
    expect(rebase(previous.length - 5)).toBe(next.length - 5);
    expect(rebase(filler.length + 2)).toBe(referenceRebase(previous, next, filler.length + 2));
  });

  it("falls back to a full scan when a hint does not describe the two texts", () => {
    const previous = "before EDIT after";
    const next = "before A MUCH LONGER EDIT after";
    const offset = previous.indexOf("after");

    for (const hint of [
      { start: -1, previousEnd: 11, nextEnd: 25 },
      { start: 7, previousEnd: 99, nextEnd: 25 },
      { start: 7, previousEnd: 11, nextEnd: 20 },
      { start: 7.5, previousEnd: 11, nextEnd: 25 },
    ]) {
      expect(createReaderOffsetRebaser(previous, next, hint)(offset)).toBe(next.indexOf("after"));
      // Alternate pairs so the remembered scan cannot answer for the hint.
      expect(createReaderOffsetRebaser(next, previous)(0)).toBe(0);
    }
  });

  it("never answers one text pair with the scan of another", () => {
    const first = ["one two three", "one TWO three"] as const;
    const second = ["alpha beta", "alpha beta gamma delta"] as const;

    expect(rebaseReaderTextOffset(...first, 9)).toBe(referenceRebase(...first, 9));
    expect(rebaseReaderTextOffset(...second, 9)).toBe(referenceRebase(...second, 9));
    expect(rebaseReaderTextOffset(...first, 9)).toBe(referenceRebase(...first, 9));
    expect(rebaseReaderChapters(first[0], first[1], [], "Book")).toHaveLength(1);
  });
});
