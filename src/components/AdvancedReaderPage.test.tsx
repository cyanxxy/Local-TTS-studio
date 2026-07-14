import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { AdvancedReaderPage } from "./AdvancedReaderPage";
import type { AudioSegment } from "../hooks/useAudioPlayer";
import type { GenerationStats, ModelState } from "../types";
import { createReaderDocument } from "../lib/readerDocument";

vi.mock("./ModelToggle", () => ({
  ModelToggle: ({ desktopModelOptions = [] }: {
    desktopModelOptions?: Array<{ key: string; label: string; onSelect: () => void }>;
  }) => (
    <div data-testid="model-toggle">
      {desktopModelOptions.map((option) => (
        <button key={option.key} type="button" onClick={option.onSelect}>{option.label}</button>
      ))}
    </div>
  ),
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

const audioPlayerMock = vi.hoisted(() => vi.fn());

vi.mock("./AudioPlayer", () => ({
  AudioPlayer: (props: Record<string, unknown>) => {
    audioPlayerMock(props);
    return <div data-testid="audio-player" />;
  },
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
  beforeEach(() => {
    audioPlayerMock.mockClear();
  });

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

  it("keeps play/pause usable while later chunks are still generating", () => {
    const onTogglePlay = vi.fn();
    renderReader({
      totalDuration: 4,
      isGenerating: true,
      isPlaying: true,
      onTogglePlay,
      segments: [createSegment()],
    });

    expect(screen.getByTestId("audio-player")).toBeInTheDocument();
    const props = audioPlayerMock.mock.lastCall?.[0] as {
      allowPlaybackDuringGeneration?: boolean;
      isGenerating?: boolean;
      onTogglePlay?: () => void;
    };

    expect(props.allowPlaybackDuringGeneration).toBe(true);
    expect(props.isGenerating).toBe(true);
    props.onTogglePlay?.();
    expect(onTogglePlay).toHaveBeenCalledTimes(1);
  });

  it("passes playback speed through the shared audio player", () => {
    const onPlaybackRateChange = vi.fn();
    renderReader({
      totalDuration: 4,
      playbackRate: 1,
      onPlaybackRateChange,
      segments: [createSegment()],
    });

    const props = audioPlayerMock.mock.lastCall?.[0] as {
      playbackRate?: number;
      onPlaybackRateChange?: (rate: number) => void;
    };

    expect(props.playbackRate).toBe(1);
    props.onPlaybackRateChange?.(1.25);
    expect(onPlaybackRateChange).toHaveBeenCalledWith(1.25);
  });

  it("passes reader segment navigation to the shared audio player", () => {
    const onJumpToSegment = vi.fn();
    renderReader({
      segments: [createSegment(), createSegment({
        id: "segment-2",
        text: "Second sentence.",
        index: 2,
        textStart: 13,
        textEnd: 29,
      })],
      activeSegmentId: "segment-1",
      onJumpToSegment,
    });

    const props = audioPlayerMock.mock.lastCall?.[0] as {
      canPreviousSegment?: boolean;
      canNextSegment?: boolean;
      onNextSegment?: () => void;
    };

    expect(props.canPreviousSegment).toBe(false);
    expect(props.canNextSegment).toBe(true);
    props.onNextSegment?.();
    expect(onJumpToSegment).toHaveBeenCalledWith("segment-2");
  });

  it("offers Electron desktop model options from the reader settings", () => {
    const onSelectQwen3 = vi.fn();
    renderReader({
      desktopModelOptions: [{
        key: "qwen3",
        label: "Qwen3-TTS",
        badge: "Electron",
        detail: "0.6B CustomVoice MLX",
        onSelect: onSelectQwen3,
      }],
    });

    fireEvent.click(screen.getByRole("button", { name: "Voice settings" }));
    fireEvent.click(screen.getByRole("button", { name: /Qwen3-TTS/i }));

    expect(onSelectQwen3).toHaveBeenCalledTimes(1);
  });

  it("highlights the estimated current word inside the active audio segment", () => {
    const { container } = renderReader({
      text: "Hello extraordinary world.",
      totalDuration: 3,
      currentTime: 1.5,
      isPlaying: true,
      activeSegmentId: "segment-1",
      segments: [createSegment({
        text: "Hello extraordinary world.",
        startSec: 0,
        endSec: 3,
        textStart: 0,
        textEnd: 26,
      })],
    });

    expect(container.querySelector("[data-reader-active-word='true']")).toHaveTextContent("extraordinary");
  });

  it("opens the local library, navigates the table of contents, and creates bookmarks", () => {
    const onJumpToSegment = vi.fn();
    const onAddBookmark = vi.fn();
    const document = createReaderDocument({
      id: "doc-1",
      title: "Structured book",
      author: "Local Author",
      text: "# Opening\nFirst text.\n\n# Ending\nFinal text.",
    });
    renderReader({
      text: document.text,
      documents: [document],
      activeDocument: document,
      onOpenDocument: vi.fn(),
      onNewDocument: vi.fn(),
      onDeleteDocument: vi.fn(),
      onUpdateDocumentMetadata: vi.fn(),
      onAddBookmark,
      onRemoveBookmark: vi.fn(),
      onAddNote: vi.fn(),
      onUpdateNote: vi.fn(),
      onRemoveNote: vi.fn(),
      onJumpToSegment,
      totalDuration: 4,
      activeSegmentId: "segment-1",
      segments: [createSegment({
        text: "# Opening\nFirst text.",
        textStart: 0,
        textEnd: document.chapters[1]?.start ?? document.text.length,
      }), createSegment({
        id: "segment-2",
        text: "# Ending\nFinal text.",
        startSec: 2,
        endSec: 4,
        textStart: document.chapters[1]?.start ?? 0,
        textEnd: document.text.length,
      })],
    });

    fireEvent.click(screen.getByRole("button", { name: "Open Reader library" }));
    fireEvent.click(screen.getByRole("button", { name: "Contents" }));
    fireEvent.click(screen.getByRole("button", { name: /Ending/ }));
    expect(onJumpToSegment).toHaveBeenCalledWith("segment-2");

    fireEvent.click(screen.getByRole("button", { name: "Bookmarks" }));
    fireEvent.click(screen.getByRole("button", { name: "Bookmark this position" }));
    expect(onAddBookmark).toHaveBeenCalledWith(expect.objectContaining({ positionSec: 0 }));
  });

  it("updates the visible chapter when navigating a document before audio exists", () => {
    const document = createReaderDocument({
      id: "doc-no-audio",
      title: "Quiet chapters",
      text: "# Opening\nFirst text.\n\n# Ending\nFinal text.",
    });
    renderReader({
      text: document.text,
      documents: [document],
      activeDocument: document,
    });

    fireEvent.click(screen.getByRole("button", { name: "Open Reader library" }));
    fireEvent.click(screen.getByRole("button", { name: "Contents" }));
    fireEvent.click(screen.getByRole("button", { name: /Ending/ }));

    expect(screen.getByRole("button", { name: "Chapter 2 of 2: Ending" })).toBeInTheDocument();
  });

  it("imports article URLs from the toolbar", async () => {
    const onImportUrl = vi.fn(async () => {});
    renderReader({ onImportUrl });
    fireEvent.click(screen.getByRole("button", { name: "Import from URL" }));
    fireEvent.change(screen.getByPlaceholderText("https://example.com/article"), {
      target: { value: "https://example.com/story" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import article" }));
    await waitFor(() => expect(onImportUrl).toHaveBeenCalledWith("https://example.com/story"));
  });
});
