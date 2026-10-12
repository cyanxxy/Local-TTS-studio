import { describe, expect, it } from "vitest";
import type { VoicePreset } from "../voiceLibrary/types";
import {
  DialogueCastingError,
  autoCastSpeakers,
  findUncastSpeakers,
  groupStepsByEngine,
  planDialogueRender,
} from "./plan";
import { parseDialogueScript } from "./script";

const heart: VoicePreset = { engineId: "kokoro", voiceId: "af_heart", settings: { speed: 1 } };
const adam: VoicePreset = { engineId: "kokoro", voiceId: "am_adam", settings: {} };
const qwen: VoicePreset = { engineId: "qwen3", voiceId: "Ryan", settings: { seed: 7 } };

describe("dialogue casting", () => {
  const script = parseDialogueScript("Alice: Hi.\nBob: Hey.\nCarol: Yo.");

  it("lists speakers without a voice", () => {
    expect(findUncastSpeakers(script, { alice: heart }).map((speaker) => speaker.name)).toEqual(["Bob", "Carol"]);
    // Inherited object keys never count as casting.
    expect(findUncastSpeakers(parseDialogueScript("toString: hi"), {})).toHaveLength(1);
  });

  it("keeps existing choices, prefers unused voices and drops stale speakers", () => {
    const cast = autoCastSpeakers(script, { bob: heart, dave: qwen }, [heart, adam]);
    expect(cast).toEqual({ alice: adam, bob: heart, carol: heart });
    expect(autoCastSpeakers(script, { alice: qwen }, [])).toEqual({ alice: qwen });
  });
});

describe("planDialogueRender", () => {
  it("orders turns with speaker-change and same-speaker gaps", () => {
    const script = parseDialogueScript("Alice: One.\n\nTwo.\nBob: Three.\nAlice: Four.");
    const plan = planDialogueRender(script, { alice: heart, bob: qwen });
    expect(plan.steps).toEqual([
      { turnIndex: 0, speaker: "Alice", speakerKey: "alice", text: "One.", preset: heart, gapBeforeSec: 0 },
      { turnIndex: 1, speaker: "Alice", speakerKey: "alice", text: "Two.", preset: heart, gapBeforeSec: 0.2 },
      { turnIndex: 2, speaker: "Bob", speakerKey: "bob", text: "Three.", preset: qwen, gapBeforeSec: 0.35 },
      { turnIndex: 3, speaker: "Alice", speakerKey: "alice", text: "Four.", preset: heart, gapBeforeSec: 0.35 },
    ]);
    expect(plan.totalGapSec).toBe(0.9);
    const custom = planDialogueRender(script, { alice: heart, bob: qwen }, { speakerChangeGapSec: 1, sameSpeakerGapSec: 0 });
    expect(custom.steps.map((step) => step.gapBeforeSec)).toEqual([0, 0, 1, 1]);
    expect(planDialogueRender(parseDialogueScript(""), {})).toEqual({ steps: [], totalGapSec: 0 });
  });

  it("rejects uncast speakers and out-of-range gaps", () => {
    const script = parseDialogueScript("Alice: One.\nBob: Two.");
    let caught: unknown;
    try {
      planDialogueRender(script, { alice: heart });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DialogueCastingError);
    expect((caught as DialogueCastingError).message).toBe("Choose a voice for Bob.");
    expect((caught as DialogueCastingError).missingSpeakers.map((speaker) => speaker.key)).toEqual(["bob"]);
    const cast = { alice: heart, bob: qwen };
    expect(() => planDialogueRender(script, cast, { speakerChangeGapSec: -1 })).toThrow(/between speakers must be between 0 and 5/);
    expect(() => planDialogueRender(script, cast, { sameSpeakerGapSec: Number.NaN })).toThrow(/within a speaker/);
    expect(() => planDialogueRender(script, cast, { sameSpeakerGapSec: 5.1 })).toThrow(/within a speaker/);
  });

  it("groups consecutive steps by engine", () => {
    const script = parseDialogueScript("A: 1\nB: 2\nC: 3\nA: 4");
    const plan = planDialogueRender(script, { a: heart, b: adam, c: qwen });
    expect(groupStepsByEngine(plan.steps).map((run) => [run.engineId, run.steps.map((step) => step.text)])).toEqual([
      ["kokoro", ["1", "2"]],
      ["qwen3", ["3"]],
      ["kokoro", ["4"]],
    ]);
    expect(groupStepsByEngine([])).toEqual([]);
  });
});
