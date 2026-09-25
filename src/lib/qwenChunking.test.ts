import { describe, expect, it } from "vitest";
import {
  MAX_LOCAL_TTS_TEXT_LENGTH,
  countUnicodeScalars,
} from "../../electron/localTtsLimits";
import {
  buildQwen3RequestPlan,
  buildQwen3RequestSections,
  buildQwen3TextUnits,
  QWEN3_UNIT_MAX_CHARS,
} from "./qwenChunking";

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

  // rust/local-tts-bridge/src/qwen3/text.rs pins the same fixtures in
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
