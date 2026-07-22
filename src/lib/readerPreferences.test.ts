import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_READER_VIEW_PREFERENCES,
  getInitialReaderViewPreferences,
  normalizeReaderViewPreferences,
  persistReaderViewPreferences,
  readerColumnWidthRem,
} from "./readerPreferences";

describe("readerPreferences", () => {
  beforeEach(() => localStorage.clear());

  it("continues automatically for new or partially persisted Reader profiles", () => {
    expect(DEFAULT_READER_VIEW_PREFERENCES.autoAdvance).toBe(true);
    expect(normalizeReaderViewPreferences({ fontSize: 21 }).autoAdvance).toBe(true);
    expect(getInitialReaderViewPreferences().autoAdvance).toBe(true);
  });

  it("keeps an explicit persisted auto-advance opt-out", () => {
    persistReaderViewPreferences({ ...DEFAULT_READER_VIEW_PREFERENCES, autoAdvance: false });
    expect(getInitialReaderViewPreferences().autoAdvance).toBe(false);
  });

  it("normalizes unsafe persisted values", () => {
    expect(normalizeReaderViewPreferences({
      fontSize: 100,
      lineHeight: 0.5,
      columnWidth: "wide",
      focusMode: false,
    })).toMatchObject({ fontSize: 26, lineHeight: 1.4, columnWidth: "wide", focusMode: false });
  });

  it("persists and restores Reader-only preferences", () => {
    persistReaderViewPreferences({ ...DEFAULT_READER_VIEW_PREFERENCES, fontSize: 22, autoAdvance: false });
    expect(getInitialReaderViewPreferences()).toMatchObject({ fontSize: 22, autoAdvance: false });
    expect(readerColumnWidthRem("comfortable")).toBe(44);
  });

  it("falls back when storage contains invalid JSON", () => {
    vi.spyOn(Storage.prototype, "getItem").mockReturnValueOnce("{");
    expect(getInitialReaderViewPreferences()).toEqual(DEFAULT_READER_VIEW_PREFERENCES);
  });
});
