import { describe, expect, it } from "vitest";
import { chunkForKokoroDetailed, chunkForSupertonicDetailed, type TextChunk } from "./chunking";
import { chunkKittenText } from "./kittenRuntime";
import { chunkParadeeText } from "./paradeeRuntime";
import { chunkPiperText } from "./piperRuntime";
import { chunkAudio8Text } from "../models/audio8";
import { encodeSpeechBreakMark } from "./speechBreakMarks";
import {
  INACTIVE_SPEECH_PIPELINE,
  buildSpeechPlan,
  createChunkRemapper,
  describeSpeechPipeline,
  isSpeechPipelineActive,
  type RemappableChunk,
  type SpeechPipelineSettings,
} from "./speechPipeline";

const SAMPLE_RATE = 1000;

function chunk(overrides: Partial<RemappableChunk> & { samples?: number } = {}): RemappableChunk {
  const { samples = 100, ...rest } = overrides;
  return {
    audio: new Float32Array(samples).fill(0.5),
    samplingRate: SAMPLE_RATE,
    text: "",
    ...rest,
  };
}

/** A chunk whose audio ends in `pauseAfterSec` of appended silence, like an engine produces. */
function chunkWithPause(textStart: number, textEnd: number, pauseAfterSec: number, speechSamples = 100): RemappableChunk {
  const audio = new Float32Array(speechSamples + Math.round(pauseAfterSec * SAMPLE_RATE));
  audio.fill(0.5, 0, speechSamples);
  return { audio, samplingRate: SAMPLE_RATE, text: "spoken", textStart, textEnd, pauseAfterSec };
}

const rules = (...pairs: Array<[string, string]>): SpeechPipelineSettings => ({
  ...INACTIVE_SPEECH_PIPELINE,
  rules: pairs.map(([from, to]) => ({ from, to })),
});

describe("buildSpeechPlan", () => {
  it("passes text that needs nothing through untouched", () => {
    const source = "  Plain text. \n";
    const plan = buildSpeechPlan(source, INACTIVE_SPEECH_PIPELINE);

    expect(plan.identity).toBe(true);
    expect(plan.spoken).toBe(source);
    expect(plan.toSourceRange({ start: -3, end: 4 })).toEqual({ start: 0, end: 4 });
    expect(plan.toSourceRange({ start: 99, end: 100 })).toEqual({ start: source.length, end: source.length });
    const mapped = chunk({ textStart: 2, textEnd: 5 });
    expect(createChunkRemapper(plan).map(mapped)).toBe(mapped);
    expect(isSpeechPipelineActive(INACTIVE_SPEECH_PIPELINE)).toBe(false);
  });

  it("applies the dictionary and maps chunk ranges back to the written text", () => {
    const source = "Read the GIF and the SQL docs.";
    const plan = buildSpeechPlan(source, rules(["GIF", "jif"], ["SQL", "sequel"]));

    expect(plan.spoken).toBe("Read the jif and the sequel docs.");
    expect(plan.identity).toBe(false);
    const remapped = createChunkRemapper(plan).map(chunk({ textStart: 9, textEnd: 33, text: plan.spoken.slice(9, 33) }));
    expect(remapped.text).toBe("GIF and the SQL docs.");
    expect({ start: remapped.textStart, end: remapped.textEnd }).toEqual({ start: 9, end: 30 });
  });

  it("normalizes English only where the language has a normalizer", () => {
    const settings: SpeechPipelineSettings = { ...INACTIVE_SPEECH_PIPELINE, normalize: true };
    expect(buildSpeechPlan("It cost $5.", settings).spoken).toBe("It cost five dollars.");
    expect(buildSpeechPlan("It cost $5.", { ...settings, language: "en-GB" }).spoken).toBe("It cost five dollars.");
    expect(buildSpeechPlan("It cost $5.", { ...settings, language: "fr" }).identity).toBe(true);
    expect(isSpeechPipelineActive({ ...settings, language: "fr" })).toBe(false);
    expect(isSpeechPipelineActive(settings)).toBe(true);
  });

  it("cleans the text before the dictionary reads it", () => {
    const settings: SpeechPipelineSettings = { ...rules(["NASA", "nassa"]), cleanup: true };
    const source = "NASA [1] launched   today.";
    const plan = buildSpeechPlan(source, settings);

    expect(plan.spoken).toBe("nassa launched today.");
    const range = plan.toSourceRange({ start: 0, end: plan.spoken.length });
    expect(range).toEqual({ start: 0, end: source.length });
  });

  it("limits cleanup to the chosen actions", () => {
    const settings: SpeechPipelineSettings = { ...INACTIVE_SPEECH_PIPELINE, cleanup: true, cleanupActions: ["citations"] };
    expect(buildSpeechPlan("Fact [1]  here.", settings).spoken).toBe("Fact  here.");
  });

  it("turns break tags into blank-line boundaries and records their lengths", () => {
    const source = 'Hello there. <break time="1.5s"/> Next part.';
    const plan = buildSpeechPlan(source, INACTIVE_SPEECH_PIPELINE);

    expect(plan.spoken).toBe("Hello there.\n\nNext part.");
    expect(plan.breaks).toEqual([{ start: 12, end: 14, seconds: 1.5 }]);
    expect(plan.leadingPauseSec).toBe(0);
    expect(plan.toSourceRange({ start: 0, end: 12 })).toEqual({ start: 0, end: 12 });
    expect(plan.toSourceRange({ start: 14, end: 24 })).toEqual({ start: 34, end: 44 });
  });

  it("applies rules inside each piece and keeps piece offsets exact", () => {
    const source = "GIF one.[pause 2s]GIF two.";
    const plan = buildSpeechPlan(source, rules(["GIF", "jif"]));

    expect(plan.spoken).toBe("jif one.\n\njif two.");
    const second = plan.toSourceRange({ start: 10, end: 18 });
    expect(source.slice(second.start, second.end)).toBe("GIF two.");
    const first = plan.toSourceRange({ start: 0, end: 8 });
    expect(source.slice(first.start, first.end)).toBe("GIF one.");
  });

  it("maps written ranges to spoken ones and back", () => {
    const source = 'GIF one.<break time="1s"/>Costs $5 today.';
    const plan = buildSpeechPlan(source, { ...rules(["GIF", "jif"]), normalize: true });

    expect(plan.spoken).toBe("jif one.\n\nCosts five dollars today.");
    const first = plan.toSpokenRange({ start: 0, end: 8 });
    expect(plan.spoken.slice(first.start, first.end)).toBe("jif one.");
    const second = plan.toSpokenRange({ start: 26, end: source.length });
    expect(plan.spoken.slice(second.start, second.end)).toBe("Costs five dollars today.");
    // Past the end of the text and before the start of a piece.
    expect(plan.toSpokenRange({ start: 8, end: 9 }).start).toBe(8);
    expect(plan.toSpokenRange({ start: 0, end: 500 }).end).toBe(plan.spoken.length);
    expect(buildSpeechPlan('<break time="1s"/>', INACTIVE_SPEECH_PIPELINE).toSpokenRange({ start: 0, end: 2 }))
      .toEqual({ start: 0, end: 0 });
    expect(buildSpeechPlan("abc", INACTIVE_SPEECH_PIPELINE).toSpokenRange({ start: 1, end: 2 })).toEqual({ start: 1, end: 2 });
  });

  it("sums pauses around text that is spoken as nothing", () => {
    const source = '<break time="1s"/>Hi.<break time="2s"/><break time="3s"/>Bye.<break time="4s"/>';
    const plan = buildSpeechPlan(source, INACTIVE_SPEECH_PIPELINE);

    expect(plan.spoken).toBe("Hi.\n\nBye.\n\n");
    expect(plan.leadingPauseSec).toBe(1);
    expect(plan.breaks.map((boundary) => boundary.seconds)).toEqual([5, 4]);

    const cleaned = buildSpeechPlan("A.<break time=\"1s\"/>[1]<break time=\"2s\"/>B.", { ...INACTIVE_SPEECH_PIPELINE, cleanup: true });
    expect(cleaned.spoken).toBe("A.\n\nB.");
    expect(cleaned.breaks[0].seconds).toBe(3);
    const leading = buildSpeechPlan("[1]<break time=\"1s\"/>B.", { ...INACTIVE_SPEECH_PIPELINE, cleanup: true });
    expect(leading.spoken).toBe("B.");
    expect(leading.leadingPauseSec).toBe(1);
  });

  it("caps joined pauses at ten seconds", () => {
    const plan = buildSpeechPlan('A.<break time="8s"/><break time="8s"/>B.', INACTIVE_SPEECH_PIPELINE);
    expect(plan.breaks[0].seconds).toBe(10);
  });

  it("has nothing to map when every piece is silent", () => {
    const plan = buildSpeechPlan('<break time="1s"/>', INACTIVE_SPEECH_PIPELINE);
    expect(plan.spoken).toBe("");
    expect(plan.leadingPauseSec).toBe(1);
    expect(plan.toSourceRange({ start: 0, end: 3 })).toEqual({ start: 0, end: 0 });
  });

  it("maps offsets inside a boundary to the neighbouring text", () => {
    const source = 'One.<break time="1s"/>Two.';
    const plan = buildSpeechPlan(source, INACTIVE_SPEECH_PIPELINE);
    // "One.\n\nTwo.": offset 5 is inside the boundary.
    expect(plan.toSourceRange({ start: 5, end: 5 })).toEqual({ start: 4, end: 4 });
    expect(plan.toSourceRange({ start: 5, end: 9 })).toEqual({ start: 4, end: 25 });
    expect(plan.toSourceRange({ start: 0, end: 0 })).toEqual({ start: 0, end: 0 });
  });

  it("encodes pauses as marks for engines that merge paragraphs, and strips stray marks", () => {
    const source = `One.[pause 1.5s]Two${encodeSpeechBreakMark(3)}.`;
    const plan = buildSpeechPlan(source, INACTIVE_SPEECH_PIPELINE, "mark");

    expect(plan.spoken).toBe(`One.${encodeSpeechBreakMark(1.5)}Two.`);
    expect(plan.breaks).toEqual([{ start: 4, end: 5, seconds: 1.5 }]);
    expect(buildSpeechPlan(`A${encodeSpeechBreakMark(3)}B`, INACTIVE_SPEECH_PIPELINE, "mark").spoken).toBe("AB");
    expect(buildSpeechPlan(`A${encodeSpeechBreakMark(3)}B`, INACTIVE_SPEECH_PIPELINE).identity).toBe(true);
  });
});

describe("createChunkRemapper", () => {
  const source = 'Hello there. <break time="1.5s"/> Next part. <break time="0.25s"/>';

  it("sets the silence after a chunk that ends at a break to the requested length", () => {
    const plan = buildSpeechPlan(source, INACTIVE_SPEECH_PIPELINE);
    expect(plan.spoken).toBe("Hello there.\n\nNext part.\n\n");
    const remapper = createChunkRemapper(plan);

    const first = remapper.map(chunkWithPause(0, 12, 0.44));
    expect(first.pauseAfterSec).toBe(1.5);
    expect(first.audio).toHaveLength(100 + 1500);
    expect(first.audio[99]).toBe(0.5);
    expect(first.audio[100]).toBe(0);
    expect(first.text).toBe("Hello there.");
    expect({ start: first.textStart, end: first.textEnd }).toEqual({ start: 0, end: 12 });

    const last = remapper.map(chunkWithPause(14, 25, 0));
    expect(last.pauseAfterSec).toBe(0.25);
    expect(last.audio).toHaveLength(100 + 250);
    expect(last.text).toBe("Next part.");
  });

  it("shortens a longer engine pause to the requested one", () => {
    const plan = buildSpeechPlan('A.<break time="0.1s"/>B.', INACTIVE_SPEECH_PIPELINE);
    const mapped = createChunkRemapper(plan).map(chunkWithPause(0, 2, 0.44));
    expect(mapped.audio).toHaveLength(100 + 100);
    expect(mapped.pauseAfterSec).toBe(0.1);
  });

  it("finds the break when the chunk includes the boundary's blank line", () => {
    const plan = buildSpeechPlan('A line<break time="2s"/>B.', INACTIVE_SPEECH_PIPELINE);
    expect(plan.spoken).toBe("A line\n\nB.");
    expect(createChunkRemapper(plan).map(chunkWithPause(0, 8, 0.44)).pauseAfterSec).toBe(2);
  });

  it("treats a missing pause as no appended silence", () => {
    const plan = buildSpeechPlan('A.<break time="1s"/>B.', INACTIVE_SPEECH_PIPELINE);
    const mapped = createChunkRemapper(plan).map(chunk({ textStart: 0, textEnd: 2, text: "A.", samples: 50 }));
    expect(mapped.audio).toHaveLength(50 + 1000);
  });

  it("leaves chunks that do not end at a break alone", () => {
    const plan = buildSpeechPlan('One two three. Four.<break time="1s"/>Five.', INACTIVE_SPEECH_PIPELINE);
    const mapped = createChunkRemapper(plan).map(chunkWithPause(0, 14, 0.24));
    expect(mapped.pauseAfterSec).toBe(0.24);
    expect(mapped.audio).toHaveLength(100 + 240);
  });

  it("prepends the leading pause to the first chunk only, and again after a reset", () => {
    const plan = buildSpeechPlan('<break time="2s"/>Hello.', INACTIVE_SPEECH_PIPELINE);
    const remapper = createChunkRemapper(plan);

    const first = remapper.map(chunk({ textStart: 0, textEnd: 6, text: "Hello.", samples: 40 }));
    expect(first.audio).toHaveLength(2000 + 40);
    expect(first.audio[1999]).toBe(0);
    expect(first.audio[2000]).toBe(0.5);
    expect({ start: first.textStart, end: first.textEnd }).toEqual({ start: 18, end: 24 });
    expect(remapper.map(chunk({ textStart: 0, textEnd: 6, samples: 40 })).audio).toHaveLength(40);
    remapper.reset();
    expect(remapper.map(chunk({ textStart: 0, textEnd: 6, samples: 40 })).audio).toHaveLength(2040);
  });

  it("does not owe a leading pause when there is none", () => {
    const plan = buildSpeechPlan("GIF.", rules(["GIF", "jif"]));
    expect(createChunkRemapper(plan).map(chunk({ samples: 10 })).audio).toHaveLength(10);
  });

  it("maps a chunk without a range to the whole spoken text unchanged otherwise", () => {
    const plan = buildSpeechPlan("GIF.", rules(["GIF", "jif"]));
    const mapped = createChunkRemapper(plan).map(chunk({ text: "jif.", samples: 10 }));
    expect(mapped.text).toBe("jif.");
    expect(mapped.textStart).toBeUndefined();
  });

  it("leaves pauses to the engine for pause-mark boundaries", () => {
    const plan = buildSpeechPlan('A.<break time="1s"/>B.', INACTIVE_SPEECH_PIPELINE, "mark");
    const mapped = createChunkRemapper(plan).map(chunkWithPause(0, 2, 0));
    expect(mapped.audio).toHaveLength(100);
    expect(mapped.text).toBe("A.");
  });
});

describe("describeSpeechPipeline", () => {
  it("is undefined when nothing changes the text", () => {
    expect(describeSpeechPipeline(INACTIVE_SPEECH_PIPELINE)).toBeUndefined();
    expect(describeSpeechPipeline({ ...INACTIVE_SPEECH_PIPELINE, normalize: true, language: "fr" })).toBeUndefined();
  });

  it("changes with every setting that changes the spoken text", () => {
    const base = describeSpeechPipeline(rules(["GIF", "jif"]));
    expect(base).toBeDefined();
    expect(describeSpeechPipeline(rules(["GIF", "gif"]))).not.toBe(base);
    expect(describeSpeechPipeline({ rules: [{ from: "GIF", to: "jif", caseSensitive: true }], normalize: false, cleanup: false })).not.toBe(base);
    expect(describeSpeechPipeline({ rules: [{ from: "GIF", to: "jif", scope: "anywhere" }], normalize: false, cleanup: false })).not.toBe(base);
    expect(describeSpeechPipeline({ ...rules(["GIF", "jif"]), normalize: true })).not.toBe(base);
    expect(describeSpeechPipeline({ ...INACTIVE_SPEECH_PIPELINE, normalize: true, language: "en-GB" }))
      .not.toBe(describeSpeechPipeline({ ...INACTIVE_SPEECH_PIPELINE, normalize: true }));
    expect(describeSpeechPipeline({ ...INACTIVE_SPEECH_PIPELINE, cleanup: true }))
      .not.toBe(describeSpeechPipeline({ ...INACTIVE_SPEECH_PIPELINE, cleanup: true, cleanupActions: ["markdown"] }));
  });
});

describe("break boundaries against the engine chunkers", () => {
  const chunkers: Record<string, (text: string) => TextChunk[]> = {
    kokoro: (text) => chunkForKokoroDetailed(text, { backend: "wasm" }),
    supertonic: (text) => chunkForSupertonicDetailed(text),
    kitten: (text) => chunkKittenText(text, "wasm"),
    piper: chunkPiperText,
    paradee: chunkParadeeText,
    audio8: chunkAudio8Text,
  };

  it.each(Object.keys(chunkers))("%s ends a chunk at every break, even around very short passages", (name) => {
    const source = 'Hi.<break time="1s"/>Ok.<break time="2s"/>Yes no maybe so<break time="0.5s"/>Done';
    const plan = buildSpeechPlan(source, INACTIVE_SPEECH_PIPELINE);
    const remapper = createChunkRemapper(plan);
    const mapped = chunkers[name](plan.spoken).map((passage) => remapper.map({
      audio: new Float32Array(10),
      samplingRate: SAMPLE_RATE,
      text: passage.text,
      textStart: passage.start,
      textEnd: passage.end,
      pauseAfterSec: passage.pauseAfterSec,
    }));

    expect(mapped.map((entry) => entry.text)).toEqual(["Hi.", "Ok.", "Yes no maybe so", "Done"]);
    expect(mapped.map((entry) => entry.pauseAfterSec)).toEqual([1, 2, 0.5, 0]);
    for (const entry of mapped) expect(source.slice(entry.textStart, entry.textEnd)).toBe(entry.text);
  });
});
