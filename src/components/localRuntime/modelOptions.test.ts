import { describe, expect, it } from "vitest";
import { getQwen3Profiles } from "../../../electron/qwen3Profiles";
import { QWEN3_SPEAKER_OPTIONS, qwen3SupportsInstruct } from "./modelOptions";

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

describe("qwen3SupportsInstruct", () => {
  it("offers instructions only where the engine conditions on them", () => {
    const profiles = [
      ...getQwen3Profiles("darwin", "arm64"),
      ...getQwen3Profiles("win32", "x64"),
    ];
    expect(profiles.length).toBeGreaterThan(0);
    for (const profile of profiles) {
      const expected = profile.mode === "voiceDesign"
        || (profile.mode === "customVoice" && profile.parameters !== "0.6B");
      expect(qwen3SupportsInstruct(profile.repo), profile.repo).toBe(expected);
    }
  });
});
