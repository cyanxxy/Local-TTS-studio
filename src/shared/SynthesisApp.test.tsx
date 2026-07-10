import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebApp from "../apps/web/WebApp";
import { SynthesisApp } from "./SynthesisApp";
import type { ModelState } from "../types";

const mock = vi.hoisted(() => {
  const readyState: ModelState = {
    ready: true,
    loading: false,
    downloadProgress: 100,
    error: null,
    backend: "wasm",
  };

  return {
    readyState,
    routing: {
      activePage: "studio",
      availableTabs: [
        { key: "studio", label: "Studio" },
        { key: "reader", label: "Reader" },
      ],
      isReaderPage: false,
      isStudioPage: true,
      navigateToPage: vi.fn(),
    },
    browserSupport: {
      isSupported: true,
      message: null as string | null,
      supportedModels: ["kokoro", "supertonic"],
      unsupportedModelMessages: {} as Record<string, string>,
    },
    initialAppState: {
      model: "kokoro",
      text: "Initial script with enough text.",
      voicesByModel: {
        kokoro: "af_heart",
        supertonic: "Female",
      },
      quality: 5,
    },
    initialCreatorState: {
      preset: "youtube-shorts",
      speed: 1,
      pauseCommaSec: 0.1,
      pauseSentenceSec: 0.2,
      pauseParagraphSec: 0.3,
      pronunciationLexicon: "",
      exportFormat: "wav-pcm24",
      exportSampleRate: 48000,
      exportBitrateKbps: 320,
      masteringEnabled: true,
    },
    modelLoader: {
      kokoroState: readyState,
      supertonicState: readyState,
      kokoroWorker: { current: null },
      supertonicWorker: { current: null },
      kokoroVoices: ["af_heart", "af_bella"],
      loadModel: vi.fn(),
      reloadModel: vi.fn(),
    },
    player: {
      isPlaying: false,
      error: null as string | null,
      currentTime: 0,
      totalDuration: 4,
      playbackRate: 1,
      segments: [{ id: "seg-1", text: "Segment", startSec: 0, endSec: 4, index: 1, total: 1 }],
      activeSegmentId: "seg-1",
      scheduleChunk: vi.fn(async () => {}),
      togglePlay: vi.fn(),
      seek: vi.fn(),
      seekTo: vi.fn(),
      skip: vi.fn(),
      jumpToSegment: vi.fn(),
      setPlaybackRate: vi.fn(),
      download: vi.fn(async () => {}),
      downloadCaptions: vi.fn(),
      replaceSegment: vi.fn(),
      beginStream: vi.fn(),
      endStream: vi.fn(),
      reset: vi.fn(),
      stopAll: vi.fn(),
    },
    tts: {
      isGenerating: false,
      error: null as string | null,
      stats: {
        firstLatency: null,
        processingTime: 0,
        charsPerSec: 0,
        rtf: 0,
        totalDuration: 0,
        currentDuration: 0,
      },
      generationProgress: 0,
      generate: vi.fn(),
      cancel: vi.fn(),
    },
    creator: {
      creatorPreset: "youtube-shorts",
      speed: 1,
      pauseCommaSec: 0.1,
      pauseSentenceSec: 0.2,
      pauseParagraphSec: 0.3,
      pronunciationLexicon: "",
      generationSettings: {
        speed: 1,
        quality: 5,
        pauseOverridesSec: { none: 0, comma: 0.1, sentence: 0.2, paragraph: 0.3 },
        pronunciationRules: [],
      },
      exportOptions: {
        format: "wav-pcm24",
        sampleRate: 48000,
        bitrateKbps: 320,
        mastering: { enabled: true, targetLufs: -14, truePeakDb: -1 },
      },
      persistedState: {
        preset: "youtube-shorts",
        speed: 1,
      },
      onCreatorPresetChange: vi.fn(),
      onSpeedChange: vi.fn(),
      onPauseCommaChange: vi.fn(),
      onPauseSentenceChange: vi.fn(),
      onPauseParagraphChange: vi.fn(),
      onPronunciationLexiconChange: vi.fn(),
      onExportFormatChange: vi.fn(),
      onExportSampleRateChange: vi.fn(),
      onExportBitrateChange: vi.fn(),
      onMasteringEnabledChange: vi.fn(),
    },
    generation: {
      isRetakingSegment: false,
      isGenerationBusy: false,
      cancelActiveGeneration: vi.fn(),
      resetGeneratedAudio: vi.fn(),
      handleGenerate: vi.fn(),
      handleStop: vi.fn(),
      handleRetakeSegment: vi.fn(),
    },
    cache: {
      cacheBusy: false,
      cacheStatus: null,
      clearCache: vi.fn(async () => {}),
      redownloadActiveModel: vi.fn(async () => {}),
      retryActiveModelLoad: vi.fn(),
    },
    localTts: {
      probe: vi.fn(),
      generate: vi.fn(),
      cancel: vi.fn(),
      getQwen3Setup: vi.fn(),
      subscribeQwen3DownloadProgress: vi.fn(),
      subscribeProgress: vi.fn(),
      subscribeAudioChunk: vi.fn(),
    },
    persistAppState: vi.fn(),
    persistCreatorState: vi.fn(),
    getWebGPUStatus: vi.fn(),
  };
});

vi.mock("../hooks/useAppRouting", () => ({
  useAppRouting: () => mock.routing,
}));

vi.mock("../hooks/useModelLoader", () => ({
  useModelLoader: vi.fn(() => mock.modelLoader),
}));

vi.mock("../hooks/useAudioPlayer", () => ({
  useAudioPlayer: () => mock.player,
}));

vi.mock("../hooks/useTTS", () => ({
  useTTS: vi.fn(() => mock.tts),
}));

vi.mock("../hooks/useCreatorSettings", () => ({
  useCreatorSettings: () => mock.creator,
}));

vi.mock("../hooks/useGenerationControl", () => ({
  useGenerationControl: vi.fn((options: { setShowPlayer: (value: boolean) => void }) => ({
    ...mock.generation,
    handleGenerate: () => {
      mock.generation.handleGenerate();
      options.setShowPlayer(true);
    },
  })),
}));

vi.mock("../hooks/useModelCacheControls", () => ({
  useModelCacheControls: () => mock.cache,
}));

vi.mock("../lib/appState", () => ({
  getInitialAppState: () => mock.initialAppState,
  getInitialCreatorState: () => mock.initialCreatorState,
  persistAppState: mock.persistAppState,
  persistCreatorState: mock.persistCreatorState,
}));

vi.mock("../lib/browserSupport", () => ({
  getLocalBrowserSupport: () => mock.browserSupport,
  getDefaultSupportedModel: () => mock.browserSupport.supportedModels[0],
  getUnsupportedModelMessage: (model: string) => mock.browserSupport.unsupportedModelMessages[model] ?? null,
  isModelSupportedInBrowser: (model: string) => mock.browserSupport.supportedModels.includes(model),
}));

vi.mock("../lib/webgpu", () => ({
  getWebGPUStatus: () => mock.getWebGPUStatus(),
}));

vi.mock("../lib/voices", () => ({
  resolveKokoroVoice: (voice: string, voices: string[]) => (voices.includes(voice) ? voice : voices[0] ?? null),
}));

vi.mock("../components/TextInput", () => ({
  TextInput: ({ text, onTextChange }: { text: string; onTextChange: (value: string) => void }) => (
    <textarea aria-label="script" value={text} onChange={(event) => onTextChange(event.target.value)} />
  ),
}));

vi.mock("../components/ModelToggle", () => ({
  ModelToggle: ({
    onModelChange,
    desktopModelOptions = [],
  }: {
    onModelChange: (model: "kokoro" | "supertonic") => void;
    desktopModelOptions?: Array<{ key: string; selected?: boolean; onSelect: () => void }>;
  }) => (
    <div>
      <button type="button" onClick={() => onModelChange("supertonic")}>switch-supertonic</button>
      {desktopModelOptions.map((option) => (
        <button key={option.key} type="button" onClick={option.onSelect}>
          studio-desktop-{option.key}{option.selected ? "-selected" : ""}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("../components/VoiceSelector", () => ({
  VoiceSelector: ({ onVoiceChange }: { onVoiceChange: (voice: string) => void }) => (
    <button type="button" onClick={() => onVoiceChange("af_bella")}>voice-bella</button>
  ),
}));

vi.mock("../components/ControlsContext", () => ({
  ControlsProvider: ({ value, children }: { value: {
    onGenerate: () => void;
    onRetryLoad: () => void;
    onStop: () => void;
    onQualityChange: (value: number) => void;
    quality: number;
  }; children: React.ReactNode }) => (
    <div>
      <button type="button" onClick={value.onGenerate}>generate</button>
      <button type="button" onClick={value.onRetryLoad}>retry-load</button>
      <button type="button" onClick={value.onStop}>stop</button>
      <button type="button" onClick={() => value.onQualityChange(value.quality + 1)}>quality-up</button>
      {children}
    </div>
  ),
}));

vi.mock("../components/Controls", () => ({
  Controls: () => <div data-testid="controls" />,
}));

vi.mock("../components/DownloadProgress", () => ({
  DownloadProgress: () => <div data-testid="download-progress" />,
}));

vi.mock("../components/SettingsPanel", () => ({
  SettingsPanel: ({ onClearCache, onRedownloadActive }: {
    onClearCache: () => void;
    onRedownloadActive: () => void;
  }) => (
    <div>
      <button type="button" onClick={onClearCache}>clear-cache</button>
      <button type="button" onClick={onRedownloadActive}>redownload</button>
    </div>
  ),
}));

vi.mock("../components/CreatorToolsPanel", () => ({
  CreatorToolsPanel: ({ onDownloadAudio, onDownloadCaptions }: {
    onDownloadAudio: () => void;
    onDownloadCaptions: (format: "srt" | "vtt" | "json") => void;
  }) => (
    <div>
      <button type="button" onClick={onDownloadAudio}>creator-audio</button>
      <button type="button" onClick={() => onDownloadCaptions("vtt")}>creator-vtt</button>
    </div>
  ),
}));

vi.mock("../components/AudioPlayer", () => ({
  AudioPlayer: ({ onTogglePlay, onSeek, onSkipBackward, onSkipForward, onDownload, onStop }: {
    onTogglePlay: () => void;
    onSeek: (value: number) => void;
    onSkipBackward: () => void;
    onSkipForward: () => void;
    onDownload: () => void;
    onStop: () => void;
  }) => (
    <div data-testid="audio-player">
      <button type="button" onClick={onTogglePlay}>toggle-play</button>
      <button type="button" onClick={() => onSeek(2)}>seek-two</button>
      <button type="button" onClick={onSkipBackward}>skip-back</button>
      <button type="button" onClick={onSkipForward}>skip-forward</button>
      <button type="button" onClick={onDownload}>player-download</button>
      <button type="button" onClick={onStop}>player-stop</button>
    </div>
  ),
}));

vi.mock("../components/AdvancedReaderPage", () => ({
  AdvancedReaderPage: ({
    text,
    onTextChange,
    onImportDocument,
    isImportingDocument,
    onModelChange,
    onVoiceChange,
    onQualityChange,
    onGenerate,
    onRetryLoad,
    onStop,
    onDownload,
    onRetakeSegment,
    onJumpToSegment,
    desktopModelOptions = [],
  }: {
    text: string;
    onTextChange: (value: string) => void;
    onImportDocument?: () => void;
    isImportingDocument?: boolean;
    onModelChange: (model: "kokoro" | "supertonic") => void;
    onVoiceChange: (voice: string) => void;
    onQualityChange: (value: number) => void;
    onGenerate: () => void;
    onRetryLoad: () => void;
    onStop: () => void;
    onDownload: () => void;
    onRetakeSegment: (segmentId: string) => void;
    onJumpToSegment: (segmentId: string) => void;
    desktopModelOptions?: Array<{ key: string; label: string; selected?: boolean; onSelect: () => void }>;
  }) => (
    <div>
      <div data-testid="reader-text-value">{text}</div>
      {onImportDocument && (
        <button type="button" onClick={onImportDocument}>
          reader-import{isImportingDocument ? "-busy" : ""}
        </button>
      )}
      <button type="button" onClick={() => onTextChange("Reader text with enough length.")}>reader-text</button>
      <button type="button" onClick={() => onModelChange("supertonic")}>reader-model</button>
      <button type="button" onClick={() => onVoiceChange("af_bella")}>reader-voice</button>
      <button type="button" onClick={() => onQualityChange(6)}>reader-quality</button>
      <button type="button" onClick={onGenerate}>reader-generate</button>
      <button type="button" onClick={onRetryLoad}>reader-retry</button>
      <button type="button" onClick={onStop}>reader-stop</button>
      <button type="button" onClick={onDownload}>reader-download</button>
      <button type="button" onClick={() => onRetakeSegment("seg-1")}>reader-retake</button>
      <button type="button" onClick={() => onJumpToSegment("seg-1")}>reader-jump</button>
      <button type="button" onClick={() => onJumpToSegment("")}>reader-empty-jump</button>
      {desktopModelOptions.map((option) => (
        <button key={option.key} type="button" onClick={option.onSelect}>
          reader-desktop-{option.key}{option.selected ? "-selected" : ""}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("../components/LocalRuntimePage", () => ({
  LocalRuntimePage: ({ model, name }: { model: string; name: string }) => (
    <div data-testid={`local-page-${model}`}>
      <div>{name}</div>
      <input data-testid={`local-draft-${model}`} defaultValue={`${model} draft`} />
    </div>
  ),
}));

function resetMockState() {
  vi.clearAllMocks();
  mock.routing = {
    activePage: "studio",
    availableTabs: [
      { key: "studio", label: "Studio" },
      { key: "reader", label: "Reader" },
    ],
    isReaderPage: false,
    isStudioPage: true,
    navigateToPage: vi.fn(),
  };
  mock.browserSupport = {
    isSupported: true,
    message: null,
    supportedModels: ["kokoro", "supertonic"],
    unsupportedModelMessages: {},
  };
  mock.initialAppState = {
    model: "kokoro",
    text: "Initial script with enough text.",
    voicesByModel: {
      kokoro: "af_heart",
      supertonic: "Female",
    },
    quality: 5,
  };
  mock.modelLoader = {
    ...mock.modelLoader,
    kokoroState: mock.readyState,
    supertonicState: mock.readyState,
    kokoroVoices: ["af_heart", "af_bella"],
    loadModel: vi.fn(),
    reloadModel: vi.fn(),
  };
  mock.player = {
    ...mock.player,
    totalDuration: 4,
    segments: [{ id: "seg-1", text: "Segment", startSec: 0, endSec: 4, index: 1, total: 1 }],
    activeSegmentId: "seg-1",
    scheduleChunk: vi.fn(async () => {}),
    togglePlay: vi.fn(),
    seek: vi.fn(),
    skip: vi.fn(),
    jumpToSegment: vi.fn(),
    download: vi.fn(async () => {}),
    downloadCaptions: vi.fn(),
    beginStream: vi.fn(),
    endStream: vi.fn(),
  };
  mock.tts = {
    ...mock.tts,
    isGenerating: false,
    error: null,
    generationProgress: 0,
  };
  mock.generation = {
    ...mock.generation,
    isRetakingSegment: false,
    isGenerationBusy: false,
    cancelActiveGeneration: vi.fn(),
    resetGeneratedAudio: vi.fn(),
    handleGenerate: vi.fn(),
    handleStop: vi.fn(),
    handleRetakeSegment: vi.fn(),
  };
  mock.cache = {
    cacheBusy: false,
    cacheStatus: null,
    clearCache: vi.fn(async () => {}),
    redownloadActiveModel: vi.fn(async () => {}),
    retryActiveModelLoad: vi.fn(),
  };
  mock.localTts = {
    probe: vi.fn(),
    generate: vi.fn(),
    cancel: vi.fn(),
    getQwen3Setup: vi.fn(),
    subscribeQwen3DownloadProgress: vi.fn(),
    subscribeProgress: vi.fn(),
    subscribeAudioChunk: vi.fn(),
  };
  mock.localTts.probe.mockResolvedValue({
    ready: true,
    message: "Rust Qwen3-TTS runtime is ready.",
    runtime: "rust",
  });
  mock.localTts.generate.mockResolvedValue({
    sampleRate: 24_000,
    modelRepo: "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit",
    durationSec: 1,
    elapsedSec: 2,
    audioTransport: "websocket-binary",
    audioChunkCount: 0,
    phaseTimingsSec: {},
  });
  mock.localTts.getQwen3Setup.mockResolvedValue({
    provider: "mlx",
    profiles: [{
      repo: "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit",
      revision: "7dc92af14613355896fcab13b268c19ede233139",
      mode: "customVoice",
      parameters: "0.6B",
      provider: "mlx",
      platforms: ["darwin"],
      weightFormat: "mlx-6bit",
      label: "CustomVoice · 0.6B · MLX 6-bit",
      requiredFiles: ["config.json", "model.safetensors"],
      modelDir: "/cache/qwen3/mlx/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit",
      readiness: "verified",
    }],
    recommendedModelRepo: "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit",
    recommendedModelDir: "/cache/qwen3/mlx/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit",
  });
  mock.localTts.subscribeQwen3DownloadProgress.mockReturnValue(() => undefined);
  mock.localTts.subscribeProgress.mockReturnValue(() => undefined);
  mock.localTts.subscribeAudioChunk.mockReturnValue(() => undefined);
  mock.getWebGPUStatus.mockResolvedValue({ available: false, message: "No GPU available" });
}

describe("SynthesisApp", () => {
  beforeEach(() => {
    resetMockState();
    Object.defineProperty(window, "electron", {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(window, "crossOriginIsolated", {
      value: false,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("orchestrates the supported studio page interactions", async () => {
    render(<WebApp />);

    expect(screen.getByText("Open TTS")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("No GPU available")).toBeInTheDocument());
    expect(screen.getByText("CPU mode")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "Reader" }));
    expect(mock.routing.navigateToPage).toHaveBeenCalledWith("reader");

    fireEvent.change(screen.getByRole("textbox", { name: "script" }), {
      target: { value: "Next script with enough text." },
    });
    expect(mock.generation.cancelActiveGeneration).toHaveBeenCalledWith(true);
    expect(mock.generation.resetGeneratedAudio).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "switch-supertonic" }));
    expect(mock.modelLoader.loadModel).toHaveBeenCalledWith("supertonic");

    fireEvent.click(screen.getByRole("button", { name: "voice-bella" }));
    fireEvent.click(screen.getByRole("button", { name: "quality-up" }));
    fireEvent.click(screen.getByRole("button", { name: "retry-load" }));
    fireEvent.click(screen.getByRole("button", { name: "stop" }));
    fireEvent.click(screen.getByRole("button", { name: "clear-cache" }));
    fireEvent.click(screen.getByRole("button", { name: "redownload" }));
    fireEvent.click(screen.getByRole("button", { name: "creator-audio" }));
    fireEvent.click(screen.getByRole("button", { name: "creator-vtt" }));
    fireEvent.click(screen.getByRole("button", { name: "generate" }));

    expect(mock.cache.retryActiveModelLoad).toHaveBeenCalled();
    expect(mock.generation.handleStop).toHaveBeenCalled();
    expect(mock.cache.clearCache).toHaveBeenCalled();
    expect(mock.cache.redownloadActiveModel).toHaveBeenCalled();
    expect(mock.player.download).toHaveBeenCalledWith(mock.creator.exportOptions);
    expect(mock.player.downloadCaptions).toHaveBeenCalledWith("vtt");
    expect(screen.getByTestId("audio-player")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "toggle-play" }));
    fireEvent.click(screen.getByRole("button", { name: "seek-two" }));
    fireEvent.click(screen.getByRole("button", { name: "skip-back" }));
    fireEvent.click(screen.getByRole("button", { name: "skip-forward" }));
    fireEvent.click(screen.getByRole("button", { name: "player-download" }));
    fireEvent.click(screen.getByRole("button", { name: "player-stop" }));

    expect(mock.player.togglePlay).toHaveBeenCalled();
    expect(mock.player.seek).toHaveBeenCalledWith(2);
    expect(mock.player.skip).toHaveBeenCalledWith(-10);
    expect(mock.player.skip).toHaveBeenCalledWith(10);

    await waitFor(() => expect(mock.persistAppState).toHaveBeenCalled());
    await waitFor(() => expect(mock.persistCreatorState).toHaveBeenCalled());
  });

  it("orchestrates reader controls and segment jumps", () => {
    mock.getWebGPUStatus.mockReturnValue(new Promise(() => {}));
    mock.routing = {
      activePage: "reader",
      availableTabs: [
        { key: "studio", label: "Studio" },
        { key: "reader", label: "Reader" },
      ],
      isReaderPage: true,
      isStudioPage: false,
      navigateToPage: vi.fn(),
    };

    render(<WebApp />);

    fireEvent.click(screen.getByRole("button", { name: "reader-text" }));
    fireEvent.click(screen.getByRole("button", { name: "reader-model" }));
    fireEvent.click(screen.getByRole("button", { name: "reader-voice" }));
    fireEvent.click(screen.getByRole("button", { name: "reader-quality" }));
    fireEvent.click(screen.getByRole("button", { name: "reader-generate" }));
    fireEvent.click(screen.getByRole("button", { name: "reader-retry" }));
    fireEvent.click(screen.getByRole("button", { name: "reader-stop" }));
    fireEvent.click(screen.getByRole("button", { name: "reader-download" }));
    fireEvent.click(screen.getByRole("button", { name: "reader-retake" }));
    fireEvent.click(screen.getByRole("button", { name: "reader-jump" }));
    fireEvent.click(screen.getByRole("button", { name: "reader-empty-jump" }));

    expect(mock.modelLoader.loadModel).toHaveBeenCalledWith("supertonic");
    expect(mock.cache.retryActiveModelLoad).toHaveBeenCalled();
    expect(mock.generation.handleStop).toHaveBeenCalled();
    expect(mock.player.download).toHaveBeenCalledWith(mock.creator.exportOptions);
    expect(mock.generation.handleRetakeSegment).toHaveBeenCalledWith("seg-1");
    expect(mock.player.jumpToSegment).toHaveBeenCalledWith("seg-1");
    expect(mock.player.jumpToSegment).not.toHaveBeenCalledWith("");
  });

  it("runs Qwen3 from the reader model option without leaving the reader tab", async () => {
    mock.getWebGPUStatus.mockReturnValue(new Promise(() => {}));
    Object.defineProperty(window, "electron", {
      value: {
        isElectron: true,
        platform: "darwin",
        localTts: mock.localTts,
      },
      configurable: true,
    });
    mock.routing = {
      activePage: "reader",
      availableTabs: [
        { key: "studio", label: "Studio" },
        { key: "reader", label: "Reader" },
        { key: "qwen3", label: "Qwen3-TTS" },
      ],
      isReaderPage: true,
      isStudioPage: false,
      navigateToPage: vi.fn(),
    };

    render(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);

    fireEvent.click(screen.getByRole("button", { name: "reader-desktop-qwen3" }));
    expect(screen.getByRole("button", { name: "reader-desktop-qwen3-selected" })).toBeInTheDocument();
    await waitFor(() => expect(mock.localTts.getQwen3Setup).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "reader-generate" }));

    expect(mock.generation.cancelActiveGeneration).toHaveBeenCalled();
    expect(mock.generation.resetGeneratedAudio).toHaveBeenCalled();
    expect(mock.routing.navigateToPage).not.toHaveBeenCalledWith("qwen3");
    await waitFor(() => {
      expect(mock.localTts.generate).toHaveBeenCalledWith(expect.objectContaining({
        model: "qwen3",
        payload: expect.objectContaining({
          text: "Initial script with enough text.",
          modelRepo: "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit",
          mode: "customVoice",
        }),
      }));
    });
  });

  it("hides document import on web builds", () => {
    mock.getWebGPUStatus.mockReturnValue(new Promise(() => {}));
    mock.routing = {
      activePage: "reader",
      availableTabs: [
        { key: "studio", label: "Studio" },
        { key: "reader", label: "Reader" },
      ],
      isReaderPage: true,
      isStudioPage: false,
      navigateToPage: vi.fn(),
    };

    render(<WebApp />);

    expect(screen.queryByRole("button", { name: /reader-import/ })).not.toBeInTheDocument();
  });

  it("imports a document on desktop and routes its text through handleTextChange", async () => {
    mock.getWebGPUStatus.mockReturnValue(new Promise(() => {}));
    const importDocument = vi.fn().mockResolvedValue({
      canceled: false,
      fileName: "chapter.pdf",
      text: "Imported chapter text with enough length.",
      pageCount: 2,
    });
    Object.defineProperty(window, "electron", {
      value: {
        isElectron: true,
        platform: "darwin",
        documents: { importDocument },
        localTts: mock.localTts,
      },
      configurable: true,
    });
    mock.routing = {
      activePage: "reader",
      availableTabs: [
        { key: "studio", label: "Studio" },
        { key: "reader", label: "Reader" },
      ],
      isReaderPage: true,
      isStudioPage: false,
      navigateToPage: vi.fn(),
    };

    render(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);

    fireEvent.click(screen.getByRole("button", { name: "reader-import" }));
    expect(importDocument).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByTestId("reader-text-value")).toHaveTextContent(
        "Imported chapter text with enough length.",
      );
    });
  });

  it("shows a stripped import error when the desktop import fails", async () => {
    mock.getWebGPUStatus.mockReturnValue(new Promise(() => {}));
    const importDocument = vi.fn().mockRejectedValue(new Error(
      "Error invoking remote method 'document:import': Error: No readable text found in \"scan.pdf\".",
    ));
    Object.defineProperty(window, "electron", {
      value: {
        isElectron: true,
        platform: "darwin",
        documents: { importDocument },
        localTts: mock.localTts,
      },
      configurable: true,
    });
    mock.routing = {
      activePage: "reader",
      availableTabs: [
        { key: "studio", label: "Studio" },
        { key: "reader", label: "Reader" },
      ],
      isReaderPage: true,
      isStudioPage: false,
      navigateToPage: vi.fn(),
    };

    render(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);

    fireEvent.click(screen.getByRole("button", { name: "reader-import" }));
    await waitFor(() => {
      expect(screen.getByText('No readable text found in "scan.pdf".')).toBeInTheDocument();
    });
  });

  it("runs Qwen3 from the studio model option only in Electron without leaving Studio", async () => {
    mock.getWebGPUStatus.mockReturnValue(new Promise(() => {}));
    const { rerender } = render(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);
    expect(screen.queryByRole("button", { name: "studio-desktop-qwen3" })).not.toBeInTheDocument();

    Object.defineProperty(window, "electron", {
      value: {
        isElectron: true,
        platform: "darwin",
        localTts: mock.localTts,
      },
      configurable: true,
    });
    mock.routing = {
      activePage: "studio",
      availableTabs: [
        { key: "studio", label: "Studio" },
        { key: "reader", label: "Reader" },
        { key: "qwen3", label: "Qwen3-TTS" },
      ],
      isReaderPage: false,
      isStudioPage: true,
      navigateToPage: vi.fn(),
    };

    rerender(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);

    fireEvent.click(screen.getByRole("button", { name: "studio-desktop-qwen3" }));
    expect(screen.getByRole("button", { name: "studio-desktop-qwen3-selected" })).toBeInTheDocument();
    await waitFor(() => expect(mock.localTts.getQwen3Setup).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "generate" }));

    expect(mock.generation.cancelActiveGeneration).toHaveBeenCalled();
    expect(mock.generation.resetGeneratedAudio).toHaveBeenCalled();
    expect(mock.routing.navigateToPage).not.toHaveBeenCalled();
    expect(mock.generation.handleGenerate).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(mock.localTts.generate).toHaveBeenCalledWith(expect.objectContaining({
        model: "qwen3",
        payload: expect.objectContaining({
          text: "Initial script with enough text.",
          modelRepo: "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit",
          mode: "customVoice",
        }),
      }));
    });
  });

  it("renders local runtime routes", () => {
    mock.getWebGPUStatus.mockReturnValue(new Promise(() => {}));
    mock.routing = {
      activePage: "neutts",
      availableTabs: [{ key: "studio", label: "Studio" }],
      isReaderPage: false,
      isStudioPage: false,
      navigateToPage: vi.fn(),
    };

    const { rerender } = render(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);
    expect(screen.getByText("NeuTTS Nano (Neuphonic)")).toBeInTheDocument();

    mock.routing = {
      ...mock.routing,
      activePage: "qwen3",
    };
    rerender(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);

    expect(screen.getByText("Qwen3-TTS 12Hz MLX")).toBeInTheDocument();
  });

  it("preserves local runtime tab DOM state when switching tabs", () => {
    mock.getWebGPUStatus.mockReturnValue(new Promise(() => {}));
    mock.routing = {
      activePage: "neutts",
      availableTabs: [
        { key: "studio", label: "Studio" },
        { key: "neutts", label: "NeuTTS Nano" },
        { key: "qwen3", label: "Qwen3-TTS" },
      ],
      isReaderPage: false,
      isStudioPage: false,
      navigateToPage: vi.fn(),
    };

    const { rerender } = render(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);
    const neuttsState = screen.getByTestId("local-draft-neutts") as HTMLInputElement;
    fireEvent.change(neuttsState, { target: { value: "voice reference kept" } });
    expect(screen.queryByTestId("local-draft-qwen3")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "Qwen3-TTS" }));
    mock.routing = {
      ...mock.routing,
      activePage: "qwen3",
    };
    rerender(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);

    expect(screen.getByTestId("local-runtime-panel-neutts")).toHaveAttribute("hidden");
    const qwen3State = screen.getByTestId("local-draft-qwen3") as HTMLInputElement;
    fireEvent.change(qwen3State, { target: { value: "qwen3 settings kept" } });

    fireEvent.click(screen.getByRole("link", { name: "Studio" }));
    mock.routing = {
      ...mock.routing,
      activePage: "studio",
      isStudioPage: true,
    };
    rerender(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);

    expect(screen.getByTestId("local-runtime-panel-neutts")).toHaveAttribute("hidden");
    expect(screen.getByTestId("local-runtime-panel-qwen3")).toHaveAttribute("hidden");
    expect(screen.getByTestId("local-draft-neutts")).toHaveValue("voice reference kept");
    expect(screen.getByTestId("local-draft-qwen3")).toHaveValue("qwen3 settings kept");

    mock.routing = {
      ...mock.routing,
      activePage: "neutts",
      isStudioPage: false,
    };
    rerender(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);

    expect(screen.getByTestId("local-runtime-panel-neutts")).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("local-runtime-panel-qwen3")).toHaveAttribute("hidden");
    expect(screen.getByTestId("local-draft-neutts")).toHaveValue("voice reference kept");
  });

  it("renders browser support fallback when local inference is unsupported", () => {
    mock.browserSupport = {
      isSupported: false,
      message: "This browser only supports a guarded model set.",
      supportedModels: ["supertonic"],
      unsupportedModelMessages: {
        kokoro: "Kokoro is unavailable here.",
      },
    };

    render(<WebApp />);

    expect(screen.getAllByText("iOS rollout")).toHaveLength(2);
    expect(screen.getAllByText("This browser only supports a guarded model set.")).toHaveLength(3);
  });
});
