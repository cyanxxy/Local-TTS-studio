import { render } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppPreferences } from "./useAppPreferences";

function Preferences() {
  useAppPreferences();
  return null;
}

/** Records the theme as the commit that first renders the app finishes, before the browser paints. */
function FirstFrameProbe({ onCommit }: { onCommit: (theme: string | undefined) => void }) {
  useLayoutEffect(() => {
    onCommit(document.documentElement.dataset.theme);
  }, [onCommit]);
  return null;
}

describe("useAppPreferences", () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  afterEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it("applies the theme before the first frame is painted (U7)", () => {
    localStorage.setItem("open-tts-preferences-v1", JSON.stringify({ theme: "dark" }));
    const onCommit = vi.fn();

    // Layout effects run in tree order, so a later sibling's runs after the
    // hook's own layout effect but before any passive effect: it sees exactly
    // what the first painted frame will show.
    render(
      <>
        <Preferences />
        <FirstFrameProbe onCommit={onCommit} />
      </>,
    );

    expect(onCommit).toHaveBeenCalledWith("dark");
    expect(document.documentElement.dataset.themePreference).toBe("dark");
  });

  it("hands the chosen theme to the desktop shell so the native window follows it (U6)", () => {
    const setThemeSource = vi.fn();
    window.electron = { isElectron: true, appearance: { setThemeSource } };
    localStorage.setItem("open-tts-preferences-v1", JSON.stringify({ theme: "light" }));
    try {
      render(<Preferences />);
      expect(setThemeSource).toHaveBeenCalledWith("light");
    } finally {
      delete window.electron;
    }
  });
});
