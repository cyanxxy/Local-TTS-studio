import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Audio8InlineSettings } from "./Audio8InlineSettings";

function renderSettings(settings: { voice: string; seed: number | null; temperature: number | null }) {
  const onSamplingChange = vi.fn();
  const view = render(
    <Audio8InlineSettings
      voice={settings.voice}
      onVoiceChange={vi.fn()}
      settings={settings}
      onSamplingChange={onSamplingChange}
      cacheInfo={null}
      cacheBusy={false}
      cacheStatus={null}
      onClearCache={vi.fn()}
    />,
  );
  return { ...view, onSamplingChange };
}

describe("Audio8InlineSettings sampling", () => {
  it("leaves the model's temperature and seed alone until the user sets them", () => {
    const { onSamplingChange } = renderSettings({ voice: "clara", seed: null, temperature: null });

    expect(screen.getByText("Default")).toBeInTheDocument();
    expect(screen.getByLabelText("Seed")).toHaveValue(null);
    expect(screen.queryByRole("button", { name: "Use the model default" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Variation/), { target: { value: "0.5" } });
    expect(onSamplingChange).toHaveBeenLastCalledWith({ temperature: 0.5 });
    fireEvent.change(screen.getByLabelText("Seed"), { target: { value: "123" } });
    expect(onSamplingChange).toHaveBeenLastCalledWith({ seed: 123 });
  });

  it("shows a chosen temperature and seed and can go back to the defaults", () => {
    const { onSamplingChange } = renderSettings({ voice: "clara", seed: 9, temperature: 0.7 });

    expect(screen.getByText("0.70")).toBeInTheDocument();
    expect(screen.getByLabelText("Seed")).toHaveValue(9);
    fireEvent.click(screen.getByRole("button", { name: "Use the model default" }));
    expect(onSamplingChange).toHaveBeenLastCalledWith({ temperature: null });
    fireEvent.click(screen.getByRole("button", { name: "Use a random seed" }));
    expect(onSamplingChange).toHaveBeenLastCalledWith({ seed: null });
  });
});
