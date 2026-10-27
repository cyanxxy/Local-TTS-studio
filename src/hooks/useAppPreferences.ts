import { useCallback, useEffect, useLayoutEffect, useState } from "react";
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

  // A layout effect, so the theme attributes land before the first frame is
  // painted: with a passive effect a user whose preference differs from the
  // OS saw one frame in the wrong theme. (Before React runs at all, index.css
  // follows prefers-color-scheme for the same reason.)
  useLayoutEffect(() => {
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

  // The desktop window's vibrancy material and native controls follow the
  // native theme, not the page; hand the choice over so they match it.
  useEffect(() => {
    window.electron?.appearance?.setThemeSource(preferences.theme);
  }, [preferences.theme]);

  const updatePreferences = useCallback((patch: Partial<AppPreferences>) => {
    setPreferences((current) => ({ ...current, ...patch }));
  }, []);

  const resetPreferences = useCallback(() => {
    setPreferences(DEFAULT_APP_PREFERENCES);
  }, []);

  return { preferences, updatePreferences, resetPreferences };
}
