import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_APP_PREFERENCES,
  getInitialAppPreferences,
  persistAppPreferences,
  resolveColorTheme,
} from "./appPreferences";

describe("appPreferences", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("keeps optional desktop models hidden by default", () => {
    expect(getInitialAppPreferences()).toEqual(DEFAULT_APP_PREFERENCES);
    expect(getInitialAppPreferences()).toMatchObject({
      showNeuTTS: false,
      showQwen3TTS: false,
    });
  });

  it("normalizes persisted preferences", () => {
    localStorage.setItem("open-tts-preferences-v1", JSON.stringify({
      theme: "dark",
      accentColor: "violet",
      interfaceSize: "large",
      interfaceFont: "outfit",
      readingFont: "georgia",
      reduceTransparency: true,
      reduceMotion: true,
      showNeuTTS: true,
      showQwen3TTS: "yes",
    }));

    expect(getInitialAppPreferences()).toEqual({
      theme: "dark",
      accentColor: "violet",
      interfaceSize: "large",
      interfaceFont: "outfit",
      readingFont: "georgia",
      reduceTransparency: true,
      reduceMotion: true,
      showNeuTTS: true,
      showQwen3TTS: false,
    });
  });

  it("persists safely and resolves the system theme", () => {
    const preferences = { ...DEFAULT_APP_PREFERENCES, showQwen3TTS: true };
    persistAppPreferences(preferences);
    expect(JSON.parse(localStorage.getItem("open-tts-preferences-v1") ?? "{}")).toEqual(preferences);
    expect(resolveColorTheme("system", true)).toBe("dark");
    expect(resolveColorTheme("system", false)).toBe("light");
    expect(resolveColorTheme("dark", false)).toBe("dark");

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => persistAppPreferences(preferences)).not.toThrow();
  });
});
