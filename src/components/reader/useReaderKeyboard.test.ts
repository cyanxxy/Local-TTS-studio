import { fireEvent, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReaderSection } from "../../lib/readerDocument";
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

  it("ignores F when the focus layout cannot be changed, and keys already handled", () => {
    const { options } = setup({ onImmersiveChange: undefined });
    const handled = new KeyboardEvent("keydown", { key: "?", bubbles: true, cancelable: true });
    handled.preventDefault();

    fireEvent.keyDown(document.body, { key: "f" });
    document.body.dispatchEvent(handled);

    expect(options.onToggleShortcuts).not.toHaveBeenCalled();
  });
});
