import { describe, expect, it } from "vitest";
import { deriveReaderDockState, type ReaderDockInput } from "./readerDockState";

const ready: ReaderDockInput = {
  hasAudio: false,
  isGenerating: false,
  generationProgress: 0,
  modelReady: true,
  modelError: null,
  generationError: null,
  canGenerate: true,
  charsRemaining: 0,
  loadingProgress: 100,
};

describe("deriveReaderDockState", () => {
  it("offers generation when the model is ready and the text is long enough", () => {
    expect(deriveReaderDockState(ready)).toEqual({
      statusLabel: "Ready to generate",
      showRetry: false,
      isPreparing: false,
      primaryAction: {
        label: "Generate speech",
        disabled: false,
        busy: false,
        progress: undefined,
        icon: "generate",
        tone: "accent",
      },
    });
  });

  it("hands the transport back to the player once audio exists", () => {
    const state = deriveReaderDockState({ ...ready, hasAudio: true });
    expect(state.statusLabel).toBeNull();
    expect(state.primaryAction).toBeUndefined();
  });

  it("reports generation progress and keeps the action busy", () => {
    expect(deriveReaderDockState({ ...ready, isGenerating: true, generationProgress: 42.4 })).toMatchObject({
      statusLabel: "Generating 42%",
      primaryAction: { label: "Generating", busy: true, disabled: true, progress: 42.4, icon: "loading", tone: "neutral" },
    });
    expect(deriveReaderDockState({ ...ready, isGenerating: true }).statusLabel).toBe("Generating…");
    expect(deriveReaderDockState({ ...ready, isGenerating: true, generationProgress: 140 }).primaryAction?.progress)
      .toBe(100);
  });

  it("turns a model load failure into a retry action", () => {
    expect(deriveReaderDockState({ ...ready, modelReady: false, modelError: "no WebGPU" })).toMatchObject({
      statusLabel: "Model failed to load",
      showRetry: true,
      primaryAction: { label: "Retry model load", disabled: false, icon: "retry", tone: "danger" },
    });
  });

  it("never reads a failed generation as ready", () => {
    expect(deriveReaderDockState({ ...ready, generationError: "Invalid language identifier" })).toMatchObject({
      statusLabel: "Generation failed · try again",
      primaryAction: { label: "Try generating again", tone: "danger" },
    });
  });

  it("shows model preparation progress", () => {
    expect(deriveReaderDockState({ ...ready, modelReady: false, loadingProgress: 37.6 })).toMatchObject({
      statusLabel: "Preparing 38%",
      isPreparing: true,
      primaryAction: { label: "Preparing 38%", disabled: true, busy: true, progress: 37.6, icon: "loading" },
    });
    expect(deriveReaderDockState({ ...ready, modelReady: false, loadingProgress: 0 })).toMatchObject({
      statusLabel: "Preparing…",
      primaryAction: { label: "Preparing" },
    });
  });

  it("explains how much text is still missing", () => {
    expect(deriveReaderDockState({ ...ready, canGenerate: false, charsRemaining: 1 })).toMatchObject({
      statusLabel: "Need 1 more character",
      primaryAction: { disabled: true, tone: "neutral" },
    });
    expect(deriveReaderDockState({ ...ready, canGenerate: false, charsRemaining: 1200 }).statusLabel)
      .toBe(`Need ${(1200).toLocaleString()} more characters`);
    expect(deriveReaderDockState({ ...ready, canGenerate: false }).statusLabel).toBe("Ready");
  });
});
