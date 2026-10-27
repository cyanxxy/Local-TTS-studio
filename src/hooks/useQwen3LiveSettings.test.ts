import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Qwen3RuntimeSettings } from "../contexts/Qwen3RuntimeContext";
import { useQwen3LiveSettings } from "./useQwen3LiveSettings";

const settings = {
  profile: { repo: "Qwen/Qwen3-TTS", mode: "customVoice" },
  modelPath: "/models/qwen3",
  readiness: "verified",
  speaker: "Aiden",
  language: "English",
  instruct: "",
  temperature: 0.9,
  topK: 50,
  maxNewTokens: 384,
  seed: null,
  referenceAudioName: "",
  referenceAudioBase64: null,
  referenceAudioSignature: "",
  referenceAudioDurationSec: null,
  referenceText: "",
} as unknown as Qwen3RuntimeSettings;

describe("useQwen3LiveSettings", () => {
  it("keeps one object while only the provider's other state changes", () => {
    // The provider value: the settings plus a download's progress.
    const { result, rerender } = renderHook((runtime: Qwen3RuntimeSettings) => useQwen3LiveSettings(runtime), {
      initialProps: { ...settings, downloadProgress: { percent: 10 } } as Qwen3RuntimeSettings,
    });
    const first = result.current;

    rerender({ ...settings, downloadProgress: { percent: 11 } } as Qwen3RuntimeSettings);
    expect(result.current).toBe(first);
    expect(result.current).toEqual(settings);
    expect(result.current).not.toHaveProperty("downloadProgress");

    rerender({ ...settings, speaker: "Ryan" });
    expect(result.current).not.toBe(first);
    expect(result.current.speaker).toBe("Ryan");
  });
});
