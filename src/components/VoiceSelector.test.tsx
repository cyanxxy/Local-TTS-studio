import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { MODELS } from "../constants";
import { ViewportPopover } from "./reader/ViewportPopover";
import { VoiceSelector } from "./VoiceSelector";

describe("VoiceSelector", () => {
  it("shows a loading state while Kokoro voices are unavailable", () => {
    render(<VoiceSelector activeModel="kokoro" voice="af_heart" onVoiceChange={vi.fn()} kokoroVoices={[]} />);

    expect(screen.getByText(/Loading voices/)).toBeInTheDocument();
  });

  it("renders Supertonic voice buttons and calls onVoiceChange", () => {
    const onVoiceChange = vi.fn();
    render(<VoiceSelector activeModel="supertonic" voice="Female" onVoiceChange={onVoiceChange} kokoroVoices={[]} />);

    fireEvent.click(screen.getByRole("button", { name: "Male" }));

    expect(screen.getAllByRole("button")).toHaveLength(MODELS.supertonic.voices.length);
    expect(screen.getByRole("button", { name: "Female" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Male" })).toHaveAttribute("aria-pressed", "false");
    expect(onVoiceChange).toHaveBeenCalledWith("Male");
  });

  it("groups Kokoro voices, formats names, selects a voice, and closes on outside clicks", () => {
    const onVoiceChange = vi.fn();
    render(
      <div>
        <button>Outside</button>
        <VoiceSelector
          activeModel="kokoro"
          voice="af_heart"
          onVoiceChange={onVoiceChange}
          kokoroVoices={["af_heart", "am_echo", "zz_custom_voice"]}
        />
      </div>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Heart/i }));

    expect(screen.getByRole("button", { name: /Heart/i })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu", { name: "Select voice" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "Heart" })).toHaveAttribute("aria-checked", "true");

    expect(screen.getByText(/American.*Female/)).toBeInTheDocument();
    expect(screen.getByText(/American.*Male/)).toBeInTheDocument();
    expect(screen.getByText("Other")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitemradio", { name: /Echo/i }));
    expect(onVoiceChange).toHaveBeenCalledWith("am_echo");
    expect(screen.queryByText("American - Male")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Heart/i }));
    expect(screen.getByText("Custom voice")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByText("Custom voice")).not.toBeInTheDocument();
  });

  it("closes the Kokoro voice menu with Escape and returns focus to its trigger", () => {
    render(
      <VoiceSelector
        activeModel="kokoro"
        voice="af_heart"
        onVoiceChange={vi.fn()}
        kokoroVoices={["af_heart", "am_echo"]}
      />,
    );

    const trigger = screen.getByRole("button", { name: /Heart/i });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("menu", { name: "Select voice" }), { key: "Escape" });

    expect(screen.queryByRole("menu", { name: "Select voice" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("renders Kitten's eight voices with their gender and calls onVoiceChange", () => {
    const onVoiceChange = vi.fn();
    render(<VoiceSelector activeModel="kitten" voice="Bella" onVoiceChange={onVoiceChange} kokoroVoices={[]} />);

    expect(screen.getAllByRole("button")).toHaveLength(8);
    expect(screen.getByRole("button", { name: /Bella/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Bella/ })).toHaveTextContent("English · Female");
    expect(screen.getByRole("button", { name: /Leo/ })).toHaveTextContent("English · Male");

    fireEvent.click(screen.getByRole("button", { name: /Leo/ }));
    expect(onVoiceChange).toHaveBeenCalledWith("Leo");
  });

  it("shows Paradee's single voice", () => {
    render(<VoiceSelector activeModel="paradee" voice="heart" onVoiceChange={vi.fn()} kokoroVoices={[]} />);

    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Heart/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("hands Piper to its voice browser, with the model's download progress", () => {
    const onVoiceChange = vi.fn();
    render(
      <VoiceSelector
        activeModel="piper"
        voice="en_US-libritts-high#2"
        onVoiceChange={onVoiceChange}
        kokoroVoices={[]}
        modelState={{ ready: true, loading: true, downloadProgress: 12, error: null, backend: "wasm" }}
      />,
    );

    expect(screen.getByText("LibriTTS")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("12%");
    fireEvent.click(screen.getByRole("button", { name: /Browse/ }));
    fireEvent.click(screen.getByRole("button", { name: /Kristin/ }));
    expect(onVoiceChange).toHaveBeenCalledWith("en_US-kristin-medium");
  });

  it("hands Chatterbox to its reference voice controls", () => {
    const onVoiceChange = vi.fn();
    render(<VoiceSelector activeModel="chatterbox" voice="chatterbox-default" onVoiceChange={onVoiceChange} kokoroVoices={[]} />);

    expect(screen.getByRole("button", { name: /Default voice/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Clone a voice from a WAV file/ })).toBeInTheDocument();
  });

  it("says the voices are unavailable once the model failed, instead of loading forever", () => {
    render(
      <VoiceSelector
        activeModel="kokoro"
        voice="af_heart"
        onVoiceChange={vi.fn()}
        kokoroVoices={[]}
        modelState={{ loading: false, ready: false, error: "Failed to fetch", downloadProgress: 0, backend: null }}
      />,
    );
    expect(screen.queryByText(/Loading voices/)).not.toBeInTheDocument();
    expect(screen.getByText(/Voices are unavailable because the model did not load/)).toBeInTheDocument();
    expect(screen.queryByText("Failed to fetch")).not.toBeInTheDocument();
  });

  it("moves focus into the menu and through it with the arrow keys (U9)", () => {
    const onVoiceChange = vi.fn();
    render(<VoiceSelector activeModel="kokoro" voice="am_echo" onVoiceChange={onVoiceChange} kokoroVoices={["af_heart", "am_echo", "am_adam"]} />);
    const trigger = screen.getByRole("button", { name: /Echo/i });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    const menu = screen.getByRole("menu", { name: "Select voice" });
    const options = screen.getAllByRole("menuitemradio");
    const checked = options.find((option) => option.getAttribute("aria-checked") === "true")!;
    expect(checked).toHaveFocus();

    const at = options.indexOf(checked);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(options[(at + 1) % options.length]).toHaveFocus();
    fireEvent.keyDown(menu, { key: "End" });
    expect(options.at(-1)).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(options[0]).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(options.at(-1)).toHaveFocus();

    fireEvent.keyDown(menu, { key: "Tab" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("escapes the clipping popover it sits in, and Escape closes only the menu", async () => {
    const onClose = vi.fn();
    function InPopover() {
      const anchorRef = useRef<HTMLButtonElement>(null);
      const popoverRef = useRef<HTMLDivElement>(null);
      return (
        <>
          <button ref={anchorRef} type="button">Voice settings</button>
          <ViewportPopover anchorRef={anchorRef} popoverRef={popoverRef} maxWidth={400} className="" ariaLabel="Voice settings" onClose={onClose} keepOpenWithin="[data-voice-picker-menu]">
            <VoiceSelector activeModel="kokoro" voice="af_heart" onVoiceChange={vi.fn()} kokoroVoices={["af_heart", "am_echo"]} />
          </ViewportPopover>
        </>
      );
    }
    render(<InPopover />);
    await act(() => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));
    fireEvent.click(screen.getByRole("button", { name: /Heart/i }));

    const menu = screen.getByRole("menu", { name: "Select voice" });
    const popover = screen.getByRole("dialog", { name: "Voice settings" });
    // Portaled out of the scrolling popover, so its edge cannot clip it.
    expect(popover.contains(menu)).toBe(false);
    expect(menu).toHaveClass("fixed");

    fireEvent.mouseDown(screen.getByRole("menuitemradio", { name: /Echo/ }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole("menuitemradio", { name: /Heart/ }), { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

