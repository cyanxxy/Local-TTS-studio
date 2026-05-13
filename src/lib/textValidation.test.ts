import { describe, expect, it } from "vitest";
import { getMeaningfulTextLength, hasMinimumSynthesisText } from "./textValidation";

describe("textValidation", () => {
  it("ignores leading and trailing whitespace when counting meaningful text", () => {
    expect(getMeaningfulTextLength("  hello world  ")).toBe(11);
    expect(getMeaningfulTextLength("\n\t  ")).toBe(0);
  });

  it("rejects whitespace-only scripts for generation gating", () => {
    expect(hasMinimumSynthesisText("          ", 10)).toBe(false);
    expect(hasMinimumSynthesisText("\n\nhello world\n", 10)).toBe(true);
  });
});
