import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CREATOR_PRESETS, DEFAULT_TARGET_LUFS, DEFAULT_TRUE_PEAK_DB } from "../constants";
import type { CreatorState } from "../lib/appState";
import { useCreatorSettings } from "./useCreatorSettings";

const INITIAL_STATE: CreatorState = {
  preset: "youtube-long",
  speed: 0.98,
  pauseCommaSec: 0.14,
  pauseSentenceSec: 0.24,
  pauseParagraphSec: 0.44,
  pronunciationLexicon: "GIF => jif",
  exportFormat: "wav-pcm24",
  exportSampleRate: 48000,
  exportBitrateKbps: 320,
  masteringEnabled: true,
};

describe("useCreatorSettings", () => {
  it("derives generation and export settings from state", () => {
    const { result } = renderHook(() => useCreatorSettings({ initialState: INITIAL_STATE, quality: 7 }));

    expect(result.current.generationSettings).toEqual({
      speed: 0.98,
      quality: 7,
      pauseOverridesSec: {
        comma: 0.14,
        sentence: 0.24,
        paragraph: 0.44,
        none: 0,
      },
      pronunciationRules: [{ from: "GIF", to: "jif" }],
    });
    expect(result.current.exportOptions).toEqual({
      format: "wav-pcm24",
      sampleRate: 48000,
      bitrateKbps: 320,
      mastering: {
        enabled: true,
        targetLufs: DEFAULT_TARGET_LUFS,
        truePeakDb: DEFAULT_TRUE_PEAK_DB,
      },
    });
  });

  it("applies presets and marks manual changes as custom", () => {
    const { result } = renderHook(() => useCreatorSettings({ initialState: INITIAL_STATE, quality: 5 }));

    act(() => {
      result.current.onCreatorPresetChange("tiktok-voiceover");
    });

    expect(result.current.creatorPreset).toBe("tiktok-voiceover");
    expect(result.current.speed).toBe(CREATOR_PRESETS["tiktok-voiceover"].speed);
    expect(result.current.exportOptions.format).toBe("mp3");

    act(() => {
      result.current.onSpeedChange(1.1);
      result.current.onPauseCommaChange(0.2);
      result.current.onPauseSentenceChange(0.3);
      result.current.onPauseParagraphChange(0.4);
      result.current.onPronunciationLexiconChange("SQL => sequel");
      result.current.onExportFormatChange("wav-pcm16");
      result.current.onExportSampleRateChange("source");
      result.current.onExportBitrateChange(192);
      result.current.onMasteringEnabledChange(false);
    });

    expect(result.current.creatorPreset).toBe("custom");
    expect(result.current.persistedState).toMatchObject({
      preset: "custom",
      speed: 1.1,
      pauseCommaSec: 0.2,
      pauseSentenceSec: 0.3,
      pauseParagraphSec: 0.4,
      pronunciationLexicon: "SQL => sequel",
      exportFormat: "wav-pcm16",
      exportSampleRate: "source",
      exportBitrateKbps: 192,
      masteringEnabled: false,
    });
  });

  it("does not reset values when selecting the custom preset directly", () => {
    const { result } = renderHook(() => useCreatorSettings({ initialState: INITIAL_STATE, quality: 5 }));

    act(() => {
      result.current.onCreatorPresetChange("custom");
    });

    expect(result.current.creatorPreset).toBe("custom");
    expect(result.current.speed).toBe(INITIAL_STATE.speed);
  });
});
