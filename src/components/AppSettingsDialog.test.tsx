import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_APP_PREFERENCES } from "../lib/appPreferences";
import { AppSettingsDialog } from "./AppSettingsDialog";
import { ViewportPopover } from "./reader/ViewportPopover";

describe("AppSettingsDialog", () => {
  it("lists the model credits and licences in a Credits section", () => {
    render(
      <AppSettingsDialog
        open
        desktopModelsAvailable={false}
        preferences={DEFAULT_APP_PREFERENCES}
        onChange={vi.fn()}
        onReset={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Credits" })[0]);

    expect(screen.getByRole("heading", { name: "Credits" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Piper" })).toHaveTextContent("CC-BY-4.0");
    expect(screen.getByRole("region", { name: "Kitten TTS" })).toHaveTextContent("Apache-2.0");
  });

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

  it("opens above a Reader popover, and one Escape closes only Settings (U2)", async () => {
    const closePopover = vi.fn();
    function ReaderWithSettings() {
      const anchorRef = useRef<HTMLButtonElement>(null);
      const popoverRef = useRef<HTMLDivElement>(null);
      const [settingsOpen, setSettingsOpen] = useState(false);
      return (
        <>
          <button ref={anchorRef} type="button">Appearance menu</button>
          <ViewportPopover anchorRef={anchorRef} popoverRef={popoverRef} maxWidth={320} className="" ariaLabel="Reading appearance" onClose={closePopover}>
            <button type="button" onClick={() => setSettingsOpen(true)}>Open settings</button>
          </ViewportPopover>
          <AppSettingsDialog
            open={settingsOpen}
            desktopModelsAvailable={false}
            preferences={DEFAULT_APP_PREFERENCES}
            onChange={vi.fn()}
            onReset={vi.fn()}
            onClose={() => setSettingsOpen(false)}
          />
        </>
      );
    }
    render(<ReaderWithSettings />);
    await act(() => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));
    const opener = screen.getByRole("button", { name: "Open settings" });
    opener.focus();
    fireEvent.click(opener);

    const settings = screen.getByRole("dialog", { name: "Appearance" });
    const popover = screen.getByRole("dialog", { name: "Reading appearance" });
    // Settings stacks above the popover's z-[120].
    expect(settings.parentElement).toHaveClass("z-[150]");
    expect(popover).toHaveClass("z-[120]");

    // A press inside Settings belongs to Settings, not to "outside the popover".
    fireEvent.mouseDown(screen.getByRole("button", { name: "Dark" }));
    expect(closePopover).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Appearance" })).not.toBeInTheDocument();
    expect(closePopover).not.toHaveBeenCalled();
    expect(opener).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(closePopover).toHaveBeenCalledTimes(1);
  });

  it("fits the dynamic viewport so mobile browser chrome cannot cut it off", () => {
    render(
      <AppSettingsDialog open desktopModelsAvailable={false} preferences={DEFAULT_APP_PREFERENCES} onChange={vi.fn()} onReset={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByRole("dialog")).toHaveClass("max-h-[min(46rem,calc(100dvh-2rem))]");
  });
});
