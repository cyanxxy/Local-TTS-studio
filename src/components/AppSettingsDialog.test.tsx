import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_APP_PREFERENCES } from "../lib/appPreferences";
import { AppSettingsDialog } from "./AppSettingsDialog";

describe("AppSettingsDialog", () => {
  it("edits appearance and optional model preferences", () => {
    const onChange = vi.fn();
    render(
      <AppSettingsDialog
        open
        desktopModelsAvailable
        preferences={DEFAULT_APP_PREFERENCES}
        onChange={onChange}
        onReset={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog")).toHaveClass("no-drag");
    expect(screen.getByRole("dialog").parentElement).toHaveClass("no-drag");

    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
    expect(onChange).toHaveBeenCalledWith({ theme: "dark" });
    fireEvent.click(screen.getByRole("button", { name: "Violet accent" }));
    expect(onChange).toHaveBeenCalledWith({ accentColor: "violet" });
    fireEvent.click(screen.getByRole("button", { name: "App font Outfit" }));
    expect(onChange).toHaveBeenCalledWith({ interfaceFont: "outfit" });
    fireEvent.click(screen.getByRole("button", { name: "Reading font Georgia" }));
    expect(onChange).toHaveBeenCalledWith({ readingFont: "georgia" });
    fireEvent.click(screen.getByRole("checkbox", { name: /Reduce motion/i }));
    expect(onChange).toHaveBeenCalledWith({ reduceMotion: true });

    fireEvent.click(screen.getAllByRole("button", { name: "Optional models" })[0]);
    fireEvent.click(screen.getByRole("checkbox", { name: /Show NeuTTS Nano/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Show Qwen3-TTS/i }));
    expect(onChange).toHaveBeenCalledWith({ showNeuTTS: true });
    expect(onChange).toHaveBeenCalledWith({ showQwen3TTS: true });
  });

  it("stays closed when not requested", () => {
    render(
      <AppSettingsDialog
        open={false}
        desktopModelsAvailable
        preferences={DEFAULT_APP_PREFERENCES}
        onChange={vi.fn()}
        onReset={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows shortcut controls for macOS and Windows", () => {
    render(
      <AppSettingsDialog
        open
        desktopModelsAvailable
        preferences={DEFAULT_APP_PREFERENCES}
        onChange={vi.fn()}
        onReset={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Shortcuts" })[0]);

    expect(screen.getByRole("heading", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    expect(screen.getByText("Generate speech")).toBeInTheDocument();
    expect(screen.getByLabelText("macOS: ⌘ + Return")).toBeInTheDocument();
    expect(screen.getByLabelText("Windows: Ctrl + Enter")).toBeInTheDocument();
    expect(screen.getByLabelText("macOS: ⌥ + ← / →")).toBeInTheDocument();
    expect(screen.getByLabelText("Windows: Alt + ← / →")).toBeInTheDocument();
  });

  it("traps keyboard focus and restores the element that opened it", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open settings";
    document.body.appendChild(trigger);
    trigger.focus();
    const rects = vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue(
      [{ width: 1, height: 1 }] as unknown as DOMRectList,
    );

    const props = {
      desktopModelsAvailable: true,
      preferences: DEFAULT_APP_PREFERENCES,
      onChange: vi.fn(),
      onReset: vi.fn(),
      onClose: vi.fn(),
    };
    const { rerender, unmount } = render(<AppSettingsDialog {...props} open />);
    const first = screen.getAllByRole("button", { name: "Appearance" })[0];
    const last = screen.getByRole("button", { name: "Done" });

    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(first).toHaveFocus();

    first.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();

    rerender(<AppSettingsDialog {...props} open={false} />);
    expect(trigger).toHaveFocus();

    unmount();
    rects.mockRestore();
    trigger.remove();
  });
});
