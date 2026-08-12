import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MODELS } from "../constants";
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
});
