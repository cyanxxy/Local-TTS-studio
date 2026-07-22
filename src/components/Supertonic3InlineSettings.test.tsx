import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Supertonic3InlineSettings } from "./Supertonic3InlineSettings";

describe("Supertonic3InlineSettings", () => {
  it("exposes the published voice and language controls", () => {
    const onVoiceChange = vi.fn();
    const onLanguageChange = vi.fn();
    render(
      <Supertonic3InlineSettings
        voice="M1"
        language="en"
        onVoiceChange={onVoiceChange}
        onLanguageChange={onLanguageChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("Supertonic 3 voice"), { target: { value: "F3" } });
    fireEvent.change(screen.getByLabelText("Supertonic 3 language"), { target: { value: "nl" } });
    expect(onVoiceChange).toHaveBeenCalledWith("F3");
    expect(onLanguageChange).toHaveBeenCalledWith("nl");
    expect(screen.getByText(/expression tags/i)).toBeInTheDocument();
  });
});
