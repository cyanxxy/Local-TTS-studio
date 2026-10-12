import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { getEngine } from "../models/registry";
import { Controls } from "./Controls";
import { ControlsProvider, type ControlsContextValue } from "./ControlsContext";

const defaultProps: ControlsContextValue = {
  qualityRange: getEngine("supertonic").capabilities.quality,
  quality: 5,
  onQualityChange: vi.fn(),
  onGenerate: vi.fn(),
  onRetryLoad: vi.fn(),
  onStop: vi.fn(),
  isGenerating: false,
  canGenerate: true,
  modelReady: true,
  modelError: null,
  loadingProgress: 100,
  generationProgress: 0,
};

function renderControls(overrides: Partial<typeof defaultProps> = {}) {
  const value = { ...defaultProps, ...overrides };
  return render(
    <ControlsProvider value={value}>
      <Controls />
    </ControlsProvider>,
  );
}

describe("Controls", () => {
  it("shows Generate button when model is ready", () => {
    renderControls();
    expect(screen.getByText("Generate")).toBeInTheDocument();
  });

  it("shows Preparing when not ready", () => {
    renderControls({ modelReady: false, loadingProgress: 42 });
    expect(screen.getByText(/Preparing/)).toBeInTheDocument();
  });

  it("shows the quality slider only for engines with a quality range", () => {
    const onQualityChange = vi.fn();
    const { rerender } = render(
      <ControlsProvider value={{ ...defaultProps, onQualityChange }}>
        <Controls />
      </ControlsProvider>,
    );
    expect(screen.getByText("Quality")).toBeInTheDocument();
    const slider = screen.getByRole("slider");
    expect(slider).toHaveAttribute("min", "1");
    expect(slider).toHaveAttribute("max", "20");
    expect(slider).toHaveAttribute("step", "1");
    fireEvent.change(slider, { target: { value: "8" } });
    expect(onQualityChange).toHaveBeenCalledWith(8);

    for (const engine of ["kokoro", "audio8", "qwen3"] as const) {
      rerender(
        <ControlsProvider value={{ ...defaultProps, qualityRange: getEngine(engine).capabilities.quality }}>
          <Controls />
        </ControlsProvider>,
      );
      expect(screen.queryByText("Quality"), engine).not.toBeInTheDocument();
    }

    rerender(
      <ControlsProvider value={{ ...defaultProps, qualityRange: getEngine("supertonic3").capabilities.quality }}>
        <Controls />
      </ControlsProvider>,
    );
    expect(screen.getByText("Quality")).toBeInTheDocument();
  });

  it("shows Stop button during generation", () => {
    renderControls({ isGenerating: true, generationProgress: 50 });
    expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();
  });

  it("disables Generate when canGenerate is false", () => {
    renderControls({ canGenerate: false });
    const button = screen.getByText("Generate");
    expect(button.closest("button")).toBeDisabled();
  });

  it("calls onGenerate when button is clicked", () => {
    const onGenerate = vi.fn();
    renderControls({ onGenerate });
    fireEvent.click(screen.getByText("Generate"));
    expect(onGenerate).toHaveBeenCalledOnce();
  });

  it("shows a retry action when model loading failed", () => {
    const onRetryLoad = vi.fn();
    renderControls({
      canGenerate: false,
      modelReady: false,
      modelError: "WebGPU initialization failed.",
      onRetryLoad,
    });

    expect(screen.getByText("Retry Model Load")).toBeInTheDocument();
    expect(screen.getByText("WebGPU initialization failed.")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Retry Model Load"));
    expect(onRetryLoad).toHaveBeenCalledOnce();
  });

  it("calls onStop when Stop is clicked", () => {
    const onStop = vi.fn();
    renderControls({ isGenerating: true, onStop });
    fireEvent.click(screen.getByRole("button", { name: /stop/i }));
    expect(onStop).toHaveBeenCalledOnce();
  });
});
