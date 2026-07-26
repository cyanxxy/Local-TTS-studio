import { describe, expect, it } from "vitest";
import { QWEN3_SPEAKER_OPTIONS } from "./modelOptions";

describe("Qwen3 speaker options", () => {
  it("puts the English default first and exposes native-language guidance", () => {
    expect(QWEN3_SPEAKER_OPTIONS.slice(0, 2)).toEqual([
      { value: "Aiden", label: "Aiden · English" },
      { value: "Ryan", label: "Ryan · English" },
    ]);
    expect(QWEN3_SPEAKER_OPTIONS).toContainEqual({
      value: "Vivian",
      label: "Vivian · Chinese",
    });
  });
});
