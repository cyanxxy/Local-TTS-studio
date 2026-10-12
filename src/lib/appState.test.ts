import { beforeEach, describe, expect, it, vi } from "vitest";
import { CREATOR_PRESETS, QUALITY_MAX, QUALITY_MIN } from "../constants";
import { ENGINES } from "../models/registry";
import {
  analyzePronunciationLexicon,
  DEFAULT_TEXT,
  getCreatorPresetDefaults,
  getInitialAppState,
  getInitialCreatorState,
  getInitialEngineSettings,
  parsePronunciationRules,
  persistAppState,
  persistCreatorState,
  persistEngineSettings,
} from "./appState";

const LEGACY_MODEL_STORAGE_KEY = "tts-app-model";
const LEGACY_APP_STATE_STORAGE_KEY = "tts-app-state-v1";
const APP_STATE_STORAGE_KEY = "tts-app-state-v2";
const ENGINE_SETTINGS_STORAGE_KEY = "tts-engine-settings-v1";
const CREATOR_STATE_STORAGE_KEY = "tts-app-creator-v1";

const DEFAULT_ENGINE_SETTINGS = Object.fromEntries(
  Object.values(ENGINES).map((engine) => [engine.id, engine.defaultSettings]),
);

describe("appState", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("returns defaults and honors a valid legacy model when no saved state exists", () => {
    expect(getInitialAppState()).toEqual({
      model: "kokoro",
      text: DEFAULT_TEXT,
      quality: 5,
      desktopModels: { studio: null, reader: null },
    });
    expect(getInitialEngineSettings()).toEqual(DEFAULT_ENGINE_SETTINGS);

    localStorage.setItem(LEGACY_MODEL_STORAGE_KEY, "supertonic");

    expect(getInitialAppState().model).toBe("supertonic");
  });

  it("migrates the v1 app state, including its voices, until v2 is written", () => {
    localStorage.setItem(LEGACY_APP_STATE_STORAGE_KEY, JSON.stringify({
      model: "supertonic",
      text: "Saved script",
      voicesByModel: {
        kokoro: "custom_kokoro",
        supertonic: "Male 2",
      },
      quality: QUALITY_MIN - 10,
      audio8Voice: "iris",
    }));

    expect(getInitialAppState()).toEqual({
      model: "supertonic",
      text: "Saved script",
      quality: QUALITY_MIN,
      desktopModels: { studio: null, reader: null },
    });
    expect(getInitialEngineSettings()).toMatchObject({
      kokoro: { voice: "custom_kokoro" },
      supertonic: { voice: "Male 2", language: "en" },
      audio8: { voice: "iris", seed: null, temperature: null },
      supertonic3: ENGINES.supertonic3.defaultSettings,
      qwen3: ENGINES.qwen3.defaultSettings,
    });

    persistAppState({ model: "kokoro", text: "Newer script", quality: 7 });
    persistEngineSettings({ kokoro: { voice: "bf_emma" } });

    expect(getInitialAppState()).toMatchObject({ model: "kokoro", text: "Newer script", quality: 7 });
    // Engines v2 has not stored yet still read their v1 voices.
    expect(getInitialEngineSettings()).toMatchObject({
      kokoro: { voice: "bf_emma" },
      supertonic: { voice: "Male 2" },
      audio8: { voice: "iris", seed: null, temperature: null },
    });
  });

  it("normalizes persisted app state and falls back from invalid values", () => {
    localStorage.setItem(LEGACY_MODEL_STORAGE_KEY, "supertonic");
    localStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify({
      version: 2,
      model: "invalid",
      text: 42,
      quality: QUALITY_MAX + 99,
      desktopModels: { studio: "neutts", reader: 3 },
    }));
    localStorage.setItem(ENGINE_SETTINGS_STORAGE_KEY, JSON.stringify({
      kokoro: { voice: "  " },
      supertonic: { voice: "Robot", language: "xx" },
      audio8: { voice: "not-a-voice" },
      supertonic3: "M1",
      qwen3: { temperature: 99, profileRepo: "../../etc" },
      mystery: { voice: "ignored" },
    }));

    expect(getInitialAppState()).toEqual({
      model: "supertonic",
      text: DEFAULT_TEXT,
      quality: QUALITY_MAX,
      desktopModels: { studio: null, reader: null },
    });
    const settings = getInitialEngineSettings();
    expect(settings).toMatchObject({
      kokoro: ENGINES.kokoro.defaultSettings,
      supertonic: ENGINES.supertonic.defaultSettings,
      audio8: ENGINES.audio8.defaultSettings,
      supertonic3: ENGINES.supertonic3.defaultSettings,
      qwen3: { ...ENGINES.qwen3.defaultSettings, temperature: 2, profileRepo: null },
    });
    expect(settings).not.toHaveProperty("mystery");
  });

  it("round-trips each surface's desktop model and every engine's settings", () => {
    persistAppState({
      model: "supertonic",
      text: "Saved",
      quality: 4,
      desktopModels: { studio: "qwen3", reader: "supertonic3" },
    });
    persistEngineSettings({
      supertonic: { voice: "Male 3", language: "fr" },
      supertonic3: { voice: "F4", language: "ja", seed: null },
    });
    persistEngineSettings({
      qwen3: { ...ENGINES.qwen3.defaultSettings, speaker: "Ryan", seed: 42 },
    });

    expect(JSON.parse(localStorage.getItem(APP_STATE_STORAGE_KEY) ?? "{}")).toMatchObject({ version: 2 });
    expect(getInitialAppState()).toEqual({
      model: "supertonic",
      text: "Saved",
      quality: 4,
      desktopModels: { studio: "qwen3", reader: "supertonic3" },
    });
    // The second write kept the engines the first one stored.
    expect(getInitialEngineSettings()).toMatchObject({
      supertonic: { voice: "Male 3", language: "fr" },
      supertonic3: { voice: "F4", language: "ja", seed: null },
      qwen3: { speaker: "Ryan", seed: 42 },
    });
  });

  it("persists Kitten, Paradee and Piper settings with the other engines and rejects what they cannot speak", () => {
    persistEngineSettings({
      kitten: { voice: "Rosie" },
      piper: { voice: "en_US-libritts-high#12" },
    });
    persistEngineSettings({ supertonic: { voice: "Male 3", language: "fr" } });

    expect(getInitialEngineSettings()).toMatchObject({
      kitten: { voice: "Rosie" },
      paradee: ENGINES.paradee.defaultSettings,
      piper: { voice: "en_US-libritts-high#12" },
      supertonic: { voice: "Male 3", language: "fr" },
    });

    localStorage.setItem(ENGINE_SETTINGS_STORAGE_KEY, JSON.stringify({
      kitten: { voice: "Robot" },
      paradee: { voice: "af_bella" },
      piper: { voice: "en_US-libritts-high#99999" },
    }));
    expect(getInitialEngineSettings()).toMatchObject({
      kitten: ENGINES.kitten.defaultSettings,
      paradee: ENGINES.paradee.defaultSettings,
      piper: { voice: "en_US-libritts-high" },
    });
  });

  it("restores the browser model a user last chose among the new engines", () => {
    for (const model of ["kitten", "paradee", "piper"] as const) {
      persistAppState({ model });
      expect(getInitialAppState().model).toBe(model);
    }
  });

  it("falls back to defaults when stored app JSON or localStorage access fails", () => {
    localStorage.setItem(APP_STATE_STORAGE_KEY, "{not json");
    localStorage.setItem(ENGINE_SETTINGS_STORAGE_KEY, "[1, 2]");
    expect(getInitialAppState().model).toBe("kokoro");
    expect(getInitialEngineSettings()).toEqual(DEFAULT_ENGINE_SETTINGS);

    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(getInitialAppState().text).toBe(DEFAULT_TEXT);
    expect(getInitialEngineSettings()).toEqual(DEFAULT_ENGINE_SETTINGS);
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
      pauseSentenceSec: 1.2,
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

  it("reports invalid pronunciation lines while preserving valid rules", () => {
    expect(analyzePronunciationLexicon(`
      GIF => jif
      this is not a rule
      # ignored comment
      = missing source
      SQL=sequel
    `)).toEqual({
      rules: [
        { from: "GIF", to: "jif" },
        { from: "SQL", to: "sequel" },
      ],
      issues: [
        { line: 3, value: "this is not a rule" },
        { line: 5, value: "= missing source" },
      ],
    });
  });

  it("snaps persisted MP3 bitrates to values supported by the export control", () => {
    localStorage.setItem(CREATOR_STATE_STORAGE_KEY, JSON.stringify({
      preset: "custom",
      exportBitrateKbps: 96,
    }));
    expect(getInitialCreatorState().exportBitrateKbps).toBe(128);

    localStorage.setItem(CREATOR_STATE_STORAGE_KEY, JSON.stringify({
      preset: "custom",
      exportBitrateKbps: 275,
    }));
    expect(getInitialCreatorState().exportBitrateKbps).toBe(256);
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
    expect(() => persistEngineSettings({ audio8: { voice: "iris", seed: null, temperature: null } })).not.toThrow();
    expect(() => persistCreatorState({ preset: "youtube-long" })).not.toThrow();
  });
});
