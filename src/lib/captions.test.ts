import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCaptionJson,
  buildSrt,
  buildVtt,
  escapeVttText,
  layoutCaptionCues,
  type CaptionCue,
  type CaptionSegment,
} from "./captions";

const segments: CaptionSegment[] = [
  { startSec: 0, endSec: 1.5, text: "Hello world" },
  { startSec: 1.5, endSec: 3.2, text: "This is a test" },
];

/** A 506-character paragraph spoken over 34 seconds, like one long semantic segment. */
const LONG_SEGMENT: CaptionSegment = {
  startSec: 0,
  endSec: 34,
  text: [
    "Open TTS turns long scripts into natural narration without sending text to a server.",
    "Each paragraph is split into chunks that the selected engine can speak reliably, and the pauses between them follow punctuation, so commas breathe and full stops settle.",
    "When the audio is ready you can export it with captions for YouTube, TikTok or Reels, and every cue stays short enough to read comfortably on a phone screen.",
    "Long-form projects work the same way: chapters, retakes and pronunciation rules all carry through to the final file.",
    "That is the whole idea.",
  ].join(" "),
};

function cueText(cue: CaptionCue): string {
  return cue.lines.join(" ");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("layoutCaptionCues", () => {
  it("keeps short segments as single cues", () => {
    expect(layoutCaptionCues(segments)).toEqual([
      { startSec: 0, endSec: 1.5, lines: ["Hello world"] },
      { startSec: 1.5, endSec: 3.2, lines: ["This is a test"] },
    ]);
  });

  it("splits a long segment into readable cues", () => {
    expect(LONG_SEGMENT.text.length).toBeGreaterThan(500);
    const cues = layoutCaptionCues([LONG_SEGMENT]);
    expect(cues.length).toBeGreaterThan(6);
    for (const cue of cues) {
      expect(cue.lines.length).toBeLessThanOrEqual(2);
      for (const line of cue.lines) expect(line.length).toBeLessThanOrEqual(42);
      expect(cue.endSec - cue.startSec).toBeLessThanOrEqual(7);
      expect(cue.endSec).toBeGreaterThan(cue.startSec);
    }
    // Nothing is lost or reordered, and cues follow each other without overlap.
    expect(cues.map(cueText).join(" ")).toBe(LONG_SEGMENT.text);
    for (let index = 1; index < cues.length; index += 1) {
      expect(cues[index].startSec).toBeGreaterThanOrEqual(cues[index - 1].endSec - 1e-9);
    }
    expect(cues[0].startSec).toBe(0);
    expect(cues.at(-1)?.endSec).toBe(34);
  });

  it("prefers to end a cue at a sentence end", () => {
    const cues = layoutCaptionCues([{
      startSec: 0,
      endSec: 6,
      text: "This first sentence is short. The second sentence runs on for quite a while longer than the first.",
    }]);
    expect(cueText(cues[0])).toBe("This first sentence is short.");
  });

  it("falls back to a clause break, then to the last word that fits", () => {
    const clause = layoutCaptionCues([{
      startSec: 0,
      endSec: 6,
      text: "Words come first, then many more words keep arriving without any full stop at all here",
    }], { maxLines: 1 });
    expect(cueText(clause[0])).toBe("Words come first,");

    const plain = layoutCaptionCues([{ startSec: 0, endSec: 6, text: "one two three four five six seven eight nine ten" }], {
      maxCharsPerLine: 10,
      maxLines: 1,
    });
    expect(plain.map(cueText)).toEqual(["one two", "three four", "five six", "seven", "eight nine", "ten"]);
  });

  it("balances two-line cues", () => {
    const [cue] = layoutCaptionCues([{ startSec: 0, endSec: 5, text: "The quick brown fox jumps over the lazy dog today" }], {
      maxCharsPerLine: 32,
    });
    expect(cue.lines).toEqual(["The quick brown fox jumps", "over the lazy dog today"]);
  });

  it("limits cue duration", () => {
    const cues = layoutCaptionCues([{ startSec: 0, endSec: 20, text: "a b c d e f g h i j" }], { maxDurationSec: 4 });
    expect(cues.length).toBeGreaterThanOrEqual(5);
    for (const cue of cues) expect(cue.endSec - cue.startSec).toBeLessThanOrEqual(4 + 1e-9);
  });

  it("supports word-by-word captions", () => {
    const cues = layoutCaptionCues([{ startSec: 0, endSec: 4, text: "Big news today, friends" }], { maxWordsPerCue: 2 });
    expect(cues.map(cueText)).toEqual(["Big news", "today, friends"]);
  });

  it("gives a word longer than a line its own line", () => {
    const [cue] = layoutCaptionCues([{ startSec: 0, endSec: 3, text: "Supercalifragilisticexpialidocious is long" }], {
      maxCharsPerLine: 20,
    });
    expect(cue.lines).toEqual(["Supercalifragilisticexpialidocious", "is long"]);
  });

  it("holds short cues up to the minimum duration without overlapping the next or outlasting the speech", () => {
    const cues = layoutCaptionCues([
      { startSec: 0, endSec: 0.2, text: "Hi." },
      { startSec: 0.5, endSec: 1, text: "There." },
      { startSec: 1.1, endSec: 1.3, text: "End." },
    ]);
    expect(cues.map((cue) => [cue.startSec, cue.endSec])).toEqual([[0, 0.5], [0.5, 1.1], [1.1, 1.3]]);
  });

  it("falls back to defaults for invalid options", () => {
    const options = { maxCharsPerLine: 0, maxLines: Number.NaN, maxDurationSec: -1, minDurationSec: 0, maxWordsPerCue: 0.5 };
    const cues = layoutCaptionCues([{ startSec: 0, endSec: 2, text: "one two three" }], options);
    expect(cues.map(cueText)).toEqual(["one", "two", "three"]);
  });

  it("carries speakers and drops empty segments", () => {
    expect(layoutCaptionCues([
      { startSec: 0, endSec: 1, text: "Hello", speaker: "  Ada  " },
      { startSec: 1, endSec: 2, text: "   " },
      { startSec: 2, endSec: 3, text: "Bye", speaker: " " },
    ])).toEqual([
      { startSec: 0, endSec: 1, lines: ["Hello"], speaker: "Ada" },
      { startSec: 2, endSec: 3, lines: ["Bye"] },
    ]);
  });
});

describe("captions export", () => {
  it("builds SRT captions", () => {
    const srt = buildSrt(segments);
    expect(srt).toBe(
      "1\n00:00:00,000 --> 00:00:01,500\nHello world\n\n2\n00:00:01,500 --> 00:00:03,200\nThis is a test\n",
    );
  });

  it("builds VTT captions", () => {
    const vtt = buildVtt(segments);
    expect(vtt).toBe("WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nHello world\n\n00:00:01.500 --> 00:00:03.200\nThis is a test\n");
  });

  it("writes long segments as multiple wrapped cues", () => {
    const srt = buildSrt([LONG_SEGMENT]);
    const blocks = srt.trim().split("\n\n");
    expect(blocks.length).toBeGreaterThan(6);
    for (const block of blocks) {
      const [, timing, ...lines] = block.split("\n");
      expect(timing).toMatch(/^\d\d:\d\d:\d\d,\d{3} --> \d\d:\d\d:\d\d,\d{3}$/);
      expect(lines.length).toBeLessThanOrEqual(2);
    }
  });

  it("writes one unwrapped cue per segment when layout is off", () => {
    expect(buildSrt([LONG_SEGMENT], { layout: false }).split("\n")[2]).toBe(LONG_SEGMENT.text);
    expect(buildVtt([LONG_SEGMENT], { layout: false }).split("\n")[3]).toBe(LONG_SEGMENT.text);
    expect(buildVtt([{ startSec: 0, endSec: 1, text: "Hi", speaker: "Ada" }], { layout: false })).toContain("<v Ada>Hi");
  });

  it("escapes VTT payloads and speakers", () => {
    expect(escapeVttText("Fish & chips <b> a --> b")).toBe("Fish &amp; chips &lt;b&gt; a --&gt; b");
    const vtt = buildVtt([{ startSec: 0, endSec: 2, text: "Q&A: x < y --> z", speaker: "R&D <team>" }]);
    expect(vtt).toContain("<v R&amp;D &lt;team&gt;>Q&amp;A: x &lt; y --&gt; z");
    expect(vtt.split("\n").filter((line) => line.includes("-->"))).toHaveLength(1);
  });

  it("keeps SRT text from looking like a timing line and labels speakers", () => {
    const srt = buildSrt([{ startSec: 0, endSec: 2, text: "a --> b", speaker: "Max-->" }]);
    expect(srt).toBe("1\n00:00:00,000 --> 00:00:02,000\nMax->: a -> b\n");
  });

  it("formats hours and clamps negative times", () => {
    const srt = buildSrt([{ startSec: -1, endSec: 3723.4567, text: "Long" }], { layout: false });
    expect(srt).toContain("00:00:00,000 --> 01:02:03,457");
  });

  it("builds JSON captions with the shared word-timing estimator", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T03:04:05.000Z"));
    const parsed = JSON.parse(buildCaptionJson([
      { startSec: 0, endSec: 1.4, text: "Hello, world" },
      { startSec: 2, endSec: 3, text: "Next", speaker: "Ada" },
    ])) as {
      version: number;
      generatedAt: string;
      segments: Array<{ id: number; speaker?: string; words: Array<{ word: string; startSec: number; endSec: number }> }>;
    };
    expect(parsed.version).toBe(1);
    expect(parsed.generatedAt).toBe("2026-01-02T03:04:05.000Z");
    expect(parsed.segments).toHaveLength(2);
    // "Hello," weighs 5 letters plus a comma pause of 3 against "world" (5).
    expect(parsed.segments[0].words).toEqual([
      { word: "Hello,", startSec: 0, endSec: 0.862 },
      { word: "world", startSec: 0.862, endSec: 1.4 },
    ]);
    expect(parsed.segments[0]).not.toHaveProperty("speaker");
    expect(parsed.segments[1].speaker).toBe("Ada");
  });
});
