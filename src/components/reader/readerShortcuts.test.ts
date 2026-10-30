import { describe, expect, it } from "vitest";
import { READER_SHORTCUTS, readerShortcutKeys } from "./readerShortcuts";

describe("readerShortcutKeys", () => {
  it("keeps the macOS glyphs on macOS", () => {
    expect(READER_SHORTCUTS.map((shortcut) => readerShortcutKeys(shortcut, true)))
      .toEqual(READER_SHORTCUTS.map((shortcut) => shortcut.keys));
  });

  it("writes Windows and Linux shortcuts without macOS-only glyphs", () => {
    for (const shortcut of READER_SHORTCUTS) {
      expect(readerShortcutKeys(shortcut, false)).not.toMatch(/[⌘⌥⇧]/);
    }
  });
});
