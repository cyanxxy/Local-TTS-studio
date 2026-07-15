export type ColorTheme = "system" | "light" | "dark";
export type AccentColor = "blue" | "violet" | "teal" | "orange";
export type InterfaceSize = "small" | "medium" | "large";
export type InterfaceFont = "inter" | "system" | "outfit";
export type ReadingFont = "literata" | "inter" | "outfit" | "georgia";

export interface AppPreferences {
  theme: ColorTheme;
  accentColor: AccentColor;
  interfaceSize: InterfaceSize;
  interfaceFont: InterfaceFont;
  readingFont: ReadingFont;
  reduceTransparency: boolean;
  reduceMotion: boolean;
  showNeuTTS: boolean;
  showQwen3TTS: boolean;
}

const APP_PREFERENCES_STORAGE_KEY = "open-tts-preferences-v1";

export const DEFAULT_APP_PREFERENCES: AppPreferences = {
  theme: "system",
  accentColor: "blue",
  interfaceSize: "medium",
  interfaceFont: "inter",
  readingFont: "literata",
  reduceTransparency: false,
  reduceMotion: false,
  showNeuTTS: false,
  showQwen3TTS: false,
};

function isColorTheme(value: unknown): value is ColorTheme {
  return value === "system" || value === "light" || value === "dark";
}

function isAccentColor(value: unknown): value is AccentColor {
  return value === "blue" || value === "violet" || value === "teal" || value === "orange";
}

function isInterfaceSize(value: unknown): value is InterfaceSize {
  return value === "small" || value === "medium" || value === "large";
}

function isInterfaceFont(value: unknown): value is InterfaceFont {
  return value === "inter" || value === "system" || value === "outfit";
}

function isReadingFont(value: unknown): value is ReadingFont {
  return value === "literata" || value === "inter" || value === "outfit" || value === "georgia";
}

export function getInitialAppPreferences(): AppPreferences {
  try {
    const stored = localStorage.getItem(APP_PREFERENCES_STORAGE_KEY);
    if (!stored) return DEFAULT_APP_PREFERENCES;

    const parsed = JSON.parse(stored) as Partial<AppPreferences>;
    return {
      theme: isColorTheme(parsed.theme) ? parsed.theme : DEFAULT_APP_PREFERENCES.theme,
      accentColor: isAccentColor(parsed.accentColor)
        ? parsed.accentColor
        : DEFAULT_APP_PREFERENCES.accentColor,
      interfaceSize: isInterfaceSize(parsed.interfaceSize)
        ? parsed.interfaceSize
        : DEFAULT_APP_PREFERENCES.interfaceSize,
      interfaceFont: isInterfaceFont(parsed.interfaceFont)
        ? parsed.interfaceFont
        : DEFAULT_APP_PREFERENCES.interfaceFont,
      readingFont: isReadingFont(parsed.readingFont)
        ? parsed.readingFont
        : DEFAULT_APP_PREFERENCES.readingFont,
      reduceTransparency: typeof parsed.reduceTransparency === "boolean"
        ? parsed.reduceTransparency
        : DEFAULT_APP_PREFERENCES.reduceTransparency,
      reduceMotion: typeof parsed.reduceMotion === "boolean"
        ? parsed.reduceMotion
        : DEFAULT_APP_PREFERENCES.reduceMotion,
      showNeuTTS: typeof parsed.showNeuTTS === "boolean"
        ? parsed.showNeuTTS
        : DEFAULT_APP_PREFERENCES.showNeuTTS,
      showQwen3TTS: typeof parsed.showQwen3TTS === "boolean"
        ? parsed.showQwen3TTS
        : DEFAULT_APP_PREFERENCES.showQwen3TTS,
    };
  } catch {
    return DEFAULT_APP_PREFERENCES;
  }
}

export function persistAppPreferences(preferences: AppPreferences): void {
  try {
    localStorage.setItem(APP_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Preferences remain usable for the current session when storage is blocked.
  }
}

export function resolveColorTheme(
  theme: ColorTheme,
  prefersDark: boolean,
): Exclude<ColorTheme, "system"> {
  return theme === "system" ? (prefersDark ? "dark" : "light") : theme;
}
