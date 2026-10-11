import { fireEvent, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReaderSection } from "../../lib/readerDocument";
import { READER_SHORTCUTS_DIALOG_ATTRIBUTE } from "./readerShortcuts";
import { useReaderKeyboard } from "./useReaderKeyboard";

function section(id: string, start: number): ReaderSection {
  return {
    id,
    chapterId: "chapter-1",
    order: 0,
    chapterSectionIndex: 0,
    chapterSectionCount: 3,
    start,
    end: start + 100,
  };
}

function setup(overrides: Partial<Parameters<typeof useReaderKeyboard>[0]> = {}) {
  const scroller = document.createElement("div");
  scroller.tabIndex = 0;
  const toolbarButton = document.createElement("button");
  const input = document.createElement("input");
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  const dialogButton = document.createElement("button");
  dialog.append(dialogButton);
  document.body.append(scroller, toolbarButton, input, dialog);
  const options = {
    editing: false,
    scrollerRef: { current: scroller },
    previousSection: section("section-1", 0),
    nextSection: section("section-3", 200),
    onJumpToOffset: vi.fn(),
    onStep: vi.fn(),
    onToggleShortcuts: vi.fn(),
    immersive: false,
    onImmersiveChange: vi.fn(),
    ...overrides,
  };
  const view = renderHook(() => useReaderKeyboard(options));
  return { ...view, options, scroller, toolbarButton, input, dialogButton };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("useReaderKeyboard", () => {
  it("turns pages from the page itself or the reading pane", () => {
    const { options, scroller } = setup();

    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    fireEvent.keyDown(scroller, { key: "ArrowLeft" });

    expect(options.onJumpToOffset).toHaveBeenNthCalledWith(1, 200);
    expect(options.onJumpToOffset).toHaveBeenNthCalledWith(2, 0);
  });

  it("leaves arrows alone in controls, text entry, dialogs, the editor, and on key repeat", () => {
    const { options, toolbarButton, input, dialogButton, unmount } = setup();

    fireEvent.keyDown(toolbarButton, { key: "ArrowRight" });
    fireEvent.keyDown(input, { key: "ArrowRight" });
    fireEvent.keyDown(dialogButton, { key: "ArrowRight" });
    fireEvent.keyDown(document.body, { key: "ArrowRight", repeat: true });
    fireEvent.keyDown(document.body, { key: "ArrowRight", altKey: true });
    expect(options.onJumpToOffset).not.toHaveBeenCalled();
    unmount();

    const editing = setup({ editing: true });
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(editing.options.onJumpToOffset).not.toHaveBeenCalled();
  });

  it("does nothing at the first or last page", () => {
    const { options } = setup({ previousSection: null, nextSection: null });

    fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    fireEvent.keyDown(document.body, { key: "ArrowRight" });

    expect(options.onJumpToOffset).not.toHaveBeenCalled();
  });

  it("steps by sentence with Shift+←/→ and by paragraph with Shift+↑/↓", () => {
    const { options, scroller } = setup();

    fireEvent.keyDown(document.body, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(scroller, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(scroller, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(document.body, { key: "ArrowUp", shiftKey: true });

    expect(vi.mocked(options.onStep).mock.calls).toEqual([
      ["sentence", "next"],
      ["sentence", "previous"],
      ["paragraph", "next"],
      ["paragraph", "previous"],
    ]);
    expect(options.onJumpToOffset).not.toHaveBeenCalled();
  });

  it("leaves Shift+arrows to the browser while they extend a selection, and outside the reader", () => {
    const { options, scroller, toolbarButton } = setup();
    scroller.textContent = "Some selectable words.";
    const range = document.createRange();
    range.setStart(scroller.firstChild!, 0);
    range.setEnd(scroller.firstChild!, 4);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);

    fireEvent.keyDown(scroller, { key: "ArrowRight", shiftKey: true });
    window.getSelection()?.removeAllRanges();
    fireEvent.keyDown(toolbarButton, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(document.body, { key: "ArrowDown", shiftKey: true, repeat: true });
    fireEvent.keyDown(document.body, { key: "ArrowDown", shiftKey: true, altKey: true });
    fireEvent.keyDown(document.body, { key: "ArrowDown" });

    expect(options.onStep).not.toHaveBeenCalled();
    expect(options.onJumpToOffset).not.toHaveBeenCalled();
  });

  it("toggles the shortcut list with ? and the focus layout with F", () => {
    const { options, input, dialogButton } = setup({ immersive: true });

    fireEvent.keyDown(document.body, { key: "?" });
    fireEvent.keyDown(input, { key: "?" });
    expect(options.onToggleShortcuts).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document.body, { key: "F" });
    fireEvent.keyDown(dialogButton, { key: "f" });
    fireEvent.keyDown(document.body, { key: "f", metaKey: true });
    expect(options.onImmersiveChange).toHaveBeenCalledTimes(1);
    expect(options.onImmersiveChange).toHaveBeenCalledWith(false);
  });

  it("ignores ? inside another dialog but toggles from inside the shortcut list", () => {
    const { options, dialogButton } = setup();
    const shortcuts = document.createElement("div");
    shortcuts.setAttribute("role", "dialog");
    shortcuts.setAttribute(READER_SHORTCUTS_DIALOG_ATTRIBUTE, "");
    const closeButton = document.createElement("button");
    shortcuts.append(closeButton);
    document.body.append(shortcuts);

    fireEvent.keyDown(dialogButton, { key: "?" });
    expect(options.onToggleShortcuts).not.toHaveBeenCalled();
    fireEvent.keyDown(closeButton, { key: "?" });
    expect(options.onToggleShortcuts).toHaveBeenCalledTimes(1);
  });

  it("ignores F when the focus layout cannot be changed, and keys already handled", () => {
    const { options } = setup({ onImmersiveChange: undefined });
    const handled = new KeyboardEvent("keydown", { key: "?", bubbles: true, cancelable: true });
    handled.preventDefault();

    fireEvent.keyDown(document.body, { key: "f" });
    document.body.dispatchEvent(handled);

    expect(options.onToggleShortcuts).not.toHaveBeenCalled();
  });
});
