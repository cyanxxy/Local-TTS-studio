import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ModelToggle } from "./ModelToggle";
import type { ModelState } from "../types";

const readyState: ModelState = {
  ready: true,
  loading: false,
  downloadProgress: 100,
  error: null,
  backend: "webgpu",
};
const loadingState: ModelState = {
  ready: false,
  loading: true,
  downloadProgress: 50,
  error: null,
  backend: null,
};
const errorState: ModelState = {
  ready: false,
  loading: false,
  downloadProgress: 0,
  error: "Failed",
  backend: null,
};

describe("ModelToggle", () => {
  it("renders both model buttons", () => {
    render(
      <ModelToggle
        activeModel="kokoro"
        onModelChange={() => {}}
        kokoroState={readyState}
        supertonicState={readyState}
      />,
    );
    expect(screen.getByText("Kokoro")).toBeInTheDocument();
    expect(screen.getByText("Supertonic")).toBeInTheDocument();
  });

  it("calls onModelChange when clicking inactive model", () => {
    const onModelChange = vi.fn();
    render(
      <ModelToggle
        activeModel="kokoro"
        onModelChange={onModelChange}
        kokoroState={readyState}
        supertonicState={readyState}
      />,
    );
    fireEvent.click(screen.getByText("Supertonic"));
    expect(onModelChange).toHaveBeenCalledWith("supertonic");
  });

  it("shows green dot for ready model", () => {
    const { container } = render(
      <ModelToggle
        activeModel="kokoro"
        onModelChange={() => {}}
        kokoroState={readyState}
        supertonicState={loadingState}
      />,
    );
    const dots = container.querySelectorAll("span.rounded-full");
    // The kokoro dot should have bg-success
    const kokoroDot = dots[0];
    expect(kokoroDot.className).toContain("bg-success");
  });

  it("shows pulsing dot for loading model", () => {
    const { container } = render(
      <ModelToggle
        activeModel="kokoro"
        onModelChange={() => {}}
        kokoroState={readyState}
        supertonicState={loadingState}
      />,
    );
    const dots = container.querySelectorAll("span.rounded-full");
    const supertonicDot = dots[1];
    expect(supertonicDot.className).toContain("animate-ping-ring");
  });

  it("shows red dot for errored model", () => {
    const { container } = render(
      <ModelToggle
        activeModel="kokoro"
        onModelChange={() => {}}
        kokoroState={errorState}
        supertonicState={readyState}
      />,
    );
    const dots = container.querySelectorAll("span.rounded-full");
    const kokoroDot = dots[0];
    expect(kokoroDot.className).toContain("bg-danger");
  });

  it("disables unavailable models", () => {
    render(
      <ModelToggle
        activeModel="supertonic"
        onModelChange={() => {}}
        kokoroState={loadingState}
        supertonicState={readyState}
        unavailableModels={{ kokoro: "Disabled on iOS" }}
      />,
    );

    const kokoroButton = screen.getByRole("button", { name: /kokoro/i });
    expect(kokoroButton).toBeDisabled();
    expect(kokoroButton).toHaveAttribute("title", "Disabled on iOS");
    expect(screen.getByText("unavailable")).toBeInTheDocument();
  });

  it("renders optional Electron desktop model options alongside browser models", () => {
    const { container } = render(
      <ModelToggle
        activeModel="kokoro"
        onModelChange={() => {}}
        kokoroState={readyState}
        supertonicState={readyState}
        desktopModelOptions={[{
          key: "qwen3",
          label: "Qwen3-TTS",
          badge: "Electron",
          detail: "0.6B CustomVoice MLX / local runtime",
          onSelect: () => {},
        }]}
      />,
    );

    expect(screen.getByText("Kokoro")).toBeInTheDocument();
    expect(screen.getByText("Supertonic")).toBeInTheDocument();
    expect(screen.getByText("Qwen3-TTS")).toBeInTheDocument();
    expect(screen.getByText("Electron")).toBeInTheDocument();
    expect(screen.getByText("0.6B CustomVoice MLX / local runtime")).toBeInTheDocument();
    expect(container.querySelector("[data-testid='model-toggle-grid']")).toHaveClass(
      "grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))]",
      "items-start",
    );
  });

  it("calls the desktop model callback when clicking an Electron option", () => {
    const onModelChange = vi.fn();
    const onSelectQwen3 = vi.fn();

    render(
      <ModelToggle
        activeModel="kokoro"
        onModelChange={onModelChange}
        kokoroState={readyState}
        supertonicState={readyState}
        desktopModelOptions={[{
          key: "qwen3",
          label: "Qwen3-TTS",
          badge: "Electron",
          detail: "0.6B CustomVoice MLX / local runtime",
          onSelect: onSelectQwen3,
        }]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Qwen3-TTS/i }));

    expect(onSelectQwen3).toHaveBeenCalledTimes(1);
    expect(onModelChange).not.toHaveBeenCalled();
  });

  it("marks the selected desktop model as the active pressed option", () => {
    render(
      <ModelToggle
        activeModel="kokoro"
        onModelChange={() => {}}
        kokoroState={readyState}
        supertonicState={readyState}
        desktopModelOptions={[{
          key: "qwen3",
          label: "Qwen3-TTS",
          badge: "Electron",
          detail: "0.6B CustomVoice MLX / local runtime",
          selected: true,
          onSelect: () => {},
        }]}
      />,
    );

    expect(screen.getByRole("button", { name: /Qwen3-TTS/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Kokoro/i })).toHaveAttribute("aria-pressed", "false");
  });
});
