import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { AdvancedReaderPage } from "./AdvancedReaderPage";
import type { AudioSegment } from "../hooks/useAudioPlayer";
import type { GenerationStats, ModelState } from "../types";

vi.mock("./ModelToggle", () => ({
  ModelToggle: () => <div data-testid="model-toggle" />,
}));

vi.mock("./VoiceSelector", () => ({
  VoiceSelector: () => <div data-testid="voice-selector" />,
}));

vi.mock("./ControlsContext", () => ({
  ControlsProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("./Controls", () => ({
  Controls: () => <div data-testid="controls" />,
}));

vi.mock("./AudioPlayer", () => ({
  AudioPlayer: () => <div data-testid="audio-player" />,
}));

const readyState: ModelState = {
  loading: false,
  ready: true,
  downloadProgress: 100,
  error: null,
  backend: "webgpu",
};

const defaultStats: GenerationStats = {
  firstLatency: null,
  processingTime: 0,
  charsPerSec: 0,
  rtf: 0,
  totalDuration: 0,
  currentDuration: 0,
};

function createSegment(overrides: Partial<AudioSegment> = {}): AudioSegment {
  return {
    id: "segment-1",
    text: "Hello world.",
    startSec: 0,
    endSec: 1.25,
    index: 1,
    total: 2,
    textStart: 0,
    textEnd: 12,
    ...overrides,
  };
}

function renderReader(overrides: Partial<ComponentProps<typeof AdvancedReaderPage>> = {}) {
  const props: ComponentProps<typeof AdvancedReaderPage> = {
    text: "Hello world. Second sentence.",
    onTextChange: vi.fn(),
    activeModel: "kokoro",
    onModelChange: vi.fn(),
    kokoroState: readyState,
    supertonicState: readyState,
    kokoroVoices: ["af_sarah"],
    voice: "af_sarah",
    onVoiceChange: vi.fn(),
    quality: 5,
    onQualityChange: vi.fn(),
    canGenerate: true,
    modelReady: true,
    modelError: null,
    loadingProgress: 100,
    generationProgress: 0,
    isGenerating: false,
    onGenerate: vi.fn(),
    onRetryLoad: vi.fn(),
    onStop: vi.fn(),
    stats: defaultStats,
    isPlaying: false,
    currentTime: 0,
    totalDuration: 0,
    segments: [],
    activeSegmentId: null,
    onTogglePlay: vi.fn(),
    onSeek: vi.fn(),
    onSkipBackward: vi.fn(),
    onSkipForward: vi.fn(),
    onDownload: vi.fn(),
    isRetaking: false,
    onRetakeSegment: vi.fn(),
    onJumpToSegment: vi.fn(),
    ...overrides,
  };

  return render(<AdvancedReaderPage {...props} />);
}

describe("AdvancedReaderPage", () => {
  it("associates the reading label with the editor textarea", () => {
    renderReader();

    expect(screen.getByLabelText("Reading Text")).toHaveAttribute(
      "placeholder",
      "Type or paste long-form text to read aloud…",
    );
  });

  it("keeps the overlay above the textarea for interactive section badges", () => {
    const { container } = renderReader();
    const overlay = container.querySelector("div[aria-hidden='true'].pointer-events-none");

    expect(overlay).toHaveClass("z-20");
  });

  it("exposes accessible names for reader segment navigation", () => {
    renderReader({
      segments: [createSegment(), createSegment({
        id: "segment-2",
        text: "Second sentence.",
        index: 2,
        textStart: 13,
        textEnd: 29,
      })],
      activeSegmentId: "segment-1",
    });

    expect(screen.getByRole("button", { name: "Previous section" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next section" })).toBeEnabled();
  });
});
