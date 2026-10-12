import { describe, expect, it, vi } from "vitest";
import type { PresetSynthesize, SynthesizedAudioChunk } from "../presetSynthesis";
import type { VoicePreset } from "../voiceLibrary/types";
import type { DialogueRenderStep } from "./plan";
import { planDialogueRender } from "./plan";
import {
  dialogueCuesToSrt,
  dialogueCuesToVtt,
  renderDialogue,
  renderDialogueTurn,
  replaceRenderedTurn,
  stitchDialogueTurns,
  type RenderedDialogueTurn,
} from "./render";
import { parseDialogueScript } from "./script";

const kokoro: VoicePreset = { engineId: "kokoro", voiceId: "af_heart", settings: {} };
const supertonic: VoicePreset = { engineId: "supertonic3", voiceId: "F1", settings: {} };

function step(turnIndex: number, speaker: string, gapBeforeSec: number, text = `line ${turnIndex}`): DialogueRenderStep {
  return { turnIndex, speaker, speakerKey: speaker.toLowerCase(), text, preset: kokoro, gapBeforeSec };
}

function turn(rendered: DialogueRenderStep, value: number, frames: number, sampleRate: number): RenderedDialogueTurn {
  return { step: rendered, samples: new Float32Array(frames).fill(value), sampleRate };
}

describe("stitchDialogueTurns", () => {
  it("joins turns with gaps at the highest input rate and times each cue", () => {
    const stitched = stitchDialogueTurns([
      turn(step(0, "Alice", 0), 0.5, 10, 10),
      turn(step(1, "Bob", 0.5), 0.25, 40, 20),
    ]);
    expect(stitched.sampleRate).toBe(20);
    // 10 frames at 10 Hz become 20 at 20 Hz, then 10 frames of silence.
    expect(stitched.samples).toHaveLength(70);
    expect(stitched.samples[5]).toBeCloseTo(0.5, 5);
    expect(stitched.samples[25]).toBe(0);
    expect(stitched.samples[50]).toBeCloseTo(0.25, 5);
    expect(stitched.durationSec).toBe(3.5);
    expect(stitched.cues).toEqual([
      { turnIndex: 0, speaker: "Alice", text: "line 0", startSec: 0, endSec: 1 },
      { turnIndex: 1, speaker: "Bob", text: "line 1", startSec: 1.5, endSec: 3.5 },
    ]);
  });

  it("honours a fixed output rate, ignores a gap on the first turn and handles no turns", () => {
    const stitched = stitchDialogueTurns([turn(step(3, "Alice", 0.4), 0.1, 30, 30)], { sampleRate: 10 });
    expect(stitched.samples).toHaveLength(10);
    expect(stitched.cues[0]).toMatchObject({ startSec: 0, endSec: 1 });
    expect(stitchDialogueTurns([])).toEqual({ samples: new Float32Array(0), sampleRate: 24000, durationSec: 0, cues: [] });
    expect(() => stitchDialogueTurns([], { sampleRate: 0 })).toThrow(/positive/);
  });
});

describe("dialogue captions", () => {
  const cues = [
    { turnIndex: 0, speaker: "Alice <A&B>", text: "Is 1 < 2 --> yes?", startSec: 0, endSec: 1.2345 },
    { turnIndex: 1, speaker: " Bob ", text: "  ", startSec: 1.5, endSec: 2 },
    { turnIndex: 2, speaker: "Bob", text: "Long\nline", startSec: 3723.5, endSec: 3724 },
  ];

  it("writes WebVTT voice spans with escaped text", () => {
    expect(dialogueCuesToVtt(cues)).toBe(
      "WEBVTT\n\n"
      + "00:00:00.000 --> 00:00:01.235\n<v Alice &lt;A&amp;B&gt;>Is 1 &lt; 2 --&gt; yes?\n"
      + "\n"
      + "01:02:03.500 --> 01:02:04.000\n<v Bob>Long line\n",
    );
    expect(dialogueCuesToVtt([])).toBe("WEBVTT\n\n");
  });

  it("writes SRT with speaker prefixes", () => {
    expect(dialogueCuesToSrt(cues)).toBe(
      "1\n00:00:00,000 --> 00:00:01,235\nAlice <A&B>: Is 1 < 2 --> yes?\n"
      + "\n"
      + "2\n01:02:03,500 --> 01:02:04,000\nBob: Long line\n",
    );
  });
});

function fakeSynthesize(rates: Record<string, number>): PresetSynthesize & { calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  const synthesize = async function* (text: string, preset: VoicePreset): AsyncGenerator<SynthesizedAudioChunk> {
    calls.push([text, preset.engineId]);
    const samplingRate = rates[preset.engineId];
    yield { audio: new Float32Array(samplingRate / 2).fill(0.2), samplingRate };
    yield { audio: new Float32Array(samplingRate / 2).fill(0.4), samplingRate };
  };
  return Object.assign(synthesize, { calls });
}

describe("renderDialogue", () => {
  const script = parseDialogueScript("Alice: Hello there.\nBob: General Kenobi.\nAlice: Bye.");
  const plan = planDialogueRender(script, { alice: kokoro, bob: supertonic });

  it("renders turns in order, reports progress and stitches mixed rates", async () => {
    const synthesize = fakeSynthesize({ kokoro: 24000, supertonic3: 44100 });
    const onTurnStart = vi.fn();
    const onTurnRendered = vi.fn();
    const result = await renderDialogue({ plan, synthesize, onTurnStart, onTurnRendered });
    expect(synthesize.calls).toEqual([["Hello there.", "kokoro"], ["General Kenobi.", "supertonic3"], ["Bye.", "kokoro"]]);
    expect(onTurnStart.mock.calls.map(([rendered, position, total]) => [rendered.text, position, total]))
      .toEqual([["Hello there.", 0, 3], ["General Kenobi.", 1, 3], ["Bye.", 2, 3]]);
    expect(onTurnRendered).toHaveBeenCalledTimes(3);
    expect(result.turns.map((rendered) => [rendered.sampleRate, rendered.samples.length])).toEqual([[24000, 24000], [44100, 44100], [24000, 24000]]);
    expect(result.stitched.sampleRate).toBe(44100);
    expect(result.stitched.cues.map((cue) => [cue.speaker, cue.startSec, cue.endSec])).toEqual([
      ["Alice", 0, 1],
      ["Bob", 1.35, 2.35],
      ["Alice", 2.7, 3.7],
    ]);
    const fixed = await renderDialogue({ plan, synthesize, sampleRate: 24000 });
    expect(fixed.stitched.sampleRate).toBe(24000);
  });

  it("stops on abort and keeps already rendered turns reported", async () => {
    const controller = new AbortController();
    const synthesize = fakeSynthesize({ kokoro: 24000, supertonic3: 44100 });
    const rendered: string[] = [];
    await expect(renderDialogue({
      plan,
      synthesize,
      signal: controller.signal,
      onTurnRendered: (item) => {
        rendered.push(item.step.text);
        controller.abort();
      },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(rendered).toEqual(["Hello there."]);
    expect(synthesize.calls).toHaveLength(1);
  });

  it("re-renders a single turn and swaps it into the timeline", async () => {
    const synthesize = fakeSynthesize({ kokoro: 24000, supertonic3: 44100 });
    const { turns } = await renderDialogue({ plan, synthesize });
    const retake = await renderDialogueTurn(plan.steps[1], fakeSynthesize({ kokoro: 24000, supertonic3: 22050 }), new AbortController().signal);
    const swapped = replaceRenderedTurn(turns, retake);
    expect(swapped[1]).toBe(retake);
    expect(swapped[0]).toBe(turns[0]);
    expect(stitchDialogueTurns(swapped).sampleRate).toBe(24000);
    expect(() => replaceRenderedTurn(turns, { ...retake, step: { ...retake.step, turnIndex: 99 } })).toThrow(/Turn 99/);
    const aborted = new AbortController();
    aborted.abort();
    await expect(renderDialogueTurn(plan.steps[0], synthesize, aborted.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
