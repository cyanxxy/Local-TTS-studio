import { describe, expect, it } from "vitest";
import { DIALOGUE_SCRIPT_LIMITS, dialogueSpeakerKey, parseDialogueScript } from "./script";

function spoken(source: string): Array<[string, string]> {
  return parseDialogueScript(source).turns.map((turn) => [turn.speaker, turn.text]);
}

describe("parseDialogueScript", () => {
  it("parses labelled turns, continuation lines and source offsets", () => {
    const source = "Alice: Did you hear that?\nBob:   It came from\n  the attic.\r\n";
    const script = parseDialogueScript(source);
    expect(script.turns).toEqual([
      { index: 0, speaker: "Alice", speakerKey: "alice", text: "Did you hear that?", tags: [], directions: [], line: 1, start: 7, end: 25 },
      { index: 1, speaker: "Bob", speakerKey: "bob", text: "It came from the attic.", tags: [], directions: [], line: 2, start: 33, end: 58 },
    ]);
    expect(source.slice(script.turns[1].start, script.turns[1].end)).toBe("It came from\n  the attic.");
    expect(script.speakers).toEqual([
      { key: "alice", name: "Alice", turnCount: 1 },
      { key: "bob", name: "Bob", turnCount: 1 },
    ]);
    expect(script.issues).toEqual([]);
  });

  it("matches speakers case-insensitively and keeps the first spelling", () => {
    const script = parseDialogueScript("Dr. Jane  Smith: Hi.\nDR. JANE SMITH: Again.\nJosé: Hola.");
    expect(script.turns.map((turn) => turn.speaker)).toEqual(["Dr. Jane Smith", "Dr. Jane Smith", "José"]);
    expect(script.speakers[0]).toEqual({ key: "dr. jane smith", name: "Dr. Jane Smith", turnCount: 2 });
    expect(dialogueSpeakerKey("  ＢＯＢ ")).toBe("bob");
  });

  it("does not treat times, URLs, long phrases or missing spaces as labels", () => {
    expect(spoken([
      "At 10:30 we left.",
      "See https://example.com: it works.",
      "This is far too many words: to be a name.",
      "Ratio:3",
      "12 Monkeys: a film",
    ].join("\n"))).toEqual([[
      "Narrator",
      "At 10:30 we left. See https://example.com: it works. This is far too many words: to be a name. Ratio:3 12 Monkeys: a film",
    ]]);
    const longName = "A".repeat(DIALOGUE_SCRIPT_LIMITS.maxSpeakerNameLength + 1);
    expect(spoken(`${longName}: hi`)[0][0]).toBe("Narrator");
  });

  it("records tags and leading stage directions without speaking them", () => {
    const script = parseDialogueScript("Bob [whispering] [ slow ]: (leaning in) [scared] It's (I think) here [gasps].");
    expect(script.turns[0]).toMatchObject({
      text: "It's (I think) here .",
      tags: ["whispering", "slow", "scared", "gasps"],
      directions: ["leaning in"],
    });
    expect(parseDialogueScript("Ann: [] () Hello").turns[0]).toMatchObject({ text: "Hello", tags: [], directions: [] });
  });

  it("splits turns at blank lines and whole-line cues, continuing the last speaker", () => {
    const script = parseDialogueScript([
      "Alice: First.",
      "",
      "Second paragraph.",
      "(a long pause) [music]",
      "Third.",
      "Bob: Reply.",
    ].join("\n"));
    expect(script.turns.map((turn) => [turn.speaker, turn.text, turn.directions, turn.tags])).toEqual([
      ["Alice", "First.", [], []],
      ["Alice", "Second paragraph.", [], []],
      ["Alice", "Third.", ["a long pause"], ["music"]],
      ["Bob", "Reply.", [], []],
    ]);
    expect(script.speakers[0].turnCount).toBe(3);
  });

  it("gives leading narration to the default speaker", () => {
    expect(spoken("Once upon a time.\nAlice: Hello.")).toEqual([["Narrator", "Once upon a time."], ["Alice", "Hello."]]);
    expect(parseDialogueScript("Intro.", { defaultSpeaker: "  Host " }).turns[0].speaker).toBe("Host");
    expect(parseDialogueScript("Intro.", { defaultSpeaker: "   " }).turns[0].speaker).toBe("Narrator");
  });

  it("skips turns with nothing to say and carries their cues forward", () => {
    const script = parseDialogueScript("Alice: [laughs] (shrugs)\nBob: Fine.\n(exit)\n\n");
    expect(script.turns).toHaveLength(1);
    expect(script.turns[0]).toMatchObject({ speaker: "Bob", index: 0, tags: ["laughs"], directions: ["shrugs"] });
    expect(script.issues).toEqual([{ line: 1, message: "Alice has no spoken text here, so the line is skipped." }]);
    // A speaker whose only line is empty is not listed.
    expect(script.speakers.map((speaker) => speaker.name)).toEqual(["Bob"]);
    expect(parseDialogueScript("").turns).toEqual([]);
  });

  it("enforces the script, turn and speaker limits", () => {
    expect(() => parseDialogueScript("a".repeat(DIALOGUE_SCRIPT_LIMITS.maxScriptLength + 1))).toThrow(/limited to 200,000/);

    const manyTurns = Array.from({ length: DIALOGUE_SCRIPT_LIMITS.maxTurns + 2 }, (_, index) => `A: line ${index}`).join("\n");
    const turnScript = parseDialogueScript(manyTurns);
    expect(turnScript.turns).toHaveLength(DIALOGUE_SCRIPT_LIMITS.maxTurns);
    expect(turnScript.issues).toEqual([{ line: DIALOGUE_SCRIPT_LIMITS.maxTurns + 1, message: "Scripts are limited to 2000 turns; the rest is ignored." }]);

    const speakerLines = Array.from({ length: DIALOGUE_SCRIPT_LIMITS.maxSpeakers }, (_, index) => `Speaker${index}: hi`);
    const speakerScript = parseDialogueScript([
      ...speakerLines,
      "Extra: dropped",
      "still dropped",
      "",
      "dropped after a blank line",
      "Extra: dropped again",
      "Speaker0: kept",
    ].join("\n"));
    expect(speakerScript.speakers).toHaveLength(DIALOGUE_SCRIPT_LIMITS.maxSpeakers);
    expect(speakerScript.turns.at(-1)).toMatchObject({ speaker: "Speaker0", text: "kept" });
    expect(speakerScript.turns.some((turn) => turn.text.includes("dropped"))).toBe(false);
    expect(speakerScript.issues).toEqual([{ line: 33, message: "Scripts are limited to 32 speakers; Extra's lines are ignored." }]);

  });
});
