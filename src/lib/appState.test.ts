import { beforeEach, describe, expect, it, vi } from "vitest";
import { CREATOR_PRESETS, MODELS, QUALITY_MAX, QUALITY_MIN } from "../constants";
import {
  DEFAULT_TEXT,
  getCreatorPresetDefaults,
  getInitialAppState,
  getInitialCreatorState,
  parsePronunciationRules,
  persistAppState,
  persistCreatorState,
} from "./appState";

const LEGACY_MODEL_STORAGE_KEY = "tts-app-model";
const APP_STATE_STORAGE_KEY = "tts-app-state-v1";
const CREATOR_STATE_STORAGE_KEY = "tts-app-creator-v1";

describe("appState", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("returns defaults and honors a valid legacy model when no v1 state exists", () => {
    expect(getInitialAppState()).toEqual({
      model: "kokoro",
      text: DEFAULT_TEXT,
      voicesByModel: {
        kokoro: MODELS.kokoro.defaultVoice,
        supertonic: MODELS.supertonic.defaultVoice,
      },
      quality: 5,
    });

    localStorage.setItem(LEGACY_MODEL_STORAGE_KEY, "supertonic");

    expect(getInitialAppState().model).toBe("supertonic");
  });

  it("normalizes persisted app state and falls back from invalid values", () => {
    localStorage.setItem(LEGACY_MODEL_STORAGE_KEY, "supertonic");
    localStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify({
      model: "invalid",
      text: 42,
      voicesByModel: {
        kokoro: "  ",
        supertonic: "Robot",
      },
      quality: QUALITY_MAX + 99,
    }));

    expect(getInitialAppState()).toEqual({
      model: "supertonic",
      text: DEFAULT_TEXT,
      voicesByModel: {
        kokoro: MODELS.kokoro.defaultVoice,
        supertonic: MODELS.supertonic.defaultVoice,
      },
      quality: QUALITY_MAX,
    });
  });

  it("reads valid persisted app state and clamps low quality", () => {
    localStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify({
      model: "supertonic",
      text: "Saved script",
      voicesByModel: {
        kokoro: "custom_kokoro",
        supertonic: "Male 2",
      },
      quality: QUALITY_MIN - 10,
    }));

    expect(getInitialAppState()).toEqual({
      model: "supertonic",
      text: "Saved script",
      voicesByModel: {
        kokoro: "custom_kokoro",
        supertonic: "Male 2",
      },
      quality: QUALITY_MIN,
    });
  });

  it("falls back to defaults when stored app JSON or localStorage access fails", () => {
    localStorage.setItem(APP_STATE_STORAGE_KEY, "{not json");
    expect(getInitialAppState().model).toBe("kokoro");

    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(getInitialAppState().text).toBe(DEFAULT_TEXT);
  });

  it("builds preset defaults, resolving custom from the default creator preset", () => {
    const custom = getCreatorPresetDefaults("custom");
    const defaultPreset = CREATOR_PRESETS["youtube-shorts"];

    expect(custom).toMatchObject({
      preset: "custom",
      speed: defaultPreset.speed,
      exportFormat: defaultPreset.exportFormat,
      pronunciationLexicon: "",
    });

    expect(getCreatorPresetDefaults("youtube-long")).toMatchObject({
      preset: "youtube-long",
      speed: CREATOR_PRESETS["youtube-long"].speed,
    });
  });

  it("normalizes persisted creator state and clamps numeric ranges", () => {
    localStorage.setItem(CREATOR_STATE_STORAGE_KEY, JSON.stringify({
      preset: "custom",
      speed: 99,
      pauseCommaSec: -1,
      pauseSentenceSec: 99,
      pauseParagraphSec: 0.5,
      pronunciationLexicon: "GIF => jif",
      exportFormat: "mp3",
      exportSampleRate: 44100,
      exportBitrateKbps: 999,
      masteringEnabled: false,
    }));

    expect(getInitialCreatorState()).toEqual({
      preset: "custom",
      speed: 1.15,
      pauseCommaSec: 0,
      pauseSentenceSec: 2,
      pauseParagraphSec: 0.5,
      pronunciationLexicon: "GIF => jif",
      exportFormat: "mp3",
      exportSampleRate: 44100,
      exportBitrateKbps: 320,
      masteringEnabled: false,
    });
  });

  it("falls back from invalid creator state fields and malformed JSON", () => {
    localStorage.setItem(CREATOR_STATE_STORAGE_KEY, JSON.stringify({
      preset: "missing",
      speed: "fast",
      pauseCommaSec: "none",
      pauseSentenceSec: null,
      pauseParagraphSec: undefined,
      pronunciationLexicon: 123,
      exportFormat: "aac",
      exportSampleRate: 22050,
      exportBitrateKbps: "320",
      masteringEnabled: "yes",
    }));

    expect(getInitialCreatorState()).toEqual(getCreatorPresetDefaults("youtube-shorts"));

    localStorage.setItem(CREATOR_STATE_STORAGE_KEY, "{not json");
    expect(getInitialCreatorState()).toEqual(getCreatorPresetDefaults("youtube-shorts"));
  });

  it("parses pronunciation rules from common separators and ignores comments", () => {
    expect(parsePronunciationRules(`
      # comments are skipped
      GIF => jif
      SQL -> sequel
      TTS = tee tee ess
      invalid line
      = missing source
      missing target =
    `)).toEqual([
      { from: "GIF", to: "jif" },
      { from: "SQL", to: "sequel" },
      { from: "TTS", to: "tee tee ess" },
    ]);
  });

  it("persists app and creator state while tolerating storage failures", () => {
    persistAppState({ model: "supertonic", text: "Saved" });
    persistCreatorState({ preset: "custom", exportFormat: "mp3" });

    expect(JSON.parse(localStorage.getItem(APP_STATE_STORAGE_KEY) ?? "{}")).toMatchObject({
      model: "supertonic",
      text: "Saved",
    });
    expect(localStorage.getItem(LEGACY_MODEL_STORAGE_KEY)).toBe("supertonic");
    expect(JSON.parse(localStorage.getItem(CREATOR_STATE_STORAGE_KEY) ?? "{}")).toMatchObject({
      preset: "custom",
      exportFormat: "mp3",
    });

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(() => persistAppState({ model: "kokoro" })).not.toThrow();
    expect(() => persistCreatorState({ preset: "youtube-long" })).not.toThrow();
  });
});
