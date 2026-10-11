import { describe, expect, it } from "vitest";
import {
  buildKokoroInferenceUnits,
  chunkForSupertonicDetailed,
  chunkTextForModel,
  chunkTextForModelDetailed,
  chunkWithConstraints,
  chunkWithConstraintsDetailed,
  findSplitNearMiddle,
  getAdaptiveChunkLimits,
  getKokoroMaxInferenceChars,
  KOKORO_FIRST_UNIT_MAX_CHARS,
  rampedBudget,
  rechunkChunkForRetry,
  SUPERTONIC_FIRST_CHUNK_MAX_CHARS,
  type TextChunk,
} from "./chunking";

describe("Kokoro chunk boundaries", () => {
  const book = "Chapter 1: The Stairs\n\nThe keeper climbed the stairs. He counted each step, slowly.\nThe sea was grey.";

  it("never merges across a line break, so headings get their own pause", () => {
    const chunks = chunkTextForModelDetailed(book, "kokoro", { runtime: { backend: "webgpu" } });
    expect(chunks.map((chunk) => [chunk.text, chunk.pauseKind])).toEqual([
      ["Chapter 1: The Stairs", "paragraph"],
      ["The keeper climbed the stairs. He counted each step, slowly.", "sentence"],
      ["The sea was grey.", "none"],
    ]);
    expect(chunks[0].pauseAfterSec).toBeGreaterThan(chunks[1].pauseAfterSec);
    for (const chunk of chunks) expect(book.slice(chunk.start, chunk.end)).toBe(chunk.text);
  });

  it("still merges sentences within one paragraph", () => {
    const units = buildKokoroInferenceUnits("One. Two. Three.\nFour.", 520);
    expect(units.map((unit) => unit.text)).toEqual(["One. Two. Three.", "Four."]);
  });
});

describe("chunkWithConstraintsDetailed", () => {
  it("returns stable offsets that map exactly to source text slices", () => {
    const text = [
      "# Introduction",
      "",
      "First sentence. Second sentence, with commas and extra details.",
      "",
      "- Bullet one with useful context.",
      "- Bullet two with more details.",
      "",
      "Final paragraph closes the section.",
    ].join("\n");

    const chunks = chunkWithConstraintsDetailed(text, { minCharacters: 45, maxCharacters: 140 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text).toBe(text.slice(chunk.start, chunk.end));
    }
  });

  it("prefers semantic paragraph boundaries before hard limits", () => {
    const text = "A short paragraph.\n\nAnother paragraph starts here with more text.";
    const chunks = chunkWithConstraintsDetailed(text, { minCharacters: 1, maxCharacters: 200 });

    expect(chunks).toHaveLength(2);
    expect(chunks[0].pauseKind).toBe("paragraph");
  });

  it("covers every non-whitespace character from the source text", () => {
    const text = [
      "Intro: value = 3.14, e.g. stable.",
      "Repeated line. Repeated line.",
      "",
      "\"Quoted\" section... with odd spacing\tand symbols.",
      "",
      "Final bit (v2.0).",
    ].join("\n");

    const chunks = chunkWithConstraintsDetailed(text, { minCharacters: 40, maxCharacters: 120 });
    const covered = new Array(text.length).fill(false);

    for (const chunk of chunks) {
      for (let i = chunk.start; i < chunk.end; i += 1) {
        covered[i] = true;
      }
    }

    for (let i = 0; i < text.length; i += 1) {
      if (!/\s/.test(text[i])) {
        expect(covered[i]).toBe(true);
      }
    }
  });

  it("handles empty text, simple wrappers, and source text with unusual whitespace", () => {
    expect(chunkWithConstraintsDetailed("   \n\t  ")).toEqual([]);
    expect(chunkWithConstraints(" First sentence. Second sentence. ", {
      minCharacters: 1,
      maxCharacters: 120,
    })).toEqual(["First sentence. Second sentence."]);

    const text = "Intro line.\nStill same paragraph with\todd spacing.\n\n> Quoted block.";
    const chunks = chunkWithConstraintsDetailed(text, { minCharacters: 10, maxCharacters: 80 });

    expect(chunks.map((chunk) => chunk.text)).toContain("> Quoted block.");
    for (const chunk of chunks) {
      expect(chunk.text).toBe(text.slice(chunk.start, chunk.end));
    }
  });

  it("keeps headings, lists, code, and Kokoro preview chunks semantically separated", () => {
    const text = [
      "1. Overview",
      "",
      "    const value = 1;",
      "    return value;",
      "",
      "- First item",
      "- Second item",
      "",
      "Regular sentence. Another regular sentence.",
    ].join("\n");

    const supertonic = chunkTextForModelDetailed(text, "supertonic", {
      minCharacters: 1,
      maxCharacters: 120,
    });
    expect(supertonic.some((chunk) => chunk.text.startsWith("1. Overview"))).toBe(true);
    expect(supertonic.some((chunk) => chunk.text.includes("const value"))).toBe(true);
    expect(supertonic.some((chunk) => chunk.text.includes("- First item"))).toBe(true);

    const kokoro = chunkTextForModelDetailed(text, "kokoro");
    expect(kokoro.length).toBeGreaterThanOrEqual(1);
    expect(kokoro.at(-1)?.pauseAfterSec).toBe(0);
    for (const chunk of kokoro) {
      expect(chunk.text).toBe(text.slice(chunk.start, chunk.end));
    }
    expect(chunkTextForModel("   ", "kokoro")).toEqual([]);
  });

  it("splits oversized units on punctuation, whitespace, and hard limits", () => {
    const punctuated = `${"alpha ".repeat(20)}, ${"beta ".repeat(20)}! ${"gamma ".repeat(20)}`;
    const whitespaceOnly = "word ".repeat(80);
    const hardLimit = "x".repeat(240);

    expect(chunkWithConstraintsDetailed(punctuated, { minCharacters: 40, maxCharacters: 90 }).length).toBeGreaterThan(2);
    expect(chunkWithConstraintsDetailed(whitespaceOnly, { minCharacters: 40, maxCharacters: 90 }).length).toBeGreaterThan(2);
    expect(chunkWithConstraintsDetailed(hardLimit, { minCharacters: 40, maxCharacters: 90 }).every((chunk) => chunk.text.length <= 90)).toBe(true);
  });

  it("never exceeds maxCharacters when punctuation sits exactly on the budget boundary", () => {
    // Char at index 90 is punctuation: the oversized-range scan used to split
    // at index 91, producing a 91-char chunk for a 90-char budget.
    const text = `${"a".repeat(90)},${"b".repeat(100)}`;
    const chunks = chunkWithConstraintsDetailed(text, { minCharacters: 40, maxCharacters: 90 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(90);
      expect(chunk.text).toBe(text.slice(chunk.start, chunk.end));
    }
  });

  it("recognizes CRLF paragraph boundaries with offsets mapping to the original text", () => {
    const lfText = "A short paragraph.\n\nAnother paragraph starts here with more text.";
    const crlfText = lfText.replace(/\n/g, "\r\n");

    const chunks = chunkWithConstraintsDetailed(crlfText, { minCharacters: 1, maxCharacters: 200 });

    expect(chunks).toHaveLength(2);
    expect(chunks[0].pauseKind).toBe("paragraph");
    for (const chunk of chunks) {
      expect(chunk.text).toBe(crlfText.slice(chunk.start, chunk.end));
    }
  });
});

describe("adaptive limits", () => {
  it("uses smaller max chunk size on wasm/high quality than webgpu/low quality", () => {
    const slowProfile = getAdaptiveChunkLimits({ backend: "wasm", quality: 14 });
    const fastProfile = getAdaptiveChunkLimits({ backend: "webgpu", quality: 3 });

    expect(slowProfile.maxCharacters).toBeLessThan(fastProfile.maxCharacters);
    expect(slowProfile.targetCharacters).toBeLessThan(fastProfile.targetCharacters);
  });

  it("honors overrides and mid-quality runtime adjustments", () => {
    expect(getAdaptiveChunkLimits(undefined, { minCharacters: 70, maxCharacters: 150 })).toEqual({
      minCharacters: 70,
      maxCharacters: 150,
      targetCharacters: 110,
    });

    const mediumQuality = getAdaptiveChunkLimits({ backend: "webgpu", quality: 10 });
    const defaultWebgpu = getAdaptiveChunkLimits({ backend: "webgpu", quality: 5 });
    expect(mediumQuality.maxCharacters).toBeLessThan(defaultWebgpu.maxCharacters);
  });

  it("honors one-sided min and max overrides without replacing them with runtime defaults", () => {
    expect(getAdaptiveChunkLimits({ backend: "wasm", quality: 5 }, { minCharacters: 100 }).minCharacters).toBe(100);
    expect(getAdaptiveChunkLimits({ backend: "webgpu", quality: 14 }, { maxCharacters: 200 }).maxCharacters).toBe(200);
  });

  it("does not hard-split UTF-16 surrogate pairs", () => {
    const text = `${"a".repeat(79)}💡${"b".repeat(40)}`;
    const chunks = chunkWithConstraintsDetailed(text, { minCharacters: 40, maxCharacters: 80 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const first = chunk.text.charCodeAt(0);
      const last = chunk.text.charCodeAt(chunk.text.length - 1);
      expect(first >= 0xDC00 && first <= 0xDFFF).toBe(false);
      expect(last >= 0xD800 && last <= 0xDBFF).toBe(false);
      expect(chunk.text).toBe(text.slice(chunk.start, chunk.end));
    }
  });

  it("does not hard-split a final combining-mark grapheme", () => {
    const text = `${"a".repeat(79)}e\u0301`;
    const chunks = chunkWithConstraintsDetailed(text, { minCharacters: 40, maxCharacters: 80 });

    expect(chunks).toHaveLength(2);
    expect(chunks[0].text.endsWith("e")).toBe(false);
    expect(chunks[1].text).toBe("e\u0301");
  });
});

describe("kokoro inference units", () => {
  it("exposes the per-backend inference budget used by the worker and preview", () => {
    expect(getKokoroMaxInferenceChars("webgpu")).toBeGreaterThan(getKokoroMaxInferenceChars("wasm"));
    expect(getKokoroMaxInferenceChars(null)).toBe(getKokoroMaxInferenceChars("wasm"));
    expect(getKokoroMaxInferenceChars(undefined)).toBe(getKokoroMaxInferenceChars("wasm"));
  });

  it("merges short adjacent sentences into one unit with offsets mapping to the source", () => {
    const text = "First sentence. Second sentence.";
    const units = buildKokoroInferenceUnits(text, 520);

    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ text, start: 0, end: text.length });
  });

  it("splits sentences across units once the budget is exceeded", () => {
    const text = "First sentence. Second sentence. Third sentence.";
    const units = buildKokoroInferenceUnits(text, 20);

    expect(units.length).toBeGreaterThan(1);
    for (const unit of units) {
      expect(unit.text).toBe(text.slice(unit.start, unit.end));
    }
  });

  it("splits oversized single Kokoro units before generation", () => {
    const text = "x".repeat(251);
    const units = buildKokoroInferenceUnits(text, 80);

    expect(units.length).toBeGreaterThan(1);
    expect(units.every((unit) => unit.text.length <= 80)).toBe(true);
    expect(units.map((unit) => unit.text).join("")).toBe(text);
    for (const unit of units) {
      expect(unit.text).toBe(text.slice(unit.start, unit.end));
    }
  });

  it("matches the reader preview boundaries to the generated merge budget", () => {
    const text = "Alpha sentence. Beta sentence. Gamma sentence.";

    const webgpuPreview = chunkTextForModelDetailed(text, "kokoro", { runtime: { backend: "webgpu" } });
    const wasmPreview = chunkTextForModelDetailed(text, "kokoro", { runtime: { backend: "wasm" } });

    expect(webgpuPreview).toHaveLength(buildKokoroInferenceUnits(text, getKokoroMaxInferenceChars("webgpu")).length);
    expect(wasmPreview).toHaveLength(buildKokoroInferenceUnits(text, getKokoroMaxInferenceChars("wasm")).length);
  });
});

describe("rechunkChunkForRetry", () => {
  it("returns the original chunk when retry splitting is not useful", () => {
    const short: TextChunk = {
      text: "Short chunk.",
      start: 0,
      end: 12,
      pauseAfterSec: 0,
      pauseKind: "none",
    };

    expect(rechunkChunkForRetry(short)).toEqual([short]);
  });

  it("splits failing chunk and preserves parent pause metadata on final retry chunk", () => {
    const text = "Logistics allocation validation pipeline ".repeat(20).trim();
    const chunk: TextChunk = {
      text,
      start: 10,
      end: 10 + text.length,
      pauseAfterSec: 0.44,
      pauseKind: "paragraph",
    };

    const retryChunks = rechunkChunkForRetry(chunk, { runtime: { backend: "wasm", quality: 15 }, attempt: 1 });

    expect(retryChunks.length).toBeGreaterThan(1);
    expect(retryChunks[0].start).toBeGreaterThanOrEqual(chunk.start);
    expect(retryChunks[retryChunks.length - 1].pauseAfterSec).toBe(chunk.pauseAfterSec);
    expect(retryChunks[retryChunks.length - 1].pauseKind).toBe(chunk.pauseKind);
  });
});

describe("findSplitNearMiddle", () => {
  const parts = (text: string) => {
    const offset = findSplitNearMiddle(text);
    return offset === null ? null : [text.slice(0, offset).trimEnd(), text.slice(offset)];
  };

  it("prefers the sentence end closest to the middle", () => {
    expect(parts("The keeper climbed. He counted every step, slowly. The sea was grey and cold."))
      .toEqual(["The keeper climbed. He counted every step, slowly.", "The sea was grey and cold."]);
  });

  it("falls back to a clause break, then to the space closest to the middle", () => {
    expect(parts("One long sentence that rambles on, and then keeps going for a while longer"))
      .toEqual(["One long sentence that rambles on,", "and then keeps going for a while longer"]);
    expect(parts("one two three four five six seven eight"))
      .toEqual(["one two three four", "five six seven eight"]);
  });

  it("chooses an even split over a natural boundary that leaves one part tiny", () => {
    expect(parts("Hi. this text runs on for quite a while without any further punctuation at all"))
      .toEqual(["Hi. this text runs on for quite a while", "without any further punctuation at all"]);
  });

  it("keeps closing quotes and brackets with the sentence they end", () => {
    expect(parts('He said "stop." She did (eventually.) Then they all went home together.'))
      .toEqual(['He said "stop." She did (eventually.)', "Then they all went home together."]);
  });

  it("splits full-width punctuation that has no trailing space", () => {
    expect(parts("今日は晴れです。明日は雨が降るでしょう。")).toEqual(["今日は晴れです。", "明日は雨が降るでしょう。"]);
  });

  it("cuts an unbroken run between graphemes and refuses what cannot be split", () => {
    expect(parts("12345678")).toEqual(["1234", "5678"]);
    expect(parts("a😀b😀")).toEqual(["a😀", "b😀"]);
    expect(findSplitNearMiddle("😀")).toBeNull();
    expect(findSplitNearMiddle("  a  ")).toBeNull();
    expect(findSplitNearMiddle("")).toBeNull();
  });

  it("ignores boundaries in leading or trailing whitespace", () => {
    expect(parts("  First half here. Second half here.  "))
      .toEqual(["  First half here.", "Second half here.  "]);
  });
});

describe("first-unit ramp", () => {
  // Thirty 41-character sentences in one paragraph.
  const prose = Array.from({ length: 30 }, (_, index) => `Sentence ${String(index).padStart(2, "0")} keeps the story going on.`)
    .join(" ");

  function expectExactCoverage(text: string, chunks: TextChunk[]): void {
    let cursor = 0;
    for (const chunk of chunks) {
      expect(text.slice(chunk.start, chunk.end)).toBe(chunk.text);
      expect(text.slice(cursor, chunk.start).trim()).toBe("");
      cursor = chunk.end;
    }
    expect(text.slice(cursor).trim()).toBe("");
  }

  it("doubles the budget from the first cap up to the full budget", () => {
    expect([0, 1, 2, 3].map((index) => rampedBudget(index, 140, 520))).toEqual([140, 280, 520, 520]);
    expect(rampedBudget(0, undefined, 520)).toBe(520);
  });

  it("caps Kokoro's first units and keeps later units full size", () => {
    const chunks = chunkTextForModelDetailed(prose, "kokoro", { runtime: { backend: "webgpu" } });
    const lengths = chunks.map((chunk) => chunk.text.length);

    expect(lengths[0]).toBeLessThanOrEqual(KOKORO_FIRST_UNIT_MAX_CHARS);
    expect(lengths[1]).toBeLessThanOrEqual(KOKORO_FIRST_UNIT_MAX_CHARS * 2);
    expect(lengths[2]).toBeGreaterThan(KOKORO_FIRST_UNIT_MAX_CHARS * 2);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(getKokoroMaxInferenceChars("webgpu"));
    expect(chunks.slice(0, -1).every((chunk) => chunk.pauseKind === "sentence")).toBe(true);
    expectExactCoverage(prose, chunks);
    // The worker generates the same units the Reader previews.
    expect(chunks.map(({ start, end }) => [start, end])).toEqual(
      buildKokoroInferenceUnits(prose, getKokoroMaxInferenceChars("webgpu"), { firstUnitMaxChars: KOKORO_FIRST_UNIT_MAX_CHARS })
        .map(({ start, end }) => [start, end]),
    );
  });

  it("leaves Kokoro's merge budget alone without a first-unit cap", () => {
    const units = buildKokoroInferenceUnits(prose, 520);
    expect(units[0].text.length).toBeGreaterThan(KOKORO_FIRST_UNIT_MAX_CHARS * 2);
  });

  it("cuts a long first sentence at its last clause break within the cap", () => {
    const text = "When the storm finally broke over the harbour that night, every boat strained at its rope, "
      + "and the keeper, who had seen a hundred storms, climbed the stairs to light the lamp. The sea calmed.";
    const chunks = chunkTextForModelDetailed(text, "kokoro", { runtime: { backend: "webgpu" } });

    expect(chunks[0]).toMatchObject({
      text: "When the storm finally broke over the harbour that night, every boat strained at its rope, and the keeper, who had seen a hundred storms,",
      pauseKind: "comma",
    });
    expect(chunks[1].text.startsWith("climbed the stairs")).toBe(true);
    expectExactCoverage(text, chunks);
  });

  it("keeps a long first sentence whole when no clause break fits the cap", () => {
    const text = `${"word ".repeat(40).trim()}. Next sentence.`;
    const chunks = chunkTextForModelDetailed(text, "kokoro", { runtime: { backend: "webgpu" } });
    expect(chunks[0].text).toBe(`${"word ".repeat(40).trim()}.`);
    const early = "Yes, the keeper climbed every one of the many worn stone steps of that tall old lighthouse again tonight and then he rested for a while.";
    expect(chunkTextForModelDetailed(early, "kokoro", { runtime: { backend: "webgpu" } })[0].text).toBe(early);
  });

  it("caps Supertonic's first chunk, in the preview and the worker alike", () => {
    const capped = chunkTextForModelDetailed(prose, "supertonic", { runtime: { backend: "webgpu", quality: 5 } });
    const uncapped = chunkWithConstraintsDetailed(prose, { runtime: { backend: "webgpu", quality: 5 } });

    expect(capped[0].text.length).toBeLessThanOrEqual(SUPERTONIC_FIRST_CHUNK_MAX_CHARS);
    expect(capped[1].text.length).toBeLessThanOrEqual(SUPERTONIC_FIRST_CHUNK_MAX_CHARS * 2);
    expect(uncapped[0].text.length).toBeGreaterThan(SUPERTONIC_FIRST_CHUNK_MAX_CHARS);
    expect(capped.at(-2)!.text.length).toBe(uncapped.at(-2)!.text.length);
    expectExactCoverage(prose, capped);
    expect(capped).toEqual(chunkForSupertonicDetailed(prose, { runtime: { backend: "webgpu", quality: 5 } }));
  });

  it("applies the first-chunk cap under explicit limits and cuts a long first sentence at a clause", () => {
    const text = "When the storm finally broke over the harbour that night, every boat strained at its rope, "
      + "and the keeper, who had seen a hundred storms, climbed the stairs to light the lamp. The sea calmed.";
    const chunks = chunkForSupertonicDetailed(text, { minCharacters: 30, maxCharacters: 280 });

    expect(chunks[0]).toMatchObject({
      text: "When the storm finally broke over the harbour that night, every boat strained at its rope, and the keeper, who had seen a hundred storms,",
      pauseKind: "comma",
    });
    expectExactCoverage(text, chunks);
  });
});
