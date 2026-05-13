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

    expect(screen.getByText(/American.*Female/)).toBeInTheDocument();
    expect(screen.getByText(/American.*Male/)).toBeInTheDocument();
    expect(screen.getByText("Other")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Echo/i }));
    expect(onVoiceChange).toHaveBeenCalledWith("am_echo");
    expect(screen.queryByText("American - Male")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Heart/i }));
    expect(screen.getByText("Custom voice")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByText("Custom voice")).not.toBeInTheDocument();
  });
});
