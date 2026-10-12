import { describe, expect, it } from "vitest";
import { chunkTextForModelDetailed, type TextChunk } from "../chunking";
import {
  DEFAULT_BREAK_SEC,
  MAX_BREAK_SEC,
  chunkWithSpeechBreaks,
  findSpeechBreaks,
  parseSpeechBreaks,
  stripSpeechBreakMarkup,
} from "./speechMarkup";

function wholeChunk(text: string): TextChunk[] {
  return text.trim() ? [{ text, start: 0, end: text.length, pauseAfterSec: 0, pauseKind: "none" }] : [];
}

describe("findSpeechBreaks", () => {
  it.each([
    ['<break time="1.5s"/>', 1.5],
    ['<break time="500ms"/>', 0.5],
    ["<break time='2s' />", 2],
    ['<BREAK TIME="250MS">', 0.25],
    ['<break time=".75s"/>', 0.75],
    ["<break/>", DEFAULT_BREAK_SEC],
    ['<break strength="strong"/>', 0.75],
    ['<break strength="x-weak"/>', 0.1],
    ['<break strength="none"/>', 0],
    ["[pause 1.5s]", 1.5],
    ["[pause 500ms]", 0.5],
    ["[ Pause 2 seconds ]", 2],
    ["[pause 3]", 3],
    ["[pause .5 sec]", 0.5],
    ["[pause]", DEFAULT_BREAK_SEC],
  ])("reads %s as %s seconds", (tag, seconds) => {
    const [found] = findSpeechBreaks(`Hello ${tag} world`);
    expect(found).toMatchObject({ start: 6, end: 6 + tag.length, seconds, clamped: false, invalid: false });
  });

  it("labels the syntax", () => {
    expect(findSpeechBreaks('<break time="1s"/> [pause 1s]').map((tag) => tag.syntax)).toEqual(["ssml", "bracket"]);
  });

  it.each(['<break time="-1s"/>', '<break time="soon"/>', '<break time="1 min"/>', '<break strength="loud"/>'])(
    "falls back to the default pause for the unreadable %s",
    (tag) => {
      expect(findSpeechBreaks(tag)[0]).toMatchObject({ seconds: DEFAULT_BREAK_SEC, invalid: true });
    },
  );

  it("clamps long pauses", () => {
    expect(findSpeechBreaks('<break time="60s"/>')[0]).toMatchObject({ seconds: MAX_BREAK_SEC, clamped: true });
    expect(findSpeechBreaks("[pause 12000ms]")[0]).toMatchObject({ seconds: MAX_BREAK_SEC, clamped: true });
  });

  it("rounds to milliseconds", () => {
    expect(findSpeechBreaks('<break time="0.12345s"/>')[0].seconds).toBe(0.123);
  });

  it("ignores look-alike text", () => {
    expect(findSpeechBreaks("<breakfast/> [paused 2s] [pause 2 minutes] [pause -1s] break time")).toEqual([]);
  });
});

describe("parseSpeechBreaks", () => {
  it("splits text into trimmed segments with explicit pauses and source offsets", () => {
    const text = 'Ready. <break time="1.5s"/> Set. [pause 500ms]Go!';
    const parsed = parseSpeechBreaks(text);
    expect(parsed.leadingPauseSec).toBe(0);
    expect(parsed.segments).toEqual([
      { start: 0, end: 6, text: "Ready.", pauseAfterSec: 1.5 },
      { start: 28, end: 32, text: "Set.", pauseAfterSec: 0.5 },
      { start: 46, end: 49, text: "Go!", pauseAfterSec: null },
    ]);
    for (const segment of parsed.segments) {
      expect(text.slice(segment.start, segment.end)).toBe(segment.text);
    }
    expect(parsed.breaks).toHaveLength(2);
  });

  it("adds up adjacent tags and clamps the sum", () => {
    expect(parseSpeechBreaks("A [pause 1s] [pause 2s]\n<break time=\"500ms\"/> B").segments[0].pauseAfterSec).toBe(3.5);
    expect(parseSpeechBreaks("A [pause 8s][pause 8s] B").segments[0].pauseAfterSec).toBe(MAX_BREAK_SEC);
  });

  it("keeps a pause before any text as a leading pause", () => {
    const parsed = parseSpeechBreaks("[pause 1s] [pause 9.5s]  Hello");
    expect(parsed.leadingPauseSec).toBe(MAX_BREAK_SEC);
    expect(parsed.segments).toEqual([{ start: 25, end: 30, text: "Hello", pauseAfterSec: null }]);
  });

  it("handles text without tags and empty text", () => {
    expect(parseSpeechBreaks("  Just text. ")).toEqual({
      segments: [{ start: 2, end: 12, text: "Just text.", pauseAfterSec: null }],
      breaks: [],
      leadingPauseSec: 0,
    });
    expect(parseSpeechBreaks("   ")).toEqual({ segments: [], breaks: [], leadingPauseSec: 0 });
  });

  it("keeps a trailing tag's pause on the last segment", () => {
    expect(parseSpeechBreaks("End. [pause 2s]").segments).toEqual([
      { start: 0, end: 4, text: "End.", pauseAfterSec: 2 },
    ]);
  });
});

describe("stripSpeechBreakMarkup", () => {
  it.each([
    ['Wait <break time="1s"/> then go.', "Wait then go."],
    ["Wait[pause 1s]then go.", "Wait then go."],
    ["[pause 1s] Start", "Start"],
    ["End [pause]", "End"],
    ["Line one. [pause 1s]\nLine two.", "Line one.\nLine two."],
    ["One\n<break/> two", "One\ntwo"],
    ["No tags [here] <b>bold</b>.", "No tags [here] <b>bold</b>."],
    ["Plain text", "Plain text"],
  ])("turns %j into %j", (input, expected) => {
    expect(stripSpeechBreakMarkup(input)).toBe(expected);
  });
});

describe("chunkWithSpeechBreaks", () => {
  it("forces a boundary at each tag and puts the explicit pause on the last chunk before it", () => {
    const text = 'First line. <break time="2s"/> Second line. [pause 750ms] Third.';
    const result = chunkWithSpeechBreaks(text, wholeChunk);
    expect(result.leadingPauseSec).toBe(0);
    expect(result.chunks.map((chunk) => [chunk.text, text.slice(chunk.start, chunk.end), chunk.pauseAfterSec, chunk.breakPauseSec]))
      .toEqual([
        ["First line.", "First line.", 2, 2],
        ["Second line.", "Second line.", 0.75, 0.75],
        ["Third.", "Third.", 0, undefined],
      ]);
  });

  it("runs the engine chunker per segment and shifts offsets into the source", () => {
    const text = "One. Two. Three. [pause 1s] Four. Five.";
    const result = chunkWithSpeechBreaks(text, (segment) => chunkTextForModelDetailed(segment, "supertonic"));
    for (const chunk of result.chunks) {
      expect(text.slice(chunk.start, chunk.end)).toBe(chunk.text);
      expect(chunk.text).not.toMatch(/pause/);
    }
    const beforeBreak = result.chunks.filter((chunk) => chunk.end <= text.indexOf("[pause"));
    expect(beforeBreak.at(-1)).toMatchObject({ pauseAfterSec: 1, breakPauseSec: 1 });
    expect(beforeBreak.slice(0, -1).every((chunk) => chunk.breakPauseSec === undefined)).toBe(true);
  });

  it("carries the pause of a segment with nothing to speak", () => {
    const speakable = (segment: string) => (/\p{L}/u.test(segment) ? wholeChunk(segment) : []);
    const result = chunkWithSpeechBreaks("Hi. [pause 1s] ... [pause 2s] there", speakable);
    expect(result.chunks.map((chunk) => [chunk.text, chunk.pauseAfterSec, chunk.breakPauseSec])).toEqual([
      ["Hi.", 3, 3],
      ["there", 0, undefined],
    ]);
  });

  it("adds the pause of unspeakable text before any chunk to the leading pause", () => {
    const result = chunkWithSpeechBreaks("[pause 1s] ... [pause 2s] Go", (segment) => (
      /\p{L}/u.test(segment) ? wholeChunk(segment) : []
    ));
    expect(result.leadingPauseSec).toBe(3);
    expect(result.chunks.map((chunk) => chunk.text)).toEqual(["Go"]);
  });
});
