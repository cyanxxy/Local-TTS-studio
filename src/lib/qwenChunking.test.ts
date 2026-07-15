import { describe, expect, it } from "vitest";
import { buildQwen3TextUnits, QWEN3_UNIT_MAX_CHARS } from "./qwenChunking";

describe("buildQwen3TextUnits", () => {
  it("mirrors Rust boundaries and preserves exact source ranges", () => {
    const text = "  First sentence.  Second clause, then more text.  ";
    const units = buildQwen3TextUnits(text);

    expect(units.map((unit) => unit.text).join("")).toBe(text.trim());
    for (const unit of units) {
      expect(text.slice(unit.start, unit.end)).toBe(unit.text);
    }
  });

  it("uses the last boundary within each 400-code-point window", () => {
    const first = `${"a".repeat(120)}.`;
    const text = `${first}${"b".repeat(320)}:${"c".repeat(50)}`;
    const units = buildQwen3TextUnits(text);

    expect(units[0].text).toBe(first);
    expect(units.every((unit) => Array.from(unit.text).length <= QWEN3_UNIT_MAX_CHARS)).toBe(true);
    expect(units.map((unit) => unit.text).join("")).toBe(text);
  });

  it("counts Unicode code points while returning UTF-16 offsets", () => {
    const text = `  ${"🙂".repeat(400)}tail  `;
    const units = buildQwen3TextUnits(text);

    expect(units).toHaveLength(2);
    expect(Array.from(units[0].text)).toHaveLength(400);
    expect(text.slice(units[0].start, units[0].end)).toBe(units[0].text);
    expect(units.map((unit) => unit.text).join("")).toBe(text.trim());
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
});
