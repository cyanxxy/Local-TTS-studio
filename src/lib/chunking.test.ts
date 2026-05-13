import { describe, expect, it } from "vitest";
import {
  chunkTextForModel,
  chunkTextForModelDetailed,
  chunkWithConstraints,
  chunkWithConstraintsDetailed,
  getAdaptiveChunkLimits,
  rechunkChunkForRetry,
  type TextChunk,
} from "./chunking";

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
    expect(kokoro.length).toBeGreaterThan(1);
    expect(kokoro.at(-1)?.pauseAfterSec).toBe(0);
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
