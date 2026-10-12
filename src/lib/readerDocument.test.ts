import { describe, expect, it } from "vitest";
import { estimateWordRanges as sharedEstimateWordRanges } from "./text/wordTiming";
import {
  buildAudioSignature,
  buildLegacyAudioSignature,
  buildReaderSections,
  calculateReaderProgress,
  chapterAtOffset,
  createReaderDocument,
  createReaderHighlight,
  createReaderOffsetRebaser,
  estimateWordRanges,
  isReaderDocumentCover,
  isReaderHighlightAnchored,
  isReaderHighlightColor,
  unwrapHardLineBreaks,
  normalizeReaderDocumentRecord,
  normalizeReaderTextFragment,
  READER_COVER_MAX_DATA_URL_CHARS,
  READER_HIGHLIGHT_QUOTE_LIMIT,
  rebaseReaderChapters,
  rebaseReaderHighlights,
  rebaseReaderTextOffset,
  READER_AUDIO_SIGNATURE_VERSION,
  READER_SECTION_MAX_CHARS,
  readerSectionAtOffset,
  resolveReaderHighlightRange,
  structureTextChapters,
  type ReaderHighlight,
  type ReaderListeningProfile,
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

  it("uses the one shared word-timing estimator for Reader highlighting", () => {
    expect(estimateWordRanges).toBe(sharedEstimateWordRanges);
  });

  it("reproduces the signature earlier releases saved Reader audio under", () => {
    // Computed with the version 1 buildAudioSignature before the format changed.
    expect(buildLegacyAudioSignature({
      text: "Hello there, world.",
      model: "kokoro",
      voice: "af_heart",
      quality: 5,
      tuning: { speed: 1.1, quality: 5, pauseOverridesSec: { comma: 0.2 }, pronunciationRules: [{ from: "a", to: "b" }] },
    })).toBe("j-1ydujgi");
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
    const base = { text: "hello", model: "kokoro", voice: "heart", tuning: {} };
    expect(buildAudioSignature(base)).toMatch(new RegExp(`^v${READER_AUDIO_SIGNATURE_VERSION}\\.5-`));
    expect(buildAudioSignature(base)).toBe(buildAudioSignature(base));
    expect(buildAudioSignature({ ...base, tuning: { speed: 1, quality: 5, language: "en" } }))
      .not.toBe(buildAudioSignature({ ...base, tuning: { speed: 1, quality: 5, language: "fr" } }));
    expect(buildAudioSignature(base)).not.toBe(buildAudioSignature({ ...base, voice: "bella" }));
    expect(buildAudioSignature(base)).not.toBe(buildAudioSignature({ ...base, model: "supertonic" }));
    expect(buildAudioSignature(base)).not.toBe(buildAudioSignature({ ...base, text: "hello!" }));
    expect(buildAudioSignature({ ...base, tuning: { speed: 1, quality: 5 } }))
      .not.toBe(buildAudioSignature({ ...base, tuning: { speed: 1.1, quality: 5 } }));
    expect(buildAudioSignature({ ...base, tuning: { pronunciationRules: [] } }))
      .not.toBe(buildAudioSignature({ ...base, tuning: { pronunciationRules: [{ from: "GIF", to: "jif" }] } }));
    expect(buildAudioSignature({ ...base, tuning: { pauseOverridesSec: { comma: 0.1 } } }))
      .not.toBe(buildAudioSignature({ ...base, tuning: { pauseOverridesSec: { comma: 0.2 } } }));
  });

  it("hashes absent and explicitly undefined tuning fields alike, in any key order", () => {
    const base = { text: "hello", model: "kokoro", voice: "heart" };
    expect(buildAudioSignature({ ...base, tuning: { speed: 1, sentenceSpeedVariance: undefined } }))
      .toBe(buildAudioSignature({ ...base, tuning: { speed: 1 } }));
    expect(buildAudioSignature({ ...base, tuning: { quality: 5, speed: 1 } }))
      .toBe(buildAudioSignature({ ...base, tuning: { speed: 1, quality: 5 } }));
    // An engine that ignores a field omits it, which must differ from reading it.
    expect(buildAudioSignature({ ...base, tuning: {} }))
      .not.toBe(buildAudioSignature({ ...base, tuning: { speed: 1 } }));
  });

  it("never matches a signature written before the version bump", () => {
    // Version 1 signatures were `${length.toString(36)}-${hash.toString(36)}`.
    // Base 36 has no ".", so even a text whose length encodes as "v2" (1118)
    // cannot produce a legacy signature equal to a prefixed one.
    const current = buildAudioSignature({ text: "x".repeat(1118), model: "kokoro", voice: "heart", tuning: {} });
    expect(current).toMatch(/^v2\.v2-[0-9a-z]+$/);
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

describe("reader highlights", () => {
  const text = "Call me Ishmael. Some years ago, never mind how long precisely, I went to sea.";

  function highlightOf(phrase: string, overrides: Partial<ReaderHighlight> = {}): ReaderHighlight {
    const start = text.indexOf(phrase);
    return {
      id: `highlight-${phrase}`,
      start,
      end: start + phrase.length,
      color: "yellow",
      quote: phrase,
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    };
  }

  it("creates a highlight trimmed to the words it covers", () => {
    const start = text.indexOf("Some") - 1;
    const highlight = createReaderHighlight(text, { start, end: text.indexOf(",") + 2, color: "green" }, 42);

    expect(highlight).toMatchObject({
      start: start + 1,
      end: text.indexOf(",") + 1,
      color: "green",
      quote: "Some years ago,",
      createdAt: 42,
      updatedAt: 42,
    });
    expect(highlight?.id).toMatch(/^highlight-/);
  });

  it("refuses ranges with nothing to highlight or an unknown colour", () => {
    expect(createReaderHighlight(text, { start: 4, end: 4, color: "yellow" })).toBeNull();
    expect(createReaderHighlight("a   b", { start: 1, end: 4, color: "yellow" })).toBeNull();
    expect(createReaderHighlight(text, { start: Number.NaN, end: 4, color: "yellow" })).toBeNull();
    expect(createReaderHighlight(text, { start: 0, end: 4, color: "orange" as never })).toBeNull();
    expect(isReaderHighlightColor("purple")).toBe(true);
    expect(isReaderHighlightColor(3)).toBe(false);
  });

  it("keeps only the start of a long highlight as its quote", () => {
    const long = "word ".repeat(1_000);
    const highlight = createReaderHighlight(long, { start: 0, end: long.length, color: "blue" });

    expect(highlight?.end).toBe(long.length - 1);
    expect(highlight?.quote).toHaveLength(READER_HIGHLIGHT_QUOTE_LIMIT);
    expect(isReaderHighlightAnchored(long, highlight!)).toBe(true);
  });

  it("finds a moved highlight at the nearest place its quote occurs", () => {
    const doubled = `${text} Call me Ishmael again.`;
    const moved = highlightOf("Call me Ishmael", { start: 3, end: 18 });

    expect(resolveReaderHighlightRange(doubled, moved)).toEqual({ start: 0, end: 15 });
    expect(resolveReaderHighlightRange(doubled, { ...moved, start: doubled.length - 10, end: doubled.length }))
      .toEqual({ start: doubled.lastIndexOf("Call"), end: doubled.lastIndexOf("Call") + 15 });
    expect(resolveReaderHighlightRange("Gone entirely.", moved)).toBeNull();
    expect(resolveReaderHighlightRange(text, { ...moved, quote: "" })).toBeNull();
  });

  it("normalizes stored highlights without adding them to older records", () => {
    const document = createReaderDocument({ id: "whale", text });
    expect("highlights" in normalizeReaderDocumentRecord(document)).toBe(false);

    const stored = {
      ...document,
      highlights: [
        highlightOf("went to sea"),
        { ...highlightOf("Some years ago"), start: 0, end: 14 },
        { ...highlightOf("Call me"), quote: "Vanished words" },
        { ...highlightOf("Ishmael"), color: "orange" },
        { id: "", start: 0, end: 4 },
        null,
      ],
    } as unknown as typeof document;

    const normalized = normalizeReaderDocumentRecord(stored).highlights;

    expect(normalized?.map((highlight) => [highlight.quote, highlight.start, highlight.end])).toEqual([
      ["Vanished words", 0, 7],
      ["Some years ago", text.indexOf("Some"), text.indexOf("Some") + 14],
      ["went to sea", text.indexOf("went"), text.indexOf("went") + 11],
    ]);
  });

  it("drops stored highlights with impossible offsets or a repeated id", () => {
    const document = createReaderDocument({ id: "whale", text });
    const stored = {
      ...document,
      highlights: [
        highlightOf("went to sea"),
        { ...highlightOf("went to sea"), color: "blue" },
        { ...highlightOf("Ishmael"), id: "negative", start: -3 },
        { ...highlightOf("Ishmael"), id: "fractional", end: 14.5 },
        { ...highlightOf("Ishmael"), id: "empty", end: text.indexOf("Ishmael") },
      ],
    } as unknown as typeof document;

    expect(normalizeReaderDocumentRecord(stored).highlights).toEqual([highlightOf("went to sea")]);
  });

  it("re-anchors a short quote over its own length, whatever end the record claims", () => {
    const shifted = `Prologue. ${text}`;
    const stored = {
      ...createReaderDocument({ id: "whale", text: shifted }),
      highlights: [highlightOf("Call me", { end: 1_000_000_000 })],
    };

    expect(normalizeReaderDocumentRecord(stored).highlights?.[0]).toMatchObject({
      start: shifted.indexOf("Call me"),
      end: shifted.indexOf("Call me") + "Call me".length,
    });
  });

  it("survives the JSON round trip both storage backends load records through", () => {
    const document = { ...createReaderDocument({ id: "whale", text }), highlights: [highlightOf("went to sea")] };

    const loaded = normalizeReaderDocumentRecord(JSON.parse(JSON.stringify(document)));

    expect(loaded.highlights).toEqual(document.highlights);
    expect(loaded.text).toBe(text);
  });

  it("moves anchored highlights with an edit and refreshes their quote", () => {
    const next = text.replace("never mind", "no matter");
    const detached = { ...highlightOf("Some years"), quote: "lost words" };
    const [before, inside, after, untouched] = rebaseReaderHighlights(text, next, [
      highlightOf("Call me Ishmael"),
      highlightOf("never mind how long"),
      highlightOf("went to sea"),
      detached,
    ]);

    expect(before).toEqual(highlightOf("Call me Ishmael"));
    expect(inside.quote).toBe("no matter how long");
    expect(next.slice(inside.start, inside.end)).toBe("no matter how long");
    expect(next.slice(after.start, after.end)).toBe("went to sea");
    expect(untouched).toBe(detached);
    expect(rebaseReaderHighlights(text, next, [])).toEqual([]);
  });

  it("leaves text typed right after a highlight outside it", () => {
    const next = text.replace("Call me Ishmael", "Call me Ishmael, sailor");
    const [highlight] = rebaseReaderHighlights(text, next, [highlightOf("Call me Ishmael")]);

    expect(highlight).toEqual(highlightOf("Call me Ishmael"));
    const [before] = rebaseReaderHighlights(text, `The story. ${text}`, [highlightOf("Call me Ishmael")]);
    expect(before.quote).toBe("Call me Ishmael");
    expect(before.start).toBe("The story. ".length);
  });

  it("drops a highlight whose words were all deleted", () => {
    const next = text.replace(" Some years ago,", "");

    expect(rebaseReaderHighlights(text, next, [highlightOf("Some years ago")])).toEqual([]);
  });
});

describe("reader covers", () => {
  const cover = { dataUrl: "data:image/jpeg;base64,/9j/4AAQSkZJRg==" };

  it("keeps a valid raster cover from the import", () => {
    expect(createReaderDocument({ text: "Body.", cover }).cover).toEqual(cover);
    expect("cover" in createReaderDocument({ text: "Body." })).toBe(false);
  });

  it("drops covers that are not small base64 raster images", () => {
    const rejected = [
      { dataUrl: "data:image/svg+xml;base64,PHN2Zz4=" },
      { dataUrl: "https://example.com/cover.jpg" },
      { dataUrl: "data:image/png;base64,not base64!" },
      { dataUrl: `data:image/png;base64,${"A".repeat(READER_COVER_MAX_DATA_URL_CHARS)}` },
      { dataUrl: 42 },
      "data:image/png;base64,AAAA",
    ];
    for (const value of rejected) {
      expect(isReaderDocumentCover(value)).toBe(false);
      expect("cover" in createReaderDocument({ text: "Body.", cover: value as never })).toBe(false);
    }
  });

  it("normalizes stored covers without adding one to older records", () => {
    const document = createReaderDocument({ id: "covered", text: "Body.", cover });

    expect(normalizeReaderDocumentRecord(JSON.parse(JSON.stringify(document))).cover).toEqual(cover);
    expect("cover" in normalizeReaderDocumentRecord({ ...document, cover: { dataUrl: "javascript:alert(1)" } })).toBe(false);
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
      // The hinted rebaser goes first: once the unhinted scan of this pair is
      // remembered it would answer for the hint, and the hinted search would
      // never run.
      const hinted = createReaderOffsetRebaser(previous, next, hint);
      const rebase = createReaderOffsetRebaser(previous, next);

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

  it("ignores a well-formed hint that misplaces the edit, and never remembers its answer", () => {
    const previous = "abXdef";
    const next = "abYYdef";
    // Lengths agree with the texts, but the edit is at 2, not 5.
    const wrongHint = { start: 5, previousEnd: 5, nextEnd: 6 };
    const hinted = createReaderOffsetRebaser(previous, next, wrongHint);
    for (let offset = 0; offset <= previous.length; offset += 1) {
      expect(hinted(offset)).toBe(referenceRebase(previous, next, offset));
      expect(rebaseReaderTextOffset(previous, next, offset)).toBe(referenceRebase(previous, next, offset));
    }
    expect(rebaseReaderTextOffset(previous, next, 3)).toBe(4);
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

describe("reader listening profile", () => {
  it("keeps a speed on its own, without an engine or voice", () => {
    const document = createReaderDocument({ id: "rate-only", text: "Text to listen to." });
    expect(normalizeReaderDocumentRecord({ ...document, listening: { playbackRate: 1.5, updatedAt: 4 } }).listening)
      .toEqual({ playbackRate: 1.5, updatedAt: 4 });
  });

  const document = createReaderDocument({ id: "listening", text: "Text to listen to." });

  it("is absent from a book that has none and kept when valid", () => {
    expect(normalizeReaderDocumentRecord(document)).not.toHaveProperty("listening");
    const listening = { engine: "kokoro", voice: "af_heart", language: "en", quality: 5, playbackRate: 1.5, updatedAt: 3 };
    expect(normalizeReaderDocumentRecord({ ...document, listening }).listening).toEqual(listening);
  });

  it("drops a malformed profile and clamps the speed to what the player offers", () => {
    const damaged = { engine: 7, voice: "x", updatedAt: 1 } as unknown as ReaderListeningProfile;
    expect(normalizeReaderDocumentRecord({ ...document, listening: damaged })).not.toHaveProperty("listening");
    // A voice without its engine, or an engine without its voice, says nothing usable.
    expect(normalizeReaderDocumentRecord({ ...document, listening: { voice: "x", updatedAt: 1 } }))
      .not.toHaveProperty("listening");
    expect(normalizeReaderDocumentRecord({ ...document, listening: { engine: "kokoro", updatedAt: 1 } }))
      .not.toHaveProperty("listening");
    const fast = { engine: "kokoro", voice: "x", playbackRate: 40, updatedAt: 1 };
    expect(normalizeReaderDocumentRecord({ ...document, listening: fast }).listening?.playbackRate).toBe(2);
  });
});
