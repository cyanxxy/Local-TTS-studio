import { describe, expect, it } from "vitest";
import type { TextDiffPart } from "../text/textEdits";
import { acxCompliance, condenseDiff, formatDb, formatEstimate } from "./display";

describe("formatEstimate", () => {
  it("formats minutes and hours", () => {
    expect(formatEstimate(0)).toBe("0:00");
    expect(formatEstimate(65.4)).toBe("1:05");
    expect(formatEstimate(3725)).toBe("1:02:05");
    expect(formatEstimate(-3)).toBe("0:00");
  });
});

describe("condenseDiff", () => {
  const equal = (text: string): TextDiffPart => ({ type: "equal", text, sourceStart: 0 });
  const removed = (text: string): TextDiffPart => ({ type: "removed", text, sourceStart: 0 });
  const inserted = (text: string): TextDiffPart => ({ type: "inserted", text, sourceStart: 0 });
  const long = "x".repeat(100);

  it("keeps short text whole and trims the sides of long text that touch a change", () => {
    expect(condenseDiff([equal("short "), removed("[1]"), equal(" tail")]).shown).toEqual([
      { type: "equal", text: "short " },
      { type: "removed", text: "[1]" },
      { type: "equal", text: " tail" },
    ]);

    const { shown } = condenseDiff([equal(long), removed("a"), equal(long), inserted("b"), equal(long)]);
    expect(shown.map((part) => part.text)).toEqual([
      `… ${"x".repeat(24)}`,
      "a",
      `${"x".repeat(24)} … ${"x".repeat(24)}`,
      "b",
      `${"x".repeat(24)} …`,
    ]);
  });

  it("starts a change at the beginning of the script and treats a removal with its replacement as one", () => {
    const { shown, hiddenChanges } = condenseDiff([removed("a"), inserted("b"), equal(" rest")]);
    expect(shown.map((part) => part.type)).toEqual(["removed", "inserted", "equal"]);
    expect(hiddenChanges).toBe(0);
  });

  it("shows the first twelve changes and counts the rest", () => {
    const parts: TextDiffPart[] = [];
    for (let index = 0; index < 15; index += 1) parts.push(removed(`r${index}`), equal(" "));
    parts.push(removed("last"), inserted("swap"));
    const { shown, hiddenChanges } = condenseDiff(parts);
    expect(shown.filter((part) => part.type === "removed")).toHaveLength(12);
    expect(hiddenChanges).toBe(4);
    expect(condenseDiff([equal(long)]).shown).toEqual([{ type: "equal", text: `${"x".repeat(24)} …` }]);
  });
});

describe("formatDb", () => {
  it("writes a signed value with one decimal and a real minus sign", () => {
    expect(formatDb(2.04, "dB")).toBe("+2.0 dB");
    expect(formatDb(-20.26, "dBFS")).toBe("−20.3 dBFS");
    expect(formatDb(0, "dB")).toBe("0.0 dB");
    expect(formatDb(Number.NEGATIVE_INFINITY, "dB")).toBe("silent");
  });
});

describe("acxCompliance", () => {
  it("passes audio inside the RMS window with peaks below -3 dBFS", () => {
    expect(acxCompliance({ rmsDbfs: -20, samplePeakDbfs: -3.5 })).toEqual({ ok: true, text: "Meets the ACX loudness and peak limits. The noise floor (-60 dB RMS) is not checked." });
  });

  it("names every limit that is missed", () => {
    expect(acxCompliance({ rmsDbfs: -16, samplePeakDbfs: -3.5 })).toEqual({
      ok: false,
      text: "Outside the ACX limits: RMS −16.0 dBFS is outside −23 to −18 dBFS. The noise floor (-60 dB RMS) is not checked.",
    });
    expect(acxCompliance({ rmsDbfs: -25, samplePeakDbfs: -1 }).text)
      .toBe("Outside the ACX limits: RMS −25.0 dBFS is outside −23 to −18 dBFS; peak −1.0 dBFS is above −3 dBFS. The noise floor (-60 dB RMS) is not checked.");
    expect(acxCompliance({ rmsDbfs: -20, samplePeakDbfs: -2 }).text).toBe("Outside the ACX limits: peak −2.0 dBFS is above −3 dBFS. The noise floor (-60 dB RMS) is not checked.");
  });
});
