import { fireEvent, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppPage } from "../lib/appRouting";
import { useAppShortcuts, type ShortcutSurface } from "./useAppShortcuts";

function surface(overrides: Partial<ShortcutSurface> = {}): ShortcutSurface {
  return { canGenerate: true, isGenerating: false, generate: vi.fn(), stop: vi.fn(), ...overrides };
}

function setup(overrides: Partial<Parameters<typeof useAppShortcuts>[0]> = {}) {
  const props = {
    activePage: "studio" as AppPage,
    settingsOpen: false,
    onOpenSettings: vi.fn(),
    onNavigate: vi.fn(),
    surface: surface() as ShortcutSurface | null,
    hasAudio: true,
    onTogglePlayback: vi.fn(),
    onSkip: vi.fn(),
    ...overrides,
  };
  const hook = renderHook((current: typeof props) => useAppShortcuts(current), { initialProps: props });
  return { props, ...hook };
}

// Ctrl is the primary modifier outside macOS, which jsdom reports.
function press(init: KeyboardEventInit, target: Element = document.body) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  fireEvent(target, event);
  return event;
}

describe("useAppShortcuts", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("opens settings and switches pages", () => {
    const { props } = setup();

    expect(press({ key: ",", ctrlKey: true }).defaultPrevented).toBe(true);
    expect(props.onOpenSettings).toHaveBeenCalledOnce();
    press({ key: "1", ctrlKey: true });
    press({ key: "2", ctrlKey: true });
    expect(props.onNavigate).toHaveBeenNthCalledWith(1, "studio");
    expect(props.onNavigate).toHaveBeenNthCalledWith(2, "reader");
  });

  it("switches pages by physical digit key on layouts whose digit row types other characters", () => {
    const { props } = setup();

    expect(press({ key: "&", code: "Digit1", ctrlKey: true }).defaultPrevented).toBe(true);
    press({ key: "é", code: "Digit2", ctrlKey: true });
    expect(props.onNavigate).toHaveBeenNthCalledWith(1, "studio");
    expect(props.onNavigate).toHaveBeenNthCalledWith(2, "reader");
  });

  it("leaves shifted digit combinations alone", () => {
    const { props } = setup();

    expect(press({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    press({ key: "@", code: "Digit2", ctrlKey: true, shiftKey: true });
    expect(props.onNavigate).not.toHaveBeenCalled();
  });

  it("leaves everything but the settings shortcut to an open settings dialog", () => {
    const visible = surface();
    const { props } = setup({ settingsOpen: true, surface: visible });

    press({ key: "2", ctrlKey: true });
    press({ key: "Enter", ctrlKey: true });
    press({ key: " ", code: "Space" });
    press({ key: ",", ctrlKey: true });
    expect(props.onNavigate).not.toHaveBeenCalled();
    expect(visible.generate).not.toHaveBeenCalled();
    expect(props.onTogglePlayback).not.toHaveBeenCalled();
    expect(props.onOpenSettings).toHaveBeenCalledOnce();
  });

  it("generates and stops the visible surface only when it can", () => {
    const idle = surface();
    const { props, rerender } = setup({ surface: idle });
    press({ key: "Enter", ctrlKey: true });
    expect(idle.generate).toHaveBeenCalledOnce();
    expect(press({ key: ".", ctrlKey: true }).defaultPrevented).toBe(false);

    const busy = surface({ isGenerating: true });
    rerender({ ...props, surface: busy });
    expect(press({ key: "Enter", ctrlKey: true }).defaultPrevented).toBe(false);
    press({ key: ".", ctrlKey: true });
    expect(busy.generate).not.toHaveBeenCalled();
    expect(busy.stop).toHaveBeenCalledOnce();

    rerender({ ...props, surface: null });
    expect(press({ key: "Enter", ctrlKey: true }).defaultPrevented).toBe(false);
  });

  it("toggles and skips playback without hijacking text entry or focused controls", () => {
    const { props, rerender } = setup();
    expect(press({ key: " ", code: "Space" }).defaultPrevented).toBe(true);
    press({ key: "ArrowLeft", altKey: true });
    press({ key: "ArrowRight", altKey: true });
    press({ key: "ArrowUp", altKey: true });
    expect(props.onTogglePlayback).toHaveBeenCalledOnce();
    expect(props.onSkip).toHaveBeenNthCalledWith(1, -10);
    expect(props.onSkip).toHaveBeenNthCalledWith(2, 10);
    expect(props.onSkip).toHaveBeenCalledTimes(2);

    const textarea = document.body.appendChild(document.createElement("textarea"));
    const button = document.body.appendChild(document.createElement("button"));
    press({ key: " ", code: "Space" }, textarea);
    press({ key: " ", code: "Space" }, button);
    expect(props.onTogglePlayback).toHaveBeenCalledOnce();

    rerender({ ...props, activePage: "qwen3" });
    press({ key: " ", code: "Space" });
    rerender({ ...props, hasAudio: false });
    press({ key: " ", code: "Space" });
    press({ key: "ArrowLeft", altKey: true });
    expect(props.onTogglePlayback).toHaveBeenCalledOnce();
    expect(props.onSkip).toHaveBeenCalledTimes(2);
  });

  it("listens once and detaches on unmount", () => {
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    const { props, rerender, unmount } = setup();
    rerender({ ...props, hasAudio: false });
    rerender({ ...props, activePage: "reader" });
    expect(add.mock.calls.filter(([type]) => type === "keydown")).toHaveLength(1);

    unmount();
    expect(remove.mock.calls.filter(([type]) => type === "keydown")).toHaveLength(1);
    press({ key: ",", ctrlKey: true });
    expect(props.onOpenSettings).not.toHaveBeenCalled();
    add.mockRestore();
    remove.mockRestore();
  });
});
