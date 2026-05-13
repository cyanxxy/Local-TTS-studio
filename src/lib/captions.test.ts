import { describe, expect, it } from "vitest";
import { buildCaptionJson, buildSrt, buildVtt, type CaptionSegment } from "./captions";

const segments: CaptionSegment[] = [
  { startSec: 0, endSec: 1.5, text: "Hello world" },
  { startSec: 1.5, endSec: 3.2, text: "This is a test" },
];

describe("captions export", () => {
  it("builds SRT captions", () => {
    const srt = buildSrt(segments);
    expect(srt).toContain("1\n00:00:00,000 --> 00:00:01,500\nHello world");
    expect(srt).toContain("2\n00:00:01,500 --> 00:00:03,200\nThis is a test");
  });

  it("builds VTT captions", () => {
    const vtt = buildVtt(segments);
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(vtt).toContain("00:00:00.000 --> 00:00:01.500");
    expect(vtt).toContain("00:00:01.500 --> 00:00:03.200");
  });

  it("builds JSON captions with estimated word timings", () => {
    const json = buildCaptionJson(segments);
    const parsed = JSON.parse(json) as {
      version: number;
      segments: Array<{ id: number; words: Array<{ word: string }> }>;
    };
    expect(parsed.version).toBe(1);
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.segments[0].words.map((word) => word.word)).toEqual(["Hello", "world"]);
  });
});
