import { describe, expect, it } from "vitest";
import {
  MAX_LOCAL_TTS_TEXT_LENGTH,
  countUnicodeScalars,
} from "../../electron/localTtsLimits";
import {
  buildQwen3RequestPlan,
  buildQwen3RequestSections,
  buildQwen3TextUnits,
  prepareQwen3SpeechText,
  QWEN3_UNIT_MAX_CHARS,
} from "./qwenChunking";
import { encodeSpeechBreakMark } from "./speechBreakMarks";

/** Replays the bridge on one request: IPC `trim()`, then split_text_units. */
function unitTexts(text: string): string[] {
  return buildQwen3TextUnits(text).map((unit) => unit.text);
}

describe("buildQwen3TextUnits", () => {
  it("mirrors Rust boundaries and preserves exact source ranges", () => {
    const text = "  First sentence.  Second clause, then more text.  ";
    const units = buildQwen3TextUnits(text);

    expect(units.map((unit) => unit.text).join("")).toBe(text.trim());
    for (const unit of units) {
      expect(text.slice(unit.start, unit.end)).toBe(unit.text);
    }
  });

  it("uses the last boundary within each 200-code-point window", () => {
    const first = `${"a".repeat(120)}.`;
    const text = `${first}${"b".repeat(120)}:${"c".repeat(50)}`;
    const units = buildQwen3TextUnits(text);

    expect(QWEN3_UNIT_MAX_CHARS).toBe(200);
    expect(units[0].text).toBe(first);
    expect(units.every((unit) => Array.from(unit.text).length <= QWEN3_UNIT_MAX_CHARS)).toBe(true);
    expect(units.map((unit) => unit.text).join("")).toBe(text);
  });

  it("counts Unicode code points while returning UTF-16 offsets", () => {
    const text = `  ${"🙂".repeat(200)}tail  `;
    const units = buildQwen3TextUnits(text);

    expect(units).toHaveLength(2);
    expect(Array.from(units[0].text)).toHaveLength(200);
    expect(text.slice(units[0].start, units[0].end)).toBe(units[0].text);
    expect(units.map((unit) => unit.text).join("")).toBe(text.trim());
  });

  it("preserves whole words in long clauses using Rust's whitespace set", () => {
    // Mirrored by long_clauses_preserve_words_and_unicode_whitespace in Rust.
    for (const separator of [" ", "\t", "\u0085", "\u00a0"]) {
      const first = `word${separator}`.repeat(39);
      const text = `${first}narration`;
      const units = buildQwen3TextUnits(text);
      expect(units.map((unit) => unit.text)).toEqual([first, "narration"]);
      expect(units.every((unit) => text.slice(unit.start, unit.end) === unit.text)).toBe(true);
    }
    expect(unitTexts("A short final clause")).toEqual(["A short final clause"]);
    const text = `Intro. ${"x".repeat(220)}`;
    expect(unitTexts(text)).toEqual(["Intro.", ` ${"x".repeat(199)}`, "x".repeat(21)]);
  });

  // rust/bridge-core/src/qwen3/text.rs pins the same fixtures in
  // parity_fixtures_shared_with_the_renderer and cjk_units_use_half_the_character_budget.
  it("matches the Rust splitter's fixtures", () => {
    expect(unitTexts("Hello. World")).toEqual(["Hello.", " World"]);
    expect(unitTexts("One, two; three.")).toEqual(["One, two; three."]);
    expect(unitTexts("Heading\nBody text")).toEqual(["Heading\n", "Body text"]);
    expect(unitTexts(`${"中".repeat(60)}。${"文".repeat(60)}`)).toEqual([
      `${"中".repeat(60)}。`,
      "文".repeat(60),
    ]);
    expect(unitTexts("x".repeat(450))).toEqual(["x".repeat(200), "x".repeat(200), "x".repeat(50)]);
    expect(unitTexts("你".repeat(250)).map((unit) => Array.from(unit).length)).toEqual([100, 100, 50]);
    expect(Array.from(unitTexts(`${"a".repeat(100)}${"你".repeat(100)}`)[0])).toHaveLength(150);
  });

  it("trims each request the way IPC and Rust do before splitting", () => {
    // JavaScript trim() removes U+FEFF but keeps U+0085; Rust's trim is the reverse.
    const text = "\uFEFF\u0085 Hello. World \u0085";
    const units = buildQwen3TextUnits(text);

    expect(units.map((unit) => unit.text)).toEqual(["Hello.", " World"]);
    expect(units[0].start).toBe(3);
    expect(units.every((unit) => text.slice(unit.start, unit.end) === unit.text)).toBe(true);
  });

  it("weights CJK scalars double so a unit holds at most 110 of them", () => {
    // Mirrors the Rust test: 240 copies of a five-scalar sentence whose four
    // ideographs weigh 2 and whose full stop weighs 1, so 22 sentences (110
    // scalars, weight 198) fit a unit and each unit ends on the sentence mark.
    const text = "你好世界。".repeat(240);
    const units = buildQwen3TextUnits(text);

    expect(units.map((unit) => unit.text).join("")).toBe(text);
    expect(units.every((unit) => Array.from(unit.text).length <= 110)).toBe(true);
    expect(units.every((unit) => unit.text.endsWith("。"))).toBe(true);
    expect(units.length).toBe(11);
  });

  it("does not treat punctuation inside numbers as a boundary", () => {
    // Mirrors the Rust test: with a 200 budget the sentence ends at its full
    // stop, never at the decimal point, thousands separator, or clock colon.
    const sentence = "Pi is 3.14159 and the total is 1,000 at 10:30.";
    const text = `${sentence} ${"x".repeat(190)}`;
    const units = buildQwen3TextUnits(text);

    expect(units[0].text).toBe(sentence);
    expect(units.map((unit) => unit.text).join("")).toBe(text);
  });

  it("preserves complete ranges for Reader chapters beyond the old IPC limit", () => {
    const sentence = `${"Reader narration ".repeat(20)}ends here. `;
    const text = `  ${sentence.repeat(30)}  `;
    expect(text.trim().length).toBeGreaterThan(6_000);

    const units = buildQwen3TextUnits(text);

    expect(units.map((unit) => unit.text).join("")).toBe(text.trim());
    expect(units[0].start).toBe(2);
    expect(units.at(-1)?.end).toBe(text.indexOf(text.trim()) + text.trim().length);
    expect(units.every((unit) => text.slice(unit.start, unit.end) === unit.text)).toBe(true);
    expect(units.every((unit) => Array.from(unit.text).length <= QWEN3_UNIT_MAX_CHARS)).toBe(true);
  });

  it("groups a long Reader document into ordered IPC-safe requests", () => {
    const text = `  ${`${"Narrate this Reader sentence naturally. ".repeat(12)}\n`.repeat(45)}  `;
    const { sections, units } = buildQwen3RequestPlan(text);

    expect(text.trim().length).toBeGreaterThan(MAX_LOCAL_TTS_TEXT_LENGTH * 2);
    expect(sections.length).toBeGreaterThan(2);
    expect(sections.map((section) => section.text).join("")).toBe(text.trim());
    expect(sections.every((section) => (
      countUnicodeScalars(section.text) <= MAX_LOCAL_TTS_TEXT_LENGTH
    ))).toBe(true);
    expect(sections[0].start).toBe(text.indexOf(text.trim()));
    expect(sections.at(-1)?.end).toBe(text.indexOf(text.trim()) + text.trim().length);
    expect(sections.flatMap((section) => units.slice(section.unitStart, section.unitEnd))).toEqual(units);
    for (const section of sections) {
      expect(units.slice(section.unitStart, section.unitEnd).map((unit) => unit.text))
        .toEqual(unitTexts(section.text));
    }
  });

  it("indexes each request's units exactly as the bridge splits that request", () => {
    // The second request starts with the space after "Intro.". IPC trims it,
    // so the bridge's first 200-character window reaches one character further,
    // takes the full stop instead of the comma, and cuts a different unit than
    // a whole-document split does.
    const filler = `${"Filler sentence for the reader. ".repeat(6)}\n`;
    const head = filler.repeat(Math.floor(MAX_LOCAL_TTS_TEXT_LENGTH / filler.length));
    const text = `${head}Intro. ${"a".repeat(49)},${"b".repeat(149)}.${" More text here.".repeat(20)}`;
    const { sections, units } = buildQwen3RequestPlan(text);

    expect(sections).toHaveLength(2);
    expect(text[sections[1].start]).toBe(" ");
    expect(units[sections[1].unitStart].text).toBe(`${"a".repeat(49)},${"b".repeat(149)}.`);
    expect(buildQwen3TextUnits(text)[sections[1].unitStart].text).toBe(` ${"a".repeat(49)},`);
    for (const section of sections) {
      const sectionUnits = units.slice(section.unitStart, section.unitEnd);
      expect(sectionUnits.map((unit) => unit.text)).toEqual(unitTexts(section.text));
      expect(sectionUnits.every((unit) => text.slice(unit.start, unit.end) === unit.text)).toBe(true);
    }
    expect(units.at(-1)?.pauseAfterSec).toBe(0);
    expect(units.slice(0, -1).every((unit) => unit.pauseAfterSec === 0.2)).toBe(true);
  });

  it("groups astral Unicode text by Rust-compatible scalar counts", () => {
    const text = `  ${`${"🙂".repeat(199)}. `.repeat(70)}  `;
    const sections = buildQwen3RequestSections(text);

    expect(countUnicodeScalars(text.trim())).toBeGreaterThan(MAX_LOCAL_TTS_TEXT_LENGTH * 2);
    expect(sections.length).toBeGreaterThan(2);
    expect(sections.map((section) => section.text).join("")).toBe(text.trim());
    expect(sections.every((section) => (
      countUnicodeScalars(section.text) <= MAX_LOCAL_TTS_TEXT_LENGTH
    ))).toBe(true);
  });
});

describe("buildQwen3RequestPlan pause marks", () => {
  it("is unchanged without marks", () => {
    const text = "One sentence. Another sentence.";
    expect(buildQwen3RequestPlan(text).sections).toHaveLength(1);
    expect(buildQwen3RequestPlan(text).sections[0].pauseAfterSec).toBe(0);
  });

  it("ends a request at every mark and carries the pause", () => {
    const text = `Hi.\n\nOk.${encodeSpeechBreakMark(1.5)}Yes.\n\nNo.`;
    const plan = buildQwen3RequestPlan(text);

    expect(plan.sections.map((section) => section.text)).toEqual(["Hi.\n\nOk.", "Yes.\n\nNo."]);
    expect(plan.sections.map((section) => section.pauseAfterSec)).toEqual([1.5, 0]);
    expect(plan.sections[0].pauseKind).toBe("sentence");
    expect(plan.units.map((unit) => unit.pauseAfterSec)).toEqual([1.5, 0]);
    for (const section of plan.sections) {
      expect(text.slice(section.start, section.end)).toBe(section.text);
    }
    expect(plan.sections[1]).toMatchObject({ unitStart: 1, unitEnd: 2 });
    expect(text.slice(plan.units[1].start, plan.units[1].end)).toBe("Yes.\n\nNo.");
  });

  it("adds up marks with nothing between them and keeps a trailing pause", () => {
    const text = `Hello.${encodeSpeechBreakMark(1)}${encodeSpeechBreakMark(0.5)}${encodeSpeechBreakMark(0.25)}`;
    const plan = buildQwen3RequestPlan(text);
    expect(plan.sections).toHaveLength(1);
    expect(plan.sections[0].pauseAfterSec).toBe(1.75);
    expect(buildQwen3RequestPlan(`A.${encodeSpeechBreakMark(8)}${encodeSpeechBreakMark(8)}`).sections[0].pauseAfterSec).toBe(10);
  });

  it("ignores marks before any text", () => {
    const plan = buildQwen3RequestPlan(`${encodeSpeechBreakMark(2)}Hello.`);
    expect(plan.sections).toHaveLength(1);
    expect(plan.sections[0]).toMatchObject({ text: "Hello.", pauseAfterSec: 0 });
    expect(buildQwen3RequestPlan(encodeSpeechBreakMark(2))).toEqual({ sections: [], units: [] });
  });
});

describe("prepareQwen3SpeechText", () => {
  // The start of a PDF import that made Qwen run to its token limit.
  const pdfHead = [
    "2/3/22, 9:31 PM        The Bitter Lesson",
    "The Bitter Lesson",
    "Rich Sutton",
    "March 13, 2019",
    "",
    "The biggest lesson that can be read from 70 years of AI research is that general methods that leverage",
    "computation are ultimately the most effective, and by a large margin. The ultimate reason for this is",
    "Moore's law, or rather its generalization of continued exponentially falling cost per unit of",
    "computation.",
  ].join("\n");

  it("ends heading lines and joins hard-wrapped prose", () => {
    expect(prepareQwen3SpeechText(pdfHead)).toBe(
      "2/3/22, 9:31 PM        The Bitter Lesson.The Bitter Lesson.Rich Sutton.March 13, 2019.\n"
      + "The biggest lesson that can be read from 70 years of AI research is that general methods that leverage "
      + "computation are ultimately the most effective, and by a large margin. The ultimate reason for this is "
      + "Moore's law, or rather its generalization of continued exponentially falling cost per unit of "
      + "computation.",
    );
  });

  it("keeps the length so source offsets still index the original text", () => {
    expect(prepareQwen3SpeechText(pdfHead)).toHaveLength(pdfHead.length);
    const plan = buildQwen3RequestPlan(pdfHead);
    for (const unit of plan.units) {
      expect(unit.text).toHaveLength(unit.end - unit.start);
    }
  });

  it("no longer ends the opening unit mid-sentence", () => {
    const [first] = buildQwen3RequestPlan(pdfHead).units;
    expect(first.text.trimEnd()).toMatch(/[.,]$/);
  });

  it("leaves punctuated lines, paragraph breaks and CJK lines alone", () => {
    expect(prepareQwen3SpeechText("One.\nTwo!\n\nThree?")).toBe("One.\nTwo!\n\nThree?");
    expect(prepareQwen3SpeechText("中文第一行\n第二行")).toBe("中文第一行\n第二行");
  });

  it("joins a short wrapped line that continues in lowercase or after a comma", () => {
    expect(prepareQwen3SpeechText("A short line\nthat continues.")).toBe("A short line that continues.");
    expect(prepareQwen3SpeechText("First,\nSecond.")).toBe("First, Second.");
  });

  it("is idempotent", () => {
    const once = prepareQwen3SpeechText(pdfHead);
    expect(prepareQwen3SpeechText(once)).toBe(once);
  });
});
