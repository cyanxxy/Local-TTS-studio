import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_APP_PREFERENCES,
  getInitialAppPreferences,
  persistAppPreferences,
  resolveColorTheme,
  type AppPreferences,
} from "../lib/appPreferences";

export function useAppPreferences() {
  const [preferences, setPreferences] = useState<AppPreferences>(getInitialAppPreferences);

  useEffect(() => {
    persistAppPreferences(preferences);
  }, [preferences]);

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");

    const apply = () => {
      root.dataset.theme = resolveColorTheme(preferences.theme, media?.matches ?? false);
      root.dataset.themePreference = preferences.theme;
      root.dataset.accent = preferences.accentColor;
      root.dataset.interfaceSize = preferences.interfaceSize;
      root.dataset.interfaceFont = preferences.interfaceFont;
      root.dataset.readingFont = preferences.readingFont;
      root.dataset.transparency = preferences.reduceTransparency ? "reduced" : "full";
      root.dataset.motion = preferences.reduceMotion ? "reduced" : "full";
      root.style.colorScheme = root.dataset.theme;
    };

    apply();
    media?.addEventListener?.("change", apply);
    return () => media?.removeEventListener?.("change", apply);
  }, [preferences]);

  const updatePreferences = useCallback((patch: Partial<AppPreferences>) => {
    setPreferences((current) => ({ ...current, ...patch }));
  }, []);

  const resetPreferences = useCallback(() => {
    setPreferences(DEFAULT_APP_PREFERENCES);
  }, []);

  return { preferences, updatePreferences, resetPreferences };
}
