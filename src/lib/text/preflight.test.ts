import { describe, expect, it } from "vitest";
import { chunkTextForModelDetailed } from "../chunking";
import { DEFAULT_CHARACTERS_PER_SECOND, buildScriptPreflight } from "./preflight";
import type { BreakAwareChunk } from "./speechMarkup";

/** One chunk per sentence, with sentence pauses between them. */
function sentenceChunker(text: string): BreakAwareChunk[] {
  const chunks: BreakAwareChunk[] = [];
  for (const match of text.matchAll(/[^.!?]+[.!?]*/g)) {
    const trimmedStart = match.index + (match[0].length - match[0].trimStart().length);
    const chunkText = match[0].trim();
    if (!chunkText) continue;
    chunks.push({ text: chunkText, start: trimmedStart, end: trimmedStart + chunkText.length, pauseAfterSec: 0.24, pauseKind: "sentence" });
  }
  if (chunks.length > 0) chunks[chunks.length - 1] = { ...chunks[chunks.length - 1], pauseAfterSec: 0, pauseKind: "none" };
  return chunks;
}

describe("buildScriptPreflight", () => {
  const script = 'The GIF costs $5. <break time="1.5s"/> Then *wait*. Done!';

  it("maps chunks, spoken text, pauses and a duration estimate", () => {
    const preflight = buildScriptPreflight(script, {
      chunk: sentenceChunker,
      pronunciationRules: [{ from: "GIF", to: "jif" }],
      normalization: {},
      pauseOverridesSec: { sentence: 0.5 },
      charactersPerSecond: 10,
    });

    expect(preflight.leadingPauseSec).toBe(0);
    expect(preflight.chunks.map((chunk) => [chunk.text, chunk.spokenText, chunk.pauseKind, chunk.pauseAfterSec, chunk.isBreak]))
      .toEqual([
        ["The GIF costs $5.", "The jif costs five dollars.", "none", 1.5, true],
        ["Then *wait*.", "Then wait.", "sentence", 0.5, false],
        ["Done!", "Done!", "none", 0, false],
      ]);
    for (const chunk of preflight.chunks) {
      expect(script.slice(chunk.start, chunk.end)).toBe(chunk.text);
    }
    expect(preflight.chunks[0].estimatedSpeechSec).toBe(2.7);
    expect(preflight.spokenText).toBe("The jif costs five dollars.\n\nThen wait.\n\nDone!");
    expect(preflight.totals).toEqual({
      chunkCount: 3,
      changedChunkCount: 2,
      spokenCharacters: 27 + 10 + 5,
      speechSec: 4.2,
      pauseSec: 2,
      durationSec: 6.2,
    });
  });

  it("reports diffs with offsets into the whole script", () => {
    const preflight = buildScriptPreflight(script, { chunk: sentenceChunker, pronunciationRules: [{ from: "GIF", to: "jif" }] });
    const second = preflight.chunks[1];
    expect(second.diff).toEqual([
      { type: "equal", text: "Then ", sourceStart: second.start },
      { type: "removed", text: "*", sourceStart: second.start + 5, reason: "emphasis" },
      { type: "equal", text: "wait", sourceStart: second.start + 6 },
      { type: "removed", text: "*", sourceStart: second.start + 10, reason: "emphasis" },
      { type: "equal", text: ".", sourceStart: second.start + 11 },
    ]);
    const removedGif = preflight.chunks[0].diff.find((part) => part.type === "removed");
    expect(removedGif).toMatchObject({ text: "GIF", sourceStart: script.indexOf("GIF"), reason: "pronunciation" });
    // Normalization is opt-in.
    expect(preflight.chunks[0].spokenText).toBe("The jif costs $5.");
  });

  it("scales the estimate with speed and uses the default rate", () => {
    const text = "x".repeat(DEFAULT_CHARACTERS_PER_SECOND * 2);
    const chunk = (value: string): BreakAwareChunk[] => [{ text: value, start: 0, end: value.length, pauseAfterSec: 0, pauseKind: "none" }];
    expect(buildScriptPreflight(text, { chunk }).totals.speechSec).toBe(2);
    expect(buildScriptPreflight(text, { chunk, speed: 2 }).totals.speechSec).toBe(1);
    expect(buildScriptPreflight(text, { chunk, speed: 0, charactersPerSecond: Number.NaN }).totals.speechSec).toBe(2);
  });

  it("includes a leading pause and handles empty scripts", () => {
    const preflight = buildScriptPreflight("[pause 2s] Hello.", { chunk: sentenceChunker });
    expect(preflight.leadingPauseSec).toBe(2);
    expect(preflight.totals.pauseSec).toBe(2);
    expect(buildScriptPreflight("   ", { chunk: sentenceChunker }).totals).toEqual({
      chunkCount: 0,
      changedChunkCount: 0,
      spokenCharacters: 0,
      speechSec: 0,
      pauseSec: 0,
      durationSec: 0,
    });
  });

  it("follows the engine chunker", () => {
    const text = "First sentence here. Second sentence here.\n\nNew paragraph. [pause 3s] After the break.";
    const preflight = buildScriptPreflight(text, { chunk: (segment) => chunkTextForModelDetailed(segment, "supertonic") });
    expect(preflight.chunks.length).toBeGreaterThan(0);
    expect(preflight.chunks.some((chunk) => chunk.isBreak && chunk.pauseAfterSec === 3)).toBe(true);
    expect(preflight.chunks.every((chunk) => !chunk.spokenText.includes("[pause"))).toBe(true);
  });
});
