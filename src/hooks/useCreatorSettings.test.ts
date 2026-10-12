import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CREATOR_PRESETS } from "../constants";
import { getCreatorPresetDefaults, type CreatorState } from "../lib/appState";
import { createPronunciationDictionary } from "../lib/pronunciation/dictionary";
import { useCreatorSettings } from "./useCreatorSettings";

const QUICK_RULES = createPronunciationDictionary({
  id: "quick",
  name: "Quick rules",
  rules: [{ type: "alias", from: "GIF", to: "jif" }],
});

const INITIAL_STATE: CreatorState = {
  ...getCreatorPresetDefaults("youtube-long"),
  dictionaries: [QUICK_RULES],
};

describe("useCreatorSettings", () => {
  it("updates inference language when the selection changes", () => {
    const { result, rerender } = renderHook(({ language }) => useCreatorSettings({ initialState: INITIAL_STATE, quality: 5, language }), { initialProps: { language: "en" } });
    expect(result.current.generationSettings.language).toBe("en");
    rerender({ language: "fr" });
    expect(result.current.generationSettings.language).toBe("fr");
  });

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
    // Every new export option off: the options are the ones the export always took.
    expect(result.current.exportOptions).toEqual({
      format: "wav-pcm24",
      sampleRate: 48000,
      bitrateKbps: 320,
      mastering: { enabled: true, targetLufs: -14, truePeakDb: -1 },
    });
    expect(result.current.speechSettings).toEqual({ dictionaries: [QUICK_RULES], normalize: false, cleanup: false });
  });

  it("builds mastering and post-processing options from the loudness preset and finishing options", () => {
    const { result } = renderHook(() => useCreatorSettings({ initialState: INITIAL_STATE, quality: 5 }));

    act(() => {
      result.current.onLoudnessPresetChange("acx");
      result.current.onExportFormatChange("flac-24");
      result.current.onExportPostChange({ trimSilence: true, headSec: 0.5 });
      result.current.onExportPostChange({ fadeOutMs: 200 });
    });

    expect(result.current.exportOptions).toMatchObject({
      format: "flac-24",
      mastering: { enabled: true, targetLufs: -20, truePeakDb: -3, measure: "rms" },
      post: { trimSilence: true, headSec: 0.5, tailSec: 0, fadeInMs: 0, fadeOutMs: 200 },
    });

    act(() => {
      result.current.onLoudnessPresetChange("not-a-preset");
      result.current.onExportPostChange({ trimSilence: false, headSec: 0, fadeOutMs: 0 });
    });
    expect(result.current.exportOptions.mastering.targetLufs).toBe(-14);
    expect(result.current.exportOptions).not.toHaveProperty("post");
  });

  it("applies presets and marks manual changes to preset fields as custom", () => {
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
      dictionaries: [QUICK_RULES],
      exportFormat: "wav-pcm16",
      exportSampleRate: "source",
      exportBitrateKbps: 192,
      masteringEnabled: false,
    });
  });

  it("leaves the preset alone for dictionary, text and finishing changes", () => {
    const { result } = renderHook(() => useCreatorSettings({ initialState: getCreatorPresetDefaults("youtube-shorts"), quality: 5 }));
    const dictionary = createPronunciationDictionary({ name: "Names", rules: [{ type: "alias", from: "Nguyen", to: "win" }] });

    act(() => {
      result.current.onDictionariesChange([dictionary]);
      result.current.onNormalizeSpeechChange(true);
      result.current.onCleanupOnSpeakChange(true);
      result.current.onLoudnessPresetChange("podcast");
      result.current.onExportPostChange({ fadeInMs: 10 });
      result.current.onCaptionStyleChange("short");
    });

    expect(result.current.creatorPreset).toBe("youtube-shorts");
    expect(result.current.generationSettings.pronunciationRules).toEqual([{ from: "Nguyen", to: "win" }]);
    expect(result.current.persistedState).toMatchObject({
      dictionaries: [dictionary],
      normalizeSpeech: true,
      cleanupOnSpeak: true,
      loudnessPresetId: "podcast",
      exportPost: { fadeInMs: 10 },
      captionStyle: "short",
    });
    expect(result.current.speechSettings).toEqual({ dictionaries: [dictionary], normalize: true, cleanup: true });
  });

  it("does not reset values when selecting the custom preset directly", () => {
    const { result } = renderHook(() => useCreatorSettings({ initialState: INITIAL_STATE, quality: 5 }));

    act(() => {
      result.current.onCreatorPresetChange("custom");
    });

    expect(result.current.creatorPreset).toBe("custom");
    expect(result.current.speed).toBe(INITIAL_STATE.speed);
  });

  it("keeps its identity and every setter stable across renders until its state changes", () => {
    const { result, rerender } = renderHook(() => useCreatorSettings({ initialState: INITIAL_STATE, quality: 5 }));
    const initial = result.current;

    rerender();
    expect(result.current).toBe(initial);

    act(() => result.current.onSpeedChange(1.1));
    expect(result.current).not.toBe(initial);
    expect(result.current.speed).toBe(1.1);
    expect(result.current.creatorPreset).toBe("custom");
    const setterNames = (Object.keys(initial) as Array<keyof typeof initial>)
      .filter((key) => typeof initial[key] === "function");
    expect(setterNames).toHaveLength(15);
    for (const name of setterNames) expect(result.current[name], name).toBe(initial[name]);
  });
});
