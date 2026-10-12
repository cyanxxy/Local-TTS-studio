import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import WebApp from "../apps/web/WebApp";
import { SynthesisApp } from "./SynthesisApp";
import { useGenerationControl } from "../hooks/useGenerationControl";
import { useModelLoader } from "../hooks/useModelLoader";
import type { AudioSegment } from "../hooks/useAudioPlayer";
import type { ModelState, ModelType } from "../types";
import { getDefaultQwen3Profile, type Qwen3Profile } from "../../electron/qwen3Profiles";
import { ENGINES, engineSignatureParts, type DesktopInlineEngineId } from "../models/registry";
import type { PersistedEngineSettings } from "../lib/appState";
import {
  buildAudioSignature,
  buildReaderSections,
  createReaderAudioCacheKey,
  createReaderDocument,
  getReaderSectionText,
  type CachedReaderAudio,
  type ReaderDocumentRecord,
  type ReaderSection,
} from "../lib/readerDocument";

const mock = vi.hoisted(() => {
  // Minimal stand-in for PlaybackClock. It cannot be the real class: vi.hoisted
  // runs before module imports are evaluated.
  const clockListeners = new Set<() => void>();
  let clockPosition = 0;
  const playerClock = {
    subscribe: (listener: () => void) => {
      clockListeners.add(listener);
      return () => clockListeners.delete(listener);
    },
    getTime: () => clockPosition,
    set: (next: number) => {
      if (next === clockPosition) return;
      clockPosition = next;
      for (const listener of [...clockListeners]) listener();
    },
  };

  const readyState: ModelState = {
    ready: true,
    loading: false,
    downloadProgress: 100,
    error: null,
    backend: "wasm",
  };

  return {
    playerClock,
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
      quality: 5,
      desktopModels: {
        studio: null as DesktopInlineEngineId | null,
        reader: null as DesktopInlineEngineId | null,
      },
    },
    // Filled from the real descriptor defaults by resetMockState.
    initialEngineSettings: {} as PersistedEngineSettings,
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
    readerError: null as Error | null,
    modelLoader: {
      states: { kokoro: readyState, supertonic: readyState } as Partial<Record<ModelType, ModelState>>,
      getWorker: vi.fn(() => null),
      voices: { kokoro: ["af_heart", "af_bella"], supertonic: [] as string[] } as Partial<Record<ModelType, string[]>>,
      getWorkerLease: vi.fn(() => null),
      acquireWorker: vi.fn(),
      hardRestartModel: vi.fn(),
      loadModel: vi.fn(),
      reloadModel: vi.fn(),
    },
    player: {
      isPlaying: false,
      isSynthesisComplete: false,
      error: null as string | null,
      clock: playerClock,
      getCurrentTime: () => playerClock.getTime(),
      totalDuration: 4,
      playbackRate: 1,
      segments: [{ id: "seg-1", text: "Segment", startSec: 0, endSec: 4, index: 1, total: 1 }] as AudioSegment[],
      activeSegmentId: "seg-1",
      scheduleChunk: vi.fn(async () => {}),
      togglePlay: vi.fn(),
      seek: vi.fn(),
      seekTo: vi.fn(),
      skip: vi.fn(),
      jumpToSegment: vi.fn(),
      setPlaybackRate: vi.fn(),
      download: vi.fn(async () => null),
      downloadCaptions: vi.fn(),
      replaceSegment: vi.fn(),
      getAudioChunkCount: vi.fn(() => 0),
      getSourceSampleRate: vi.fn(() => null),
      getContentEpoch: vi.fn(() => 0),
      truncateAudioChunks: vi.fn(),
      getAudioCacheSnapshot: vi.fn((): CachedReaderAudio["chunks"] => []),
      getPlaybackSnapshot: vi.fn(() => ({ playbackRate: 1, totalDuration: 4, synthesisComplete: false })),
      restoreAudioCache: vi.fn(),
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
      dictionaries: [] as never[],
      normalizeSpeech: false,
      cleanupOnSpeak: false,
      speechSettings: { dictionaries: [] as never[], normalize: false, cleanup: false },
      captionStyle: "readable",
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
      onDictionariesChange: vi.fn(),
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
    audio8Runtime: {
      modelState: readyState,
      canGenerate: true,
      isGenerating: false,
      generationProgress: 0,
      stats: {
        firstLatency: null,
        processingTime: 0,
        charsPerSec: 0,
        rtf: 0,
        totalDuration: 0,
        currentDuration: 0,
      },
      error: null as string | null,
      cacheInfo: null as { path: string; exists: boolean; sizeBytes: number } | null,
      cacheBusy: false,
      cacheStatus: null as { tone: "success" | "error" | "info"; text: string } | null,
      handleGenerate: vi.fn(),
      handleStop: vi.fn(),
      cancelActiveGeneration: vi.fn(),
      resetGeneratedAudio: vi.fn(),
      retryLoad: vi.fn(),
      clearCache: vi.fn(),
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
    persistEngineSettings: vi.fn(),
    getWebGPUStatus: vi.fn(),
    readerLibrary: {
      documents: [] as ReaderDocumentRecord[],
      activeDocument: null as ReaderDocumentRecord | null,
      loading: false,
      error: null as string | null,
      persistent: true,
      createDocument: vi.fn(async (input: Record<string, unknown>) => input),
      openDocument: vi.fn(async () => undefined),
      deleteDocument: vi.fn(async () => undefined),
      updateActiveText: vi.fn(),
      finalizeActiveTextEdit: vi.fn(),
      updateActiveMetadata: vi.fn(),
      updateProgress: vi.fn(),
      updateActiveListening: vi.fn(),
      flushProgress: vi.fn(),
      addBookmark: vi.fn(),
      removeBookmark: vi.fn(),
      addNote: vi.fn(),
      updateNote: vi.fn(),
      removeNote: vi.fn(),
      saveAudio: vi.fn(async () => undefined),
      loadAudio: vi.fn(async (): Promise<CachedReaderAudio | null> => null),
      hasAudio: vi.fn(async () => false),
      clearAudio: vi.fn(async () => undefined),
    },
  };
});

// The OS media session is covered by its own tests; jsdom cannot play media.
vi.mock("../hooks/useReaderMediaSession", () => ({
  useReaderMediaSession: vi.fn(),
}));

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

vi.mock("../hooks/useReaderLibrary", () => ({
  useReaderLibrary: () => mock.readerLibrary,
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

vi.mock("../hooks/useAudio8Runtime", () => ({
  // The real hook calls setShowPlayer(true) when generation starts; mirror that
  // so tests can observe the fields Studio only renders alongside the player.
  useAudio8Runtime: (options: { setShowPlayer: (value: boolean) => void }) => ({
    ...mock.audio8Runtime,
    handleGenerate: () => {
      mock.audio8Runtime.handleGenerate();
      options.setShowPlayer(true);
    },
  }),
}));

vi.mock("../hooks/useModelCacheControls", () => ({
  useModelCacheControls: () => mock.cache,
}));

vi.mock("../lib/appState", () => ({
  getInitialAppState: () => mock.initialAppState,
  getInitialCreatorState: () => mock.initialCreatorState,
  getInitialEngineSettings: () => mock.initialEngineSettings,
  persistAppState: mock.persistAppState,
  persistCreatorState: mock.persistCreatorState,
  persistEngineSettings: mock.persistEngineSettings,
}));

vi.mock("../lib/browserSupport", () => ({
  getLocalBrowserSupport: () => mock.browserSupport,
  getDefaultSupportedModel: (support: { supportedModels: readonly string[] }) => support.supportedModels[0],
  getUnsupportedModelMessage: (model: string) => mock.browserSupport.unsupportedModelMessages[model] ?? null,
  isModelSupportedInBrowser: (model: string, support: { supportedModels: readonly string[] }) => support.supportedModels.includes(model),
  withoutUnavailableModels: (
    support: { supportedModels: readonly string[] },
    unavailable: Record<string, string>,
  ) => ({ ...support, supportedModels: support.supportedModels.filter((model) => !(model in unavailable)) }),
  getWebGPUUnavailableModelMessages: (available: boolean | null) => (
    available === false ? { chatterbox: "Chatterbox Turbo needs WebGPU, which this device does not provide." } : {}
  ),
}));

vi.mock("../lib/webgpu", () => ({
  getWebGPUStatus: () => mock.getWebGPUStatus(),
}));

vi.mock("../lib/voices", () => ({
  resolveKokoroVoice: (voice: string, voices: string[]) => (voices.includes(voice) ? voice : voices[0] ?? null),
}));

vi.mock("../components/TextInput", () => ({
  TextInput: ({ text, onTextChange, onImportDocument }: {
    text: string;
    onTextChange: (value: string) => void;
    onImportDocument?: () => void;
  }) => (
    <div>
      <textarea aria-label="script" value={text} onChange={(event) => onTextChange(event.target.value)} />
      {onImportDocument && <button type="button" onClick={onImportDocument}>studio-import</button>}
    </div>
  ),
}));

vi.mock("../components/ModelToggle", () => ({
  ModelToggle: ({
    onModelChange,
    visibleModels = ["kokoro", "supertonic"],
    desktopModelOptions = [],
  }: {
    onModelChange: (model: "kokoro" | "supertonic") => void;
    visibleModels?: readonly ("kokoro" | "supertonic")[];
    desktopModelOptions?: Array<{ key: string; selected?: boolean; onSelect: () => void }>;
  }) => (
    <div>
      {visibleModels.includes("supertonic") && (
        <button type="button" onClick={() => onModelChange("supertonic")}>switch-supertonic</button>
      )}
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
    qualityRange: { min: number; max: number } | null;
    canGenerate: boolean;
    isGenerating: boolean;
    modelReady: boolean;
    modelError: string | null;
    loadingProgress: number;
    generationProgress: number;
  }; children: React.ReactNode }) => (
    <div>
      <button type="button" onClick={value.onGenerate}>generate</button>
      <button type="button" onClick={value.onRetryLoad}>retry-load</button>
      <button type="button" onClick={value.onStop}>stop</button>
      <button type="button" onClick={() => value.onQualityChange(value.quality + 1)}>quality-up</button>
      {/* Every field Studio hands to Controls is rendered so a test can tell
          which runtime each one came from. */}
      <div data-testid="controls-quality-range">
        {value.qualityRange ? `${value.qualityRange.min}-${value.qualityRange.max}` : "none"}
      </div>
      <div data-testid="controls-can-generate">{String(value.canGenerate)}</div>
      <div data-testid="controls-is-generating">{String(value.isGenerating)}</div>
      <div data-testid="controls-model-ready">{String(value.modelReady)}</div>
      <div data-testid="controls-model-error">{value.modelError ?? "none"}</div>
      <div data-testid="controls-loading-progress">{value.loadingProgress}</div>
      <div data-testid="controls-generation-progress">{value.generationProgress}</div>
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
  CreatorToolsPanel: ({ audioExport, onDownloadCaptions, engineSupport }: {
    audioExport: { start: () => void };
    onDownloadCaptions: (format: "srt" | "vtt" | "json") => void;
    engineSupport?: { engineLabel: string; speed: boolean; pauses: boolean; normalization: boolean; speechLanguage?: string };
  }) => (
    <div>
      <div data-testid="creator-engine">{engineSupport?.engineLabel ?? "none"}</div>
      <div data-testid="creator-speed-disabled">{String(engineSupport ? !engineSupport.speed : false)}</div>
      <div data-testid="creator-pauses-disabled">{String(engineSupport ? !engineSupport.pauses : false)}</div>
      <div data-testid="creator-language">{engineSupport?.speechLanguage ?? "default"}</div>
      <button type="button" onClick={audioExport.start}>creator-audio</button>
      <button type="button" onClick={() => onDownloadCaptions("vtt")}>creator-vtt</button>
    </div>
  ),
}));

vi.mock("../components/AudioPlayer", () => ({
  AudioPlayer: ({ onTogglePlay, onSeek, onSkipBackward, onSkipForward, onDownload, onStop, stats }: {
    onTogglePlay: () => void;
    onSeek: (value: number) => void;
    onSkipBackward: () => void;
    onSkipForward: () => void;
    onDownload: () => void;
    onStop: () => void;
    stats?: { processingTime: number };
  }) => (
    <div data-testid="audio-player">
      <div data-testid="player-processing-time">{stats?.processingTime}</div>
      <button type="button" onClick={onTogglePlay}>toggle-play</button>
      <button type="button" onClick={() => onSeek(2)}>seek-two</button>
      <button type="button" onClick={onSkipBackward}>skip-back</button>
      <button type="button" onClick={onSkipForward}>skip-forward</button>
      <button type="button" onClick={onDownload}>player-download</button>
      <button type="button" onClick={onStop}>player-stop</button>
    </div>
  ),
}));

vi.mock("../components/AdvancedReaderPage", () => {
  const ReaderView = ({
    text,
    onTextChange,
    onImportDocument,
    onImportFile,
    onImportUrl,
    isImportingDocument,
    onModelChange,
    onVoiceChange,
    onQualityChange,
    onPlaybackRateChange,
    onGenerate,
    onRetryLoad,
    onStop,
    onDownload,
    onRetakeSegment,
    onJumpToSegment,
    desktopModelOptions = [],
    desktopVoiceLabel,
    desktopModelSettings,
    activeSection,
    nextSection,
    onNavigateToOffset,
    onEditStart,
    onEditEnd,
    onAutoAdvanceHoldChange,
    canGenerate,
    isGenerating,
    modelReady,
    modelError,
    loadingProgress,
    generationProgress,
    stats,
  }: {
    text: string;
    onTextChange: (value: string) => void;
    onImportDocument?: () => void;
    onImportFile?: (file: File) => void;
    onImportUrl?: (url: string) => Promise<void>;
    isImportingDocument?: boolean;
    onModelChange: (model: "kokoro" | "supertonic") => void;
    onVoiceChange: (voice: string) => void;
    onQualityChange: (value: number) => void;
    onPlaybackRateChange: (rate: number) => void;
    onGenerate: () => void;
    onRetryLoad: () => void;
    onStop: () => void;
    onDownload: () => void;
    onRetakeSegment: (segmentId: string) => void;
    onJumpToSegment: (segmentId: string) => void;
    desktopModelOptions?: Array<{ key: string; label: string; selected?: boolean; onSelect: () => void }>;
    desktopVoiceLabel?: string;
    desktopModelSettings?: React.ReactNode;
    activeSection?: ReaderSection | null;
    nextSection?: ReaderSection | null;
    onNavigateToOffset?: (offset: number, positionSec?: number) => void;
    onEditStart?: () => void;
    onEditEnd?: () => void;
    onAutoAdvanceHoldChange?: (held: boolean) => void;
    canGenerate?: boolean;
    isGenerating?: boolean;
    modelReady?: boolean;
    modelError?: string | null;
    loadingProgress?: number;
    generationProgress?: number;
    stats?: { processingTime: number };
  }) => (
    <div>
      <div data-testid="reader-text-value">{text}</div>
      <div data-testid="reader-section-id">{activeSection?.id ?? "none"}</div>
      {/* Mirrors the Controls mock: the Reader's own copy of the runtime
          fields, so a mis-wired arm shows up here too. */}
      <div data-testid="reader-can-generate">{String(canGenerate)}</div>
      <div data-testid="reader-is-generating">{String(isGenerating)}</div>
      <div data-testid="reader-model-ready">{String(modelReady)}</div>
      <div data-testid="reader-model-error">{modelError ?? "none"}</div>
      <div data-testid="reader-loading-progress">{loadingProgress}</div>
      <div data-testid="reader-generation-progress">{generationProgress}</div>
      <div data-testid="reader-processing-time">{stats?.processingTime}</div>
      {desktopVoiceLabel && <div data-testid="reader-desktop-voice">{desktopVoiceLabel}</div>}
      {desktopModelSettings}
      {onImportDocument && (
        <button type="button" onClick={onImportDocument}>
          reader-import{isImportingDocument ? "-busy" : ""}
        </button>
      )}
      {onImportFile && <button type="button">reader-file-import</button>}
      {onImportUrl && (
        <button type="button" onClick={() => void onImportUrl("https://example.com").catch(() => undefined)}>
          reader-url-import
        </button>
      )}
      <button type="button" onClick={() => onTextChange("Reader text with enough length.")}>reader-text</button>
      <button type="button" onClick={onEditStart}>reader-edit-start</button>
      {onAutoAdvanceHoldChange && (
        <button type="button" onClick={() => onAutoAdvanceHoldChange(true)}>reader-hold-continuation</button>
      )}
      <button
        type="button"
        onClick={() => {
          onTextChange("CHAPTER REPLACED   \n\n\n\n\nDraft ending.   ");
          onEditEnd?.();
        }}
      >
        reader-edit-finish
      </button>
      <button type="button" onClick={() => onModelChange("supertonic")}>reader-model</button>
      <button type="button" onClick={() => onVoiceChange("af_bella")}>reader-voice</button>
      <button type="button" onClick={() => onQualityChange(6)}>reader-quality</button>
      <button type="button" onClick={() => onPlaybackRateChange(1.5)}>reader-rate</button>
      <button type="button" onClick={onGenerate}>reader-generate</button>
      <button type="button" onClick={onRetryLoad}>reader-retry</button>
      <button type="button" onClick={onStop}>reader-stop</button>
      <button type="button" onClick={onDownload}>reader-download</button>
      <button type="button" onClick={() => onRetakeSegment("seg-1")}>reader-retake</button>
      <button type="button" onClick={() => onJumpToSegment("seg-1")}>reader-jump</button>
      <button type="button" onClick={() => onJumpToSegment("")}>reader-empty-jump</button>
      {nextSection && (
        <button type="button" onClick={() => onNavigateToOffset?.(nextSection.start)}>
          reader-next-section
        </button>
      )}
      {desktopModelOptions.map((option) => (
        <button key={option.key} type="button" onClick={option.onSelect}>
          reader-desktop-{option.key}{option.selected ? "-selected" : ""}
        </button>
      ))}
    </div>
  );
  return {
    AdvancedReaderPage: (props: Parameters<typeof ReaderView>[0]) => {
      if (mock.readerError) throw mock.readerError;
      return ReaderView(props);
    },
  };
});

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
    quality: 5,
    desktopModels: { studio: null, reader: null },
  };
  mock.initialEngineSettings = {
    kokoro: ENGINES.kokoro.defaultSettings,
    supertonic: { ...ENGINES.supertonic.defaultSettings, voice: "Female" },
    kitten: ENGINES.kitten.defaultSettings,
    paradee: ENGINES.paradee.defaultSettings,
    piper: ENGINES.piper.defaultSettings,
    chatterbox: ENGINES.chatterbox.defaultSettings,
    audio8: ENGINES.audio8.defaultSettings,
    supertonic3: ENGINES.supertonic3.defaultSettings,
    neutts: ENGINES.neutts.defaultSettings,
    qwen3: ENGINES.qwen3.defaultSettings,
  };
  mock.readerError = null;
  mock.modelLoader = {
    ...mock.modelLoader,
    states: { kokoro: mock.readyState, supertonic: mock.readyState },
    voices: { kokoro: ["af_heart", "af_bella"], supertonic: [] },
    getWorkerLease: vi.fn(() => null),
    hardRestartModel: vi.fn(),
    loadModel: vi.fn(),
    reloadModel: vi.fn(),
  };
  mock.playerClock.set(0);
  mock.player = {
    ...mock.player,
    isPlaying: false,
    isSynthesisComplete: false,
    error: null,
    clock: mock.playerClock,
    getCurrentTime: () => mock.playerClock.getTime(),
    totalDuration: 4,
    playbackRate: 1,
    segments: [{ id: "seg-1", text: "Segment", startSec: 0, endSec: 4, index: 1, total: 1 }],
    activeSegmentId: "seg-1",
    scheduleChunk: vi.fn(async () => {}),
    togglePlay: vi.fn(),
    seek: vi.fn(),
    skip: vi.fn(),
    jumpToSegment: vi.fn(),
    download: vi.fn(async () => null),
    downloadCaptions: vi.fn(),
    getAudioChunkCount: vi.fn(() => 0),
    getSourceSampleRate: vi.fn(() => null),
    getContentEpoch: vi.fn(() => 0),
    truncateAudioChunks: vi.fn(),
    getAudioCacheSnapshot: vi.fn(() => []),
    // Read from the latest mocked player state, as the real one reads its refs.
    getPlaybackSnapshot: vi.fn(() => ({
      playbackRate: mock.player.playbackRate,
      totalDuration: mock.player.totalDuration,
      synthesisComplete: mock.player.isSynthesisComplete,
    })),
    restoreAudioCache: vi.fn(),
    beginStream: vi.fn(),
    endStream: vi.fn(),
    reset: vi.fn(),
    stopAll: vi.fn(),
  };
  mock.tts = {
    ...mock.tts,
    isGenerating: false,
    error: null,
    generationProgress: 0,
  };
  mock.creator = {
    ...mock.creator,
    generationSettings: {
      speed: 1,
      quality: 5,
      pauseOverridesSec: { none: 0, comma: 0.1, sentence: 0.2, paragraph: 0.3 },
      pronunciationRules: [],
    },
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
  mock.audio8Runtime = {
    ...mock.audio8Runtime,
    modelState: mock.readyState,
    canGenerate: true,
    isGenerating: false,
    generationProgress: 0,
    error: null,
    cacheInfo: null,
    cacheBusy: false,
    cacheStatus: null,
    handleGenerate: vi.fn(),
    handleStop: vi.fn(),
    cancelActiveGeneration: vi.fn(),
    resetGeneratedAudio: vi.fn(),
    retryLoad: vi.fn(),
    clearCache: vi.fn(),
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
  mock.readerLibrary = {
    ...mock.readerLibrary,
    documents: [],
    activeDocument: null,
    loading: false,
    error: null,
    persistent: true,
    createDocument: vi.fn(async (input: Record<string, unknown>) => input),
    openDocument: vi.fn(async () => undefined),
    deleteDocument: vi.fn(async () => undefined),
    updateActiveText: vi.fn(),
    finalizeActiveTextEdit: vi.fn(),
    updateActiveMetadata: vi.fn(),
    updateProgress: vi.fn(),
    updateActiveListening: vi.fn(),
    flushProgress: vi.fn(),
    addBookmark: vi.fn(),
    removeBookmark: vi.fn(),
    addNote: vi.fn(),
    updateNote: vi.fn(),
    removeNote: vi.fn(),
    saveAudio: vi.fn(async () => undefined),
    loadAudio: vi.fn(async (): Promise<CachedReaderAudio | null> => null),
    hasAudio: vi.fn(async () => false),
    clearAudio: vi.fn(async () => undefined),
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

/** The signature the Reader stores for Kokoro audio made with the mocked Creator settings. */
function kokoroReaderSignature(text: string, voice = "af_heart"): string {
  const parts = engineSignatureParts("kokoro", {
    settings: { voice },
    tuning: mock.creator.generationSettings,
    quality: 5,
  });
  if (!parts) throw new Error("Kokoro always has a signature.");
  return buildAudioSignature({ text, model: "kokoro", ...parts });
}

/** The signature the Reader stores for Supertonic 2 audio made with the mocked Creator settings. */
function supertonicReaderSignature(text: string, language: string): string {
  const parts = engineSignatureParts("supertonic", {
    settings: { voice: "Female", language },
    tuning: mock.creator.generationSettings,
    quality: 5,
  });
  if (!parts) throw new Error("Supertonic 2 always has a signature.");
  return buildAudioSignature({ text, model: "supertonic", ...parts });
}

function showOptionalDesktopModels() {
  localStorage.setItem("open-tts-preferences-v1", JSON.stringify({
    showNeuTTS: true,
    showQwen3TTS: true,
  }));
}

/** What every export request carries: cancel, progress and a descriptive file name. */
const exportRequest = {
  signal: expect.any(AbortSignal),
  fileName: expect.stringMatching(/^.+-\d{8}-\d{6}$/),
  onProgress: expect.any(Function),
};

describe("SynthesisApp", () => {
  beforeEach(() => {
    localStorage.clear();
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
    expect(screen.queryByRole("button", { name: "studio-desktop-supertonic3" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("No GPU available")).toBeInTheDocument());
    expect(screen.getByText("CPU mode")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "Reader" }));
    expect(mock.routing.navigateToPage).toHaveBeenCalledWith("reader");

    fireEvent.change(screen.getByRole("textbox", { name: "script" }), {
      target: { value: "Next script with enough text." },
    });
    expect(mock.generation.cancelActiveGeneration).toHaveBeenCalledWith();
    expect(mock.generation.resetGeneratedAudio).toHaveBeenCalled();

    expect(screen.getByTestId("controls-quality-range")).toHaveTextContent("none");
    fireEvent.click(screen.getByRole("button", { name: "switch-supertonic" }));
    expect(mock.modelLoader.loadModel).toHaveBeenCalledWith("supertonic");
    expect(screen.getByTestId("controls-quality-range")).toHaveTextContent("1-20");

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
    expect(mock.player.download).toHaveBeenCalledWith(mock.creator.exportOptions, exportRequest);
    expect(mock.player.downloadCaptions).toHaveBeenCalledWith("vtt", "readable", undefined);
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

  it("keeps the Studio script separate while entering and editing Reader", async () => {
    mock.getWebGPUStatus.mockReturnValue(new Promise(() => {}));
    const readerDocument = createReaderDocument({
      id: "separate-reader",
      title: "Reader Book",
      text: "The Reader keeps its own document text.",
    });
    mock.readerLibrary.documents = [readerDocument];
    mock.readerLibrary.activeDocument = readerDocument;
    const view = render(<WebApp />);
    const studio = screen.getByRole("textbox", { name: "script" });
    fireEvent.change(studio, { target: { value: "A new Studio-only script." } });

    mock.routing = {
      ...mock.routing,
      activePage: "reader",
      isReaderPage: true,
      isStudioPage: false,
    };
    view.rerender(<WebApp />);
    expect(await screen.findByTestId("reader-text-value")).toHaveTextContent(readerDocument.text);
    fireEvent.click(screen.getByRole("button", { name: "reader-text" }));
    expect(mock.readerLibrary.updateActiveText).toHaveBeenCalledWith(
      "Reader text with enough length.",
      {
        preserveText: true,
        deferStructure: false,
        // The section is the whole document, so the hint spans all of it.
        hint: { start: 0, previousEnd: readerDocument.text.length, nextEnd: "Reader text with enough length.".length },
      },
    );

    mock.routing = {
      ...mock.routing,
      activePage: "studio",
      isReaderPage: false,
      isStudioPage: true,
    };
    view.rerender(<WebApp />);
    expect(screen.getByRole("textbox", { name: "script" })).toHaveValue("A new Studio-only script.");
  });

  it("switches Studio to Dialogue mode and back without losing the single-voice script", async () => {
    render(<WebApp />);
    expect(screen.getByRole("textbox", { name: "script" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Generation History/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dialogue" }));
    const script = await screen.findByRole("textbox", { name: "Dialogue script" });
    expect(screen.queryByRole("textbox", { name: "script" })).not.toBeInTheDocument();
    fireEvent.change(script, { target: { value: "Anna: Hello there.\nBen: Hi Anna." } });
    expect(screen.getByLabelText("Voice for Anna")).toBeInTheDocument();
    expect(screen.getByLabelText("Voice for Ben")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Single voice" }));
    expect(screen.getByRole("textbox", { name: "script" })).toBeInTheDocument();

    // The dialogue session stays alive while hidden.
    fireEvent.click(screen.getByRole("button", { name: "Dialogue" }));
    expect(await screen.findByRole("textbox", { name: "Dialogue script" })).toHaveValue("Anna: Hello there.\nBen: Hi Anna.");
  });

  it("supports Audio8 local generation in both Studio and Reader", async () => {
    Object.defineProperty(window, "electron", {
      value: { isElectron: true, platform: "darwin", arch: "arm64", localTts: mock.localTts },
      configurable: true,
    });
    const view = render(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);

    fireEvent.click(screen.getByRole("button", { name: "studio-desktop-audio8" }));
    expect(screen.getByRole("button", { name: "studio-desktop-audio8-selected" })).toBeInTheDocument();
    expect(screen.getByText(/Audio8 ONNX INT4 synthesis runs locally/i)).toBeInTheDocument();
    expect(screen.getByText(/Text and generated audio stay local/i)).toBeInTheDocument();
    expect(screen.getByTestId("creator-engine")).toHaveTextContent("Audio8 TTS");
    expect(screen.getByTestId("creator-speed-disabled")).toHaveTextContent("true");
    expect(screen.getByTestId("creator-pauses-disabled")).toHaveTextContent("false");
    expect(screen.getByTestId("creator-language")).toHaveTextContent("default");
    fireEvent.click(screen.getByRole("button", { name: "generate" }));
    expect(mock.audio8Runtime.handleGenerate).toHaveBeenCalledTimes(1);

    mock.routing = {
      ...mock.routing,
      activePage: "reader",
      isReaderPage: true,
      isStudioPage: false,
    };
    view.rerender(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);
    fireEvent.click(await screen.findByRole("button", { name: "reader-desktop-audio8" }));
    expect(screen.getByRole("button", { name: "reader-desktop-audio8-selected" })).toBeInTheDocument();
    expect(screen.getByTestId("reader-desktop-voice")).toHaveTextContent("Clara");
    fireEvent.click(screen.getByRole("button", { name: "reader-generate" }));
    expect(mock.audio8Runtime.handleGenerate).toHaveBeenCalledTimes(2);
  });

  it("keeps Studio's unsaved audio across a visit to the Reader and restores it on return", async () => {
    const studioChunks = [{
      audio: new Float32Array([0.3, 0.4]).buffer,
      samplingRate: 24_000,
      text: "Studio line.",
      index: 0,
      total: 1,
    }];
    mock.player.getAudioCacheSnapshot.mockReturnValue(studioChunks);
    mock.playerClock.set(2.5);
    mock.player.getPlaybackSnapshot.mockReturnValue({ playbackRate: 1.5, totalDuration: 4, synthesisComplete: true });
    const book = createReaderDocument({ id: "keeper-book", text: "A book to read after Studio." });
    mock.readerLibrary.documents = [book];
    mock.readerLibrary.activeDocument = book;
    const view = render(<WebApp />);

    mock.routing = { ...mock.routing, activePage: "reader", isReaderPage: true, isStudioPage: false };
    view.rerender(<WebApp />);
    await screen.findByTestId("reader-text-value");
    await waitFor(() => expect(mock.readerLibrary.loadAudio).toHaveBeenCalled());
    // The Reader emptied the player; what it holds now is not Studio's.
    mock.player.getAudioCacheSnapshot.mockReturnValue([]);
    mock.player.restoreAudioCache.mockClear();

    mock.routing = { ...mock.routing, activePage: "studio", isReaderPage: false, isStudioPage: true };
    view.rerender(<WebApp />);
    await waitFor(() => expect(mock.player.restoreAudioCache).toHaveBeenCalledWith(studioChunks, {
      currentTime: 2.5,
      playbackRate: 1.5,
      synthesisComplete: true,
    }));
  });

  describe("per-book listening profile", () => {
    const readerRoute = () => {
      mock.routing = { ...mock.routing, activePage: "reader", isReaderPage: true, isStudioPage: false };
    };
    const desktopBridge = () => Object.defineProperty(window, "electron", {
      value: { isElectron: true, platform: "darwin", arch: "arm64", localTts: mock.localTts },
      configurable: true,
    });

    it("remembers a speed change alone, and keeps a Reader voice and speed out of Studio", async () => {
      readerRoute();
      const book = createReaderDocument({ id: "scoped-book", text: "A book to listen to. ".repeat(40) });
      mock.readerLibrary.documents = [book];
      mock.readerLibrary.activeDocument = book;
      const view = render(<WebApp />);

      fireEvent.click(await screen.findByRole("button", { name: "reader-rate" }));
      expect(mock.player.setPlaybackRate).toHaveBeenCalledWith(1.5);
      // Not pinned to the engine and voice that happen to be global.
      expect(mock.readerLibrary.updateActiveListening).toHaveBeenCalledWith({ playbackRate: 1.5 });

      fireEvent.click(screen.getByRole("button", { name: "reader-voice" }));
      expect(mock.readerLibrary.updateActiveListening).toHaveBeenLastCalledWith(
        expect.objectContaining({ engine: "kokoro", voice: "af_bella" }),
      );
      mock.persistEngineSettings.mockClear();
      mock.player.setPlaybackRate.mockClear();

      // Back in Studio, its own voice and speed return.
      mock.routing = { ...mock.routing, activePage: "studio", isReaderPage: false, isStudioPage: true };
      view.rerender(<WebApp />);
      await waitFor(() => expect(mock.player.setPlaybackRate).toHaveBeenCalledWith(1));
      await waitFor(() => expect(mock.persistEngineSettings).toHaveBeenCalledWith(
        expect.objectContaining({ kokoro: expect.objectContaining({ voice: mock.initialEngineSettings.kokoro.voice }) }),
      ));
    });

    it("remembers the engine the listener picks for the open book", async () => {
      desktopBridge();
      readerRoute();
      const document = createReaderDocument({ id: "profile-book", text: "A book to listen to. ".repeat(40) });
      mock.readerLibrary.documents = [document];
      mock.readerLibrary.activeDocument = document;
      render(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);

      fireEvent.click(await screen.findByRole("button", { name: "reader-desktop-audio8" }));

      expect(mock.readerLibrary.updateActiveListening).toHaveBeenCalledWith(
        expect.objectContaining({ engine: "audio8", voice: expect.any(String), playbackRate: expect.any(Number) }),
      );
    });

    it("applies a book's remembered engine and speed when it opens", async () => {
      desktopBridge();
      readerRoute();
      const base = createReaderDocument({ id: "profile-book", text: "A book to listen to. ".repeat(40) });
      const document: ReaderDocumentRecord = {
        ...base,
        listening: { engine: "audio8", voice: "Clara", playbackRate: 1.5, updatedAt: 5 },
      };
      mock.readerLibrary.documents = [document];
      mock.readerLibrary.activeDocument = document;
      render(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);

      expect(await screen.findByRole("button", { name: "reader-desktop-audio8-selected" })).toBeInTheDocument();
      expect(mock.player.setPlaybackRate).toHaveBeenCalledWith(1.5);
      await waitFor(() => expect(mock.persistAppState).toHaveBeenCalledWith(
        expect.objectContaining({ desktopModels: expect.objectContaining({ reader: "audio8" }) }),
      ));
      await waitFor(() => expect(mock.readerLibrary.loadAudio).toHaveBeenCalled());
    });
  });

  it("keeps the browser model loaded across page switches and stops only the engine left behind", async () => {
    Object.defineProperty(window, "electron", {
      value: { isElectron: true, platform: "darwin", arch: "arm64", localTts: mock.localTts },
      configurable: true,
    });
    const view = render(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);
    fireEvent.click(screen.getByRole("button", { name: "studio-desktop-audio8" }));
    // Studio runs Audio8, but the Reader still selects the browser model.
    expect(vi.mocked(useModelLoader).mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({ active: false, retain: true }));
    mock.audio8Runtime.cancelActiveGeneration.mockClear();

    mock.routing = { ...mock.routing, activePage: "reader", isReaderPage: true, isStudioPage: false };
    view.rerender(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);
    await screen.findByTestId("reader-text-value");
    expect(vi.mocked(useModelLoader).mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({ active: true, retain: true }));
    expect(mock.audio8Runtime.cancelActiveGeneration).toHaveBeenCalled();

    mock.routing = { ...mock.routing, activePage: "studio", isReaderPage: false, isStudioPage: true };
    view.rerender(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);
    mock.audio8Runtime.cancelActiveGeneration.mockClear();
    mock.routing = { ...mock.routing, activePage: "neutts", isReaderPage: false, isStudioPage: false };
    view.rerender(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);

    // Leaving Studio stops Studio's engine; nothing ever restarted the browser model.
    expect(mock.audio8Runtime.cancelActiveGeneration).toHaveBeenCalledTimes(1);
    expect(mock.modelLoader.hardRestartModel).not.toHaveBeenCalled();
  });

  it("restores and persists the selected Audio8 voice", async () => {
    mock.initialEngineSettings = { ...mock.initialEngineSettings, audio8: { voice: "iris", seed: null, temperature: null } };
    Object.defineProperty(window, "electron", {
      value: { isElectron: true, platform: "darwin", arch: "arm64", localTts: mock.localTts },
      configurable: true,
    });
    render(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);
    fireEvent.click(screen.getByRole("button", { name: "studio-desktop-audio8" }));

    expect(screen.getByRole("button", { name: /IrisEnglish/i })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(mock.persistEngineSettings).toHaveBeenCalledWith(
      expect.objectContaining({ audio8: { voice: "iris", seed: null, temperature: null } }),
    ));
  });

  it("reopens each surface on its last desktop model and persists the selection", async () => {
    mock.initialAppState = {
      ...mock.initialAppState,
      desktopModels: { studio: "audio8", reader: "supertonic3" },
    };
    const worker = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      postMessage: vi.fn(),
      terminate: vi.fn(),
    } as unknown as Worker;
    Object.defineProperty(window, "electron", {
      value: { isElectron: true, platform: "darwin", arch: "arm64", localTts: mock.localTts },
      configurable: true,
    });
    const view = render(
      <SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" createSupertonic3Worker={() => worker} />,
    );

    expect(screen.getByRole("button", { name: "studio-desktop-audio8-selected" })).toBeInTheDocument();
    expect(screen.getByTestId("creator-engine")).toHaveTextContent("Audio8 TTS");
    await waitFor(() => expect(mock.persistAppState).toHaveBeenCalledWith(
      expect.objectContaining({ desktopModels: { studio: "audio8", reader: "supertonic3" } }),
    ));

    mock.routing = { ...mock.routing, activePage: "reader", isReaderPage: true, isStudioPage: false };
    view.rerender(
      <SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" createSupertonic3Worker={() => worker} />,
    );
    expect(await screen.findByRole("button", { name: "reader-desktop-supertonic3-selected" })).toBeInTheDocument();

    mock.persistAppState.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "reader-desktop-audio8" }));
    await waitFor(() => expect(mock.persistAppState).toHaveBeenCalledWith(
      expect.objectContaining({ desktopModels: { studio: "audio8", reader: "audio8" } }),
    ));
  });

  it("runs the browser model while a surface's saved desktop model is unavailable, keeping the choice", async () => {
    mock.initialAppState = {
      ...mock.initialAppState,
      desktopModels: { studio: "supertonic3", reader: "qwen3" },
    };
    const view = render(<WebApp />);

    expect(screen.queryByRole("button", { name: /studio-desktop-/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("creator-engine")).toHaveTextContent("Kokoro");
    mock.routing = { ...mock.routing, activePage: "reader", isReaderPage: true, isStudioPage: false };
    view.rerender(<WebApp />);
    expect(await screen.findByTestId("reader-text-value")).toBeInTheDocument();
    expect(screen.queryByTestId("reader-desktop-voice")).not.toBeInTheDocument();
    expect(vi.mocked(useModelLoader).mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({ active: true }));
    // A launch where the engine is available again reopens on it.
    await waitFor(() => expect(mock.persistAppState).toHaveBeenCalledWith(
      expect.objectContaining({ desktopModels: { studio: "supertonic3", reader: "qwen3" } }),
    ));
  });

  it("restores and persists the Supertonic 3 voice and language", async () => {
    mock.initialAppState = { ...mock.initialAppState, desktopModels: { studio: "supertonic3", reader: null } };
    mock.initialEngineSettings = {
      ...mock.initialEngineSettings,
      supertonic3: { voice: "F2", language: "ja", seed: null },
    };
    const worker = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      postMessage: vi.fn(),
      terminate: vi.fn(),
    } as unknown as Worker;
    render(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" createSupertonic3Worker={() => worker} />);

    expect(screen.getByLabelText("Supertonic 3 voice")).toHaveValue("F2");
    expect(screen.getByLabelText("Supertonic 3 language")).toHaveValue("ja");
    fireEvent.change(screen.getByLabelText("Supertonic 3 language"), { target: { value: "de" } });
    await waitFor(() => expect(mock.persistEngineSettings).toHaveBeenCalledWith(
      expect.objectContaining({ supertonic3: { voice: "F2", language: "de", seed: null } }),
    ));
    // Qwen3's settings are persisted by its own provider, never by Studio.
    expect(mock.persistEngineSettings.mock.calls.every(([settings]) => !("qwen3" in settings))).toBe(true);
  });

  it("saves a Supertonic 3 seed with its other settings", async () => {
    mock.initialAppState = { ...mock.initialAppState, desktopModels: { studio: "supertonic3", reader: null } };
    const worker = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      postMessage: vi.fn(),
      terminate: vi.fn(),
    } as unknown as Worker;
    render(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" createSupertonic3Worker={() => worker} />);

    fireEvent.change(screen.getByLabelText("Seed"), { target: { value: "314" } });

    await waitFor(() => expect(mock.persistEngineSettings).toHaveBeenCalledWith(
      expect.objectContaining({ supertonic3: expect.objectContaining({ seed: 314 }) }),
    ));
  });

  it("saves Audio8's temperature and seed with its voice", async () => {
    mock.initialAppState = { ...mock.initialAppState, desktopModels: { studio: "audio8", reader: null } };
    Object.defineProperty(window, "electron", {
      value: { isElectron: true, platform: "darwin", arch: "arm64", localTts: mock.localTts },
      configurable: true,
    });
    render(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);

    fireEvent.change(screen.getByLabelText(/Variation/), { target: { value: "0.4" } });
    fireEvent.change(screen.getByLabelText("Seed"), { target: { value: "8" } });

    await waitFor(() => expect(mock.persistEngineSettings).toHaveBeenCalledWith(
      expect.objectContaining({ audio8: { voice: "clara", seed: 8, temperature: 0.4 } }),
    ));
  });

  it("shows the Audio8 cache row and clears it from the inline settings", async () => {
    mock.audio8Runtime = {
      ...mock.audio8Runtime,
      cacheInfo: { path: "/Users/x/Library/local-model-cache/audio8", exists: true, sizeBytes: 599_933_441 },
    };
    Object.defineProperty(window, "electron", {
      value: { isElectron: true, platform: "darwin", arch: "arm64", localTts: mock.localTts },
      configurable: true,
    });
    render(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);
    fireEvent.click(screen.getByRole("button", { name: "studio-desktop-audio8" }));

    const cachePanel = screen.getByRole("region", { name: "Audio8 model cache" });
    expect(cachePanel).toHaveTextContent("/Users/x/Library/local-model-cache/audio8");
    expect(cachePanel).toHaveTextContent("572 MB");
    // The download size in the blurb is derived from the same constant the
    // catalogue guard test pins to electron/audio8Model.ts.
    expect(screen.getByText(/one-time 572 MiB model download/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear Local Cache" }));
    expect(mock.audio8Runtime.clearCache).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mock.localTts.getQwen3Setup).toHaveBeenCalled());
  });

  it("reads each surface field from the runtime driving that surface", async () => {
    // Values chosen so no field can be mistaken for the browser fallback's.
    mock.audio8Runtime = {
      ...mock.audio8Runtime,
      modelState: { ready: false, loading: true, downloadProgress: 73, error: "audio8 load failed", backend: null },
      canGenerate: false,
      isGenerating: true,
      generationProgress: 42,
      stats: { ...mock.audio8Runtime.stats, processingTime: 33 },
      error: "audio8 generation failed",
    };
    mock.tts = {
      ...mock.tts,
      generationProgress: 7,
      stats: { ...mock.tts.stats, processingTime: 11 },
      error: "browser generation failed",
    };
    Object.defineProperty(window, "electron", {
      value: { isElectron: true, platform: "darwin", arch: "arm64", localTts: mock.localTts },
      configurable: true,
    });
    const view = render(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);

    // Before Audio8 is selected Studio must read the browser runtime.
    fireEvent.click(screen.getByRole("button", { name: "generate" }));
    expect(mock.generation.handleGenerate).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("controls-model-error")).toHaveTextContent("none");
    expect(screen.getByTestId("controls-loading-progress")).toHaveTextContent("100");
    expect(screen.getByTestId("controls-generation-progress")).toHaveTextContent("7");
    expect(screen.getByTestId("controls-is-generating")).toHaveTextContent("false");
    // Kokoro has no quality range, so Studio shows no quality slider.
    expect(screen.getByTestId("controls-quality-range")).toHaveTextContent("none");
    expect(screen.getByTestId("player-processing-time")).toHaveTextContent("11");
    expect(screen.getByText("browser generation failed")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "studio-desktop-audio8" }));

    expect(screen.getByTestId("controls-model-ready")).toHaveTextContent("false");
    expect(screen.getByTestId("controls-model-error")).toHaveTextContent("audio8 load failed");
    expect(screen.getByTestId("controls-loading-progress")).toHaveTextContent("73");
    expect(screen.getByTestId("controls-generation-progress")).toHaveTextContent("42");
    expect(screen.getByTestId("controls-is-generating")).toHaveTextContent("true");
    expect(screen.getByTestId("controls-can-generate")).toHaveTextContent("false");
    // Audio8 ignores quality, so the slider stays hidden.
    expect(screen.getByTestId("controls-quality-range")).toHaveTextContent("none");
    expect(screen.getByText("audio8 generation failed")).toBeInTheDocument();
    expect(screen.queryByText("browser generation failed")).not.toBeInTheDocument();

    // Studio's three handlers must dispatch to Audio8, not the browser path.
    // Selecting a desktop model resets the player, so generating again is also
    // what brings the stats readout back — now sourced from Audio8.
    fireEvent.click(screen.getByRole("button", { name: "generate" }));
    expect(screen.getByTestId("player-processing-time")).toHaveTextContent("33");
    fireEvent.click(screen.getByRole("button", { name: "stop" }));
    fireEvent.click(screen.getByRole("button", { name: "retry-load" }));
    expect(mock.audio8Runtime.handleGenerate).toHaveBeenCalledTimes(1);
    expect(mock.audio8Runtime.handleStop).toHaveBeenCalledTimes(1);
    expect(mock.audio8Runtime.retryLoad).toHaveBeenCalledTimes(1);
    expect(mock.generation.handleGenerate).toHaveBeenCalledTimes(1);
    expect(mock.generation.handleStop).not.toHaveBeenCalled();
    expect(mock.cache.retryActiveModelLoad).not.toHaveBeenCalled();

    // The Reader is a separate selection: it must still be on the browser
    // runtime even though Studio moved to Audio8.
    mock.routing = { ...mock.routing, activePage: "reader", isReaderPage: true, isStudioPage: false };
    view.rerender(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);
    expect(await screen.findByTestId("reader-model-error")).toHaveTextContent("none");
    expect(screen.getByTestId("reader-loading-progress")).toHaveTextContent("100");
    expect(screen.getByTestId("reader-generation-progress")).toHaveTextContent("7");
    expect(screen.getByTestId("reader-is-generating")).toHaveTextContent("false");
    expect(screen.getByTestId("reader-processing-time")).toHaveTextContent("11");

    fireEvent.click(screen.getByRole("button", { name: "reader-desktop-audio8" }));
    expect(screen.getByTestId("reader-model-ready")).toHaveTextContent("false");
    expect(screen.getByTestId("reader-model-error")).toHaveTextContent("audio8 load failed");
    expect(screen.getByTestId("reader-loading-progress")).toHaveTextContent("73");
    expect(screen.getByTestId("reader-generation-progress")).toHaveTextContent("42");
    expect(screen.getByTestId("reader-is-generating")).toHaveTextContent("true");
    expect(screen.getByTestId("reader-can-generate")).toHaveTextContent("false");
    expect(screen.getByTestId("reader-processing-time")).toHaveTextContent("33");

    fireEvent.click(screen.getByRole("button", { name: "reader-generate" }));
    fireEvent.click(screen.getByRole("button", { name: "reader-stop" }));
    fireEvent.click(screen.getByRole("button", { name: "reader-retry" }));
    expect(mock.audio8Runtime.handleGenerate).toHaveBeenCalledTimes(2);
    expect(mock.audio8Runtime.handleStop).toHaveBeenCalledTimes(2);
    expect(mock.audio8Runtime.retryLoad).toHaveBeenCalledTimes(2);
    expect(mock.generation.handleGenerate).toHaveBeenCalledTimes(1);
    expect(mock.generation.handleStop).not.toHaveBeenCalled();
    expect(mock.cache.retryActiveModelLoad).not.toHaveBeenCalled();
  });

  it("leaves a desktop Reader model failure to the Reader recovery card", async () => {
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
    mock.audio8Runtime = {
      ...mock.audio8Runtime,
      modelState: {
        ready: false,
        loading: false,
        downloadProgress: 0,
        error: "audio8 reader load failed",
        backend: null,
      },
      canGenerate: false,
      error: null,
    };
    Object.defineProperty(window, "electron", {
      value: { isElectron: true, platform: "darwin", arch: "arm64", localTts: mock.localTts },
      configurable: true,
    });

    render(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);
    fireEvent.click(await screen.findByRole("button", { name: "reader-desktop-audio8" }));

    expect(screen.getByTestId("reader-model-error")).toHaveTextContent("audio8 reader load failed");
    expect(screen.getAllByText("audio8 reader load failed")).toHaveLength(1);
  });

  it("lists Audio8 among the desktop runtimes whether or not it is selected", async () => {
    Object.defineProperty(window, "electron", {
      value: { isElectron: true, platform: "darwin", arch: "arm64", localTts: mock.localTts },
      configurable: true,
    });
    render(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);

    expect(screen.getByText("Audio8 · Native CPU")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "studio-desktop-audio8" }));
    expect(screen.getByText("Audio8 · Native CPU")).toBeInTheDocument();
    await waitFor(() => expect(mock.localTts.getQwen3Setup).toHaveBeenCalled());
  });

  it("shows Chatterbox's own settings in Studio and saves a change to them", async () => {
    mock.browserSupport = { ...mock.browserSupport, supportedModels: ["kokoro", "chatterbox"] };
    mock.initialAppState = { ...mock.initialAppState, model: "chatterbox" };
    mock.getWebGPUStatus.mockResolvedValue({ available: true, reason: null, message: null });
    mock.modelLoader = {
      ...mock.modelLoader,
      states: { kokoro: mock.readyState, supertonic: mock.readyState, chatterbox: mock.readyState },
      voices: { kokoro: [], supertonic: [], chatterbox: ["chatterbox-default"] },
    };
    render(<WebApp />);

    const temperature = await screen.findByLabelText(/Variation/);
    expect(temperature).toHaveValue("0.8");
    fireEvent.change(temperature, { target: { value: "1.25" } });
    expect(screen.getByLabelText(/Variation/)).toHaveValue("1.25");
    fireEvent.change(screen.getByLabelText("Seed"), { target: { value: "12" } });
    expect(screen.getByLabelText("Seed")).toHaveValue(12);
    expect(mock.generation.cancelActiveGeneration).toHaveBeenCalled();

    // A tag lands at the end of the script, after a space.
    const script = (screen.getByRole("textbox", { name: "script" }) as HTMLTextAreaElement).value;
    fireEvent.click(screen.getByRole("button", { name: "Add [laugh]" }));
    expect(screen.getByRole("textbox", { name: "script" })).toHaveValue(`${script} [laugh]`);
    fireEvent.click(screen.getByRole("button", { name: "Add [sigh]" }));
    expect(screen.getByRole("textbox", { name: "script" })).toHaveValue(`${script} [laugh] [sigh]`);

    // Into an empty script, or one that already ends in a space, no extra space is added.
    fireEvent.change(screen.getByRole("textbox", { name: "script" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Add [sigh]" }));
    expect(screen.getByRole("textbox", { name: "script" })).toHaveValue("[sigh]");
    fireEvent.change(screen.getByRole("textbox", { name: "script" }), { target: { value: "Hello " } });
    fireEvent.click(screen.getByRole("button", { name: "Add [laugh]" }));
    expect(screen.getByRole("textbox", { name: "script" })).toHaveValue("Hello [laugh]");
  });

  it("runs the default model when the saved Chatterbox cannot run without WebGPU, and keeps the saved choice", async () => {
    mock.browserSupport = { ...mock.browserSupport, supportedModels: ["kokoro", "chatterbox"] };
    mock.initialAppState = { ...mock.initialAppState, model: "chatterbox" };
    mock.getWebGPUStatus.mockResolvedValue({ available: false, reason: null, message: "No GPU available" });
    mock.modelLoader = {
      ...mock.modelLoader,
      states: { kokoro: mock.readyState, supertonic: mock.readyState, chatterbox: mock.readyState },
    };
    render(<WebApp />);

    await waitFor(() => expect(screen.getByText("No GPU available")).toBeInTheDocument());
    await waitFor(() => expect(mock.persistAppState).toHaveBeenCalled());

    // Kokoro runs in its place, so Chatterbox's own controls are absent...
    expect(screen.queryByLabelText(/Variation/)).not.toBeInTheDocument();
    expect(mock.modelLoader.loadModel).not.toHaveBeenCalledWith("chatterbox");
    // ...but the saved choice survives for a later launch.
    expect(mock.persistAppState.mock.calls.every(([state]) => state.model === "chatterbox")).toBe(true);
  });

  it("names every browser model the build ships in the footer", () => {
    mock.browserSupport = {
      ...mock.browserSupport,
      supportedModels: ["kokoro", "kitten", "paradee", "piper"],
    };
    render(<WebApp />);

    const footer = screen.getByRole("contentinfo");
    for (const label of ["Kokoro", "Supertonic", "Kitten TTS", "Paradee", "Piper"]) {
      expect(within(footer).getByText(label)).toBeInTheDocument();
    }
  });

  it("hides the desktop runtimes when the web build runs inside Electron", async () => {
    Object.defineProperty(window, "electron", {
      value: { isElectron: true, platform: "darwin", arch: "arm64", localTts: mock.localTts },
      configurable: true,
    });
    render(<WebApp />);

    // `enableDesktopRuntimes` is the entry point's opt-in; a live preload
    // bridge alone must not surface desktop-only models on either surface.
    expect(screen.queryByRole("button", { name: "studio-desktop-audio8" })).not.toBeInTheDocument();
    expect(screen.queryByText("Audio8 · Native CPU")).not.toBeInTheDocument();
    await waitFor(() => expect(mock.localTts.getQwen3Setup).toHaveBeenCalled());
  });

  it("splices an edit into its frozen section even when chapter and section ids churn", async () => {
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
    const before = "FRONT MATTER   \n\n\n\n\n";
    const originalSection = "CHAPTER ONE\nOriginal section.\n";
    const after = "\nCHAPTER TWO\nKeep-after   \n\n\n\n\nTail   ";
    const text = `${before}${originalSection}${after}`;
    const base = createReaderDocument({ id: "frozen-edit-reader", text: "Temporary." });
    const chapters = [
      {
        id: "original-chapter",
        title: "Chapter One",
        order: 0,
        start: before.length,
        end: before.length + originalSection.length,
        level: 1,
      },
      {
        id: "following-chapter",
        title: "Chapter Two",
        order: 1,
        start: before.length + originalSection.length,
        end: text.length,
        level: 1,
      },
    ];
    const originalSectionRecord = buildReaderSections(text, chapters)[0];
    const document: ReaderDocumentRecord = {
      ...base,
      text,
      chapters,
      progress: {
        ...base.progress,
        textOffset: originalSectionRecord.start,
        chapterId: originalSectionRecord.chapterId,
        sectionId: originalSectionRecord.id,
      },
    };
    mock.readerLibrary.documents = [document];
    mock.readerLibrary.activeDocument = document;

    const view = render(<WebApp />);
    fireEvent.click(await screen.findByRole("button", { name: "reader-edit-start" }));

    const churnedDocument: ReaderDocumentRecord = {
      ...document,
      chapters: [{
        id: "replacement-chapter",
        title: "Replacement",
        order: 0,
        start: 0,
        end: text.length,
        level: 1,
      }],
    };
    mock.readerLibrary.documents = [churnedDocument];
    mock.readerLibrary.activeDocument = churnedDocument;
    view.rerender(<WebApp />);
    expect(screen.getByTestId("reader-section-id")).toHaveTextContent("replacement-chapter:section-1");

    fireEvent.click(screen.getByRole("button", { name: "reader-edit-finish" }));

    const normalizedDraft = "CHAPTER REPLACED\n\n\nDraft ending.   ";
    expect(mock.readerLibrary.updateActiveText).toHaveBeenCalledWith(
      `${before}${normalizedDraft}${after}`,
      {
        preserveText: true,
        deferStructure: true,
        // Only the span the draft replaced needs scanning for annotations.
        hint: {
          start: before.length,
          previousEnd: text.length - after.length,
          nextEnd: before.length + normalizedDraft.length,
        },
      },
    );
    expect(mock.readerLibrary.clearAudio).toHaveBeenCalledWith(document.id, originalSectionRecord.id);
    expect(mock.readerLibrary.finalizeActiveTextEdit).toHaveBeenCalledWith(document.id);
    expect(mock.readerLibrary.updateActiveText.mock.invocationCallOrder[0])
      .toBeLessThan(mock.readerLibrary.finalizeActiveTextEdit.mock.invocationCallOrder[0]);
  });

  it("exposes Supertonic 3 only when the Electron entry supplies its worker and loads it lazily", async () => {
    mock.browserSupport = {
      ...mock.browserSupport,
      supportedModels: ["kokoro"],
    };
    Object.defineProperty(window, "electron", {
      value: {
        isElectron: true,
        platform: "darwin",
        arch: "arm64",
        localTts: mock.localTts,
      },
      configurable: true,
    });
    const worker = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      postMessage: vi.fn(),
      terminate: vi.fn(),
    } as unknown as Worker;
    const createSupertonic3Worker = vi.fn(() => worker);

    const { unmount } = render(
      <SynthesisApp
        enableDesktopRuntimes
        routeBasePath="/desktop"
        createSupertonic3Worker={createSupertonic3Worker}
      />,
    );

    expect(screen.getByRole("button", { name: "studio-desktop-supertonic3" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "switch-supertonic" })).not.toBeInTheDocument();
    expect(createSupertonic3Worker).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "studio-desktop-supertonic3" }));
    expect(screen.getByTestId("controls-quality-range")).toHaveTextContent("1-20");

    await waitFor(() => expect(createSupertonic3Worker).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(vi.mocked(useModelLoader).mock.calls.at(-1)?.[1])
      .toEqual(expect.objectContaining({ active: false })));
    expect(worker.postMessage).toHaveBeenCalledWith({ type: "LOAD", forceReload: false });
    unmount();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("selects Supertonic 3 from Reader when the desktop entry supplies its worker", async () => {
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
    mock.browserSupport = {
      ...mock.browserSupport,
      supportedModels: ["kokoro"],
    };
    const worker = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      postMessage: vi.fn(),
      terminate: vi.fn(),
    } as unknown as Worker;

    render(
      <SynthesisApp
        enableDesktopRuntimes
        routeBasePath="/desktop"
        createSupertonic3Worker={() => worker}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "reader-desktop-supertonic3" }));

    expect(screen.getByRole("button", { name: "reader-desktop-supertonic3-selected" })).toBeInTheDocument();
    await waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith({ type: "LOAD", forceReload: false }));
  });

  it("attaches its keyboard shortcut listener once however often it re-renders", () => {
    const addListener = vi.spyOn(document, "addEventListener");
    const keydownSubscriptions = () => addListener.mock.calls.filter(([type]) => type === "keydown").length;
    const { rerender } = render(<WebApp />);
    const subscribed = keydownSubscriptions();
    expect(subscribed).toBeGreaterThan(0);

    // A new player state or a different runtime state each used to replace
    // the document listener.
    mock.player = { ...mock.player, totalDuration: 9, isPlaying: true };
    rerender(<WebApp />);
    mock.generation.isGenerationBusy = true;
    mock.player = { ...mock.player, totalDuration: 12 };
    rerender(<WebApp />);

    expect(keydownSubscriptions()).toBe(subscribed);
    // The one listener still acts on the latest state.
    fireEvent.keyDown(document, { key: ".", ctrlKey: true });
    expect(mock.generation.handleStop).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: " ", code: "Space" });
    expect(mock.player.togglePlay).toHaveBeenCalledTimes(1);
    addListener.mockRestore();
  });

  it("supports macOS and Windows keyboard shortcuts without hijacking text entry", async () => {
    const { rerender } = render(<WebApp />);

    fireEvent.keyDown(document, { key: ",", metaKey: true });
    expect(await screen.findByRole("dialog", { name: "Appearance" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));

    fireEvent.keyDown(document, { key: "2", ctrlKey: true });
    fireEvent.keyDown(document, { key: "1", metaKey: true });
    expect(mock.routing.navigateToPage).toHaveBeenCalledWith("reader");
    expect(mock.routing.navigateToPage).toHaveBeenCalledWith("studio");

    fireEvent.keyDown(document, { key: "Enter", ctrlKey: true });
    expect(mock.generation.handleGenerate).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: " ", code: "Space" });
    fireEvent.keyDown(document, { key: "ArrowLeft", altKey: true });
    fireEvent.keyDown(document, { key: "ArrowRight", altKey: true });
    expect(mock.player.togglePlay).toHaveBeenCalledTimes(1);
    expect(mock.player.skip).toHaveBeenCalledWith(-10);
    expect(mock.player.skip).toHaveBeenCalledWith(10);

    fireEvent.keyDown(screen.getByRole("textbox", { name: "script" }), { key: " ", code: "Space" });
    expect(mock.player.togglePlay).toHaveBeenCalledTimes(1);

    // Streamed audio stays pausable while the rest is still generating.
    mock.generation.isGenerationBusy = true;
    rerender(<WebApp />);
    fireEvent.keyDown(document, { key: " ", code: "Space" });
    expect(mock.player.togglePlay).toHaveBeenCalledTimes(2);

    // A focused control keeps Space for its own activation.
    const button = document.createElement("button");
    document.body.append(button);
    fireEvent.keyDown(button, { key: " ", code: "Space" });
    expect(mock.player.togglePlay).toHaveBeenCalledTimes(2);
    button.remove();
    fireEvent.keyDown(document, { key: ".", metaKey: true });
    expect(mock.generation.handleStop).toHaveBeenCalledTimes(1);
  });

  it("applies interface and Reader font preferences app-wide", async () => {
    render(<WebApp />);

    fireEvent.click(screen.getByRole("button", { name: "Open app settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "App font Outfit" }));
    fireEvent.click(screen.getByRole("button", { name: "Reading font Georgia" }));

    expect(document.documentElement.dataset.interfaceFont).toBe("outfit");
    expect(document.documentElement.dataset.readingFont).toBe("georgia");
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem("open-tts-preferences-v1") ?? "{}")).toMatchObject({
        interfaceFont: "outfit",
        readingFont: "georgia",
      });
    });
  });

  it("contains a Reader failure to the Reader and retries it on request", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mock.readerError = new Error("The Reader chunk could not be loaded.");
    mock.routing = { ...mock.routing, activePage: "reader", isReaderPage: true, isStudioPage: false };
    render(<WebApp />);

    expect(await screen.findByText("The Reader could not be shown")).toBeInTheDocument();
    expect(screen.getByText("The Reader chunk could not be loaded.")).toBeInTheDocument();
    // The header and page tabs, and with them the rest of the app, survive.
    expect(screen.getByRole("heading", { name: "Open TTS" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open app settings" })).toBeInTheDocument();

    mock.readerError = null;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("reader-text-value")).toBeInTheDocument();
  });

  it("orchestrates reader controls and segment jumps", async () => {
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

    fireEvent.click(await screen.findByRole("button", { name: "reader-text" }));
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
    expect(mock.player.download).toHaveBeenCalledWith(mock.creator.exportOptions, exportRequest);
    expect(mock.generation.handleRetakeSegment).toHaveBeenCalledWith("seg-1");
    expect(mock.player.jumpToSegment).toHaveBeenCalledWith("seg-1");
    expect(mock.player.jumpToSegment).not.toHaveBeenCalledWith("");
  });

  it("renders and synthesizes only the active bounded section of a long book", async () => {
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
    const document = createReaderDocument({
      id: "bounded-reader",
      title: "Bounded Reader",
      text: "A long paragraph for bounded synthesis. ".repeat(900),
    });
    const sections = buildReaderSections(document.text, document.chapters);
    const section = sections[1];
    const activeDocument: ReaderDocumentRecord = {
      ...document,
      progress: {
        ...document.progress,
        textOffset: section.start,
        chapterId: section.chapterId,
        sectionId: section.id,
        percent: (section.start / document.text.length) * 100,
      },
    };
    mock.readerLibrary.documents = [activeDocument];
    mock.readerLibrary.activeDocument = activeDocument;

    render(<WebApp />);

    const sectionText = getReaderSectionText(document.text, section);
    expect((await screen.findByTestId("reader-text-value")).textContent).toBe(sectionText);
    expect(screen.getByTestId("reader-section-id")).toHaveTextContent(section.id);
    await waitFor(() => {
      const options = vi.mocked(useGenerationControl).mock.calls.at(-1)?.[0];
      expect(options?.text).toBe(sectionText);
    });
    expect(sectionText.length).toBeLessThan(document.text.length);
  });

  it("maps section-local playback ranges onto stable whole-book progress", async () => {
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
    const document = createReaderDocument({
      id: "global-progress-reader",
      text: "Progress stays relative to the complete book. ".repeat(900),
    });
    const sections = buildReaderSections(document.text, document.chapters);
    const section = sections[1];
    const activeDocument: ReaderDocumentRecord = {
      ...document,
      progress: {
        ...document.progress,
        textOffset: section.start,
        chapterId: section.chapterId,
        sectionId: section.id,
        percent: (section.start / document.text.length) * 100,
      },
    };
    mock.readerLibrary.documents = [activeDocument];
    mock.readerLibrary.activeDocument = activeDocument;
    mock.playerClock.set(1);
    mock.player.totalDuration = 4;
    mock.player.activeSegmentId = "section-segment";
    mock.player.segments = [{
      id: "section-segment",
      text: "section range",
      startSec: 0,
      endSec: 4,
      index: 1,
      total: 1,
      textStart: 100,
      textEnd: 200,
    }];

    const view = render(<WebApp />);
    await waitFor(() => expect(mock.readerLibrary.loadAudio).toHaveBeenCalledWith(document.id, section.id));
    mock.readerLibrary.updateProgress.mockClear();
    mock.playerClock.set(2);
    view.rerender(<WebApp />);

    await waitFor(() => expect(mock.readerLibrary.updateProgress).toHaveBeenCalledWith({
      positionSec: 2,
      totalDurationSec: 4,
      textOffset: section.start + 150,
    }));
  });

  it("flushes a finished section before automatically continuing", async () => {
    mock.player.isSynthesisComplete = true;
    mock.getWebGPUStatus.mockReturnValue(new Promise(() => {}));
    localStorage.setItem("open-tts-reader-view-v1", JSON.stringify({ autoAdvance: true }));
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
    const document = createReaderDocument({
      id: "auto-reader",
      text: "Automatic continuation keeps section audio. ".repeat(900),
    });
    const sections = buildReaderSections(document.text, document.chapters);
    mock.readerLibrary.documents = [document];
    mock.readerLibrary.activeDocument = document;
    const cachedAudio = new Float32Array([0.2, -0.2]).buffer;
    mock.playerClock.set(3);
    mock.player.totalDuration = 4;
    mock.player.activeSegmentId = "ending-segment";
    mock.player.segments = [{
      id: "ending-segment",
      text: "ending range",
      startSec: 0,
      endSec: 4,
      index: 1,
      total: 1,
      textStart: 0,
      textEnd: sections[0].end - sections[0].start,
    }];
    mock.player.getAudioCacheSnapshot.mockReturnValue([{
      audio: cachedAudio,
      samplingRate: 24_000,
      text: "ending range",
      index: 0,
      total: 1,
    }]);

    const view = render(<WebApp />);
    await waitFor(() => expect(mock.readerLibrary.loadAudio).toHaveBeenCalledWith(document.id, sections[0].id));
    mock.readerLibrary.updateProgress.mockClear();
    mock.readerLibrary.saveAudio.mockClear();
    mock.playerClock.set(4);
    view.rerender(<WebApp />);

    await waitFor(() => expect(mock.readerLibrary.updateProgress).toHaveBeenCalledWith(
      expect.objectContaining({ textOffset: sections[1].start, positionSec: 0 }),
    ));
    expect(mock.readerLibrary.saveAudio).toHaveBeenCalledWith(expect.objectContaining({
      documentId: document.id,
      sectionId: sections[0].id,
      chapterId: sections[0].chapterId,
      byteLength: cachedAudio.byteLength,
      synthesisComplete: true,
    }));
  });

  describe("automatic continuation at a section's end", () => {
    async function finishFirstSection(hold: boolean) {
      mock.player.isSynthesisComplete = true;
      mock.getWebGPUStatus.mockReturnValue(new Promise(() => {}));
      localStorage.setItem("open-tts-reader-view-v1", JSON.stringify({ autoAdvance: true }));
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
      const document = createReaderDocument({
        id: "held-reader",
        text: "A long chapter keeps its sections apart. ".repeat(900),
      });
      const sections = buildReaderSections(document.text, document.chapters);
      mock.readerLibrary.documents = [document];
      mock.readerLibrary.activeDocument = document;
      mock.playerClock.set(3);
      mock.player.totalDuration = 4;
      mock.player.activeSegmentId = "ending-segment";
      mock.player.segments = [{
        id: "ending-segment",
        text: "ending range",
        startSec: 0,
        endSec: 4,
        index: 1,
        total: 1,
        textStart: 0,
        textEnd: sections[0].end - sections[0].start,
      }];
      mock.player.getAudioCacheSnapshot.mockReturnValue([]);

      const view = render(<WebApp />);
      await waitFor(() => expect(mock.readerLibrary.loadAudio).toHaveBeenCalledWith(document.id, sections[0].id));
      // The sleep timer reports that the next section must not start by itself.
      if (hold) fireEvent.click(screen.getByRole("button", { name: "reader-hold-continuation" }));
      mock.readerLibrary.updateProgress.mockClear();
      act(() => mock.playerClock.set(4));
      await waitFor(() => expect(mock.readerLibrary.updateProgress).toHaveBeenCalledWith(
        expect.objectContaining({ textOffset: sections[1].start, positionSec: 0 }),
      ));

      // The library applies the page turn, and the next section is entered
      // with nothing saved for it.
      mock.player.segments = [];
      mock.player.totalDuration = 0;
      mock.playerClock.set(0);
      const turned = {
        ...document,
        progress: {
          ...document.progress,
          textOffset: sections[1].start,
          chapterId: sections[1].chapterId,
          sectionId: sections[1].id,
          positionSec: 0,
        },
      };
      mock.readerLibrary.activeDocument = turned;
      mock.readerLibrary.documents = [turned];
      view.rerender(<WebApp />);
      await waitFor(() => expect(mock.readerLibrary.loadAudio).toHaveBeenCalledWith(document.id, sections[1].id));
      // The restore effect starts playback and generation on a zero timer.
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    }

    it("generates the next section by itself", async () => {
      await finishFirstSection(false);
      expect(mock.generation.handleGenerate).toHaveBeenCalledTimes(1);
    });

    it("turns the page without playing or generating the next section while the sleep timer holds it", async () => {
      mock.player.togglePlay.mockClear();
      await finishFirstSection(true);
      expect(mock.generation.handleGenerate).not.toHaveBeenCalled();
      expect(mock.player.togglePlay).not.toHaveBeenCalled();
    });
  });

  it("keeps incomplete section playback from skipping unread text", async () => {
    mock.getWebGPUStatus.mockReturnValue(new Promise(() => {}));
    mock.routing = { ...mock.routing, activePage: "reader", isReaderPage: true, isStudioPage: false };
    const document = createReaderDocument({
      id: "interrupted-reader",
      text: "A paragraph with enough words for bounded Reader sections. ".repeat(700),
    });
    const sections = buildReaderSections(document.text, document.chapters);
    expect(sections.length).toBeGreaterThan(1);
    mock.readerLibrary.documents = [document];
    mock.readerLibrary.activeDocument = document;
    mock.player.activeSegmentId = "partial";
    mock.player.segments = [{
      id: "partial", text: "Only the first part", startSec: 0, endSec: 4,
      index: 1, total: 10, textStart: 0, textEnd: 100,
    }];
    mock.playerClock.set(3);
    render(<WebApp />);
    await waitFor(() => expect(mock.readerLibrary.loadAudio).toHaveBeenCalled());
    mock.readerLibrary.updateProgress.mockClear();
    // Move past the progress-write throttle, as if the user played the final
    // second of a canceled generation or a restored partial cache.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1_000);
    act(() => mock.playerClock.set(4));
    expect(mock.readerLibrary.updateProgress).toHaveBeenCalledWith({
      positionSec: 4, totalDurationSec: 4, textOffset: 100,
    });
    expect(mock.readerLibrary.updateProgress).not.toHaveBeenCalledWith(expect.objectContaining({
      textOffset: sections[1].start,
    }));
    vi.restoreAllMocks();
  });

  it("does not mark an incomplete final section as fully read", async () => {
    mock.getWebGPUStatus.mockReturnValue(new Promise(() => {}));
    mock.routing = { ...mock.routing, activePage: "reader", isReaderPage: true, isStudioPage: false };
    const document = createReaderDocument({ id: "partial-final", text: "An interrupted final passage." });
    mock.readerLibrary.documents = [document];
    mock.readerLibrary.activeDocument = document;
    mock.playerClock.set(3);
    mock.player.segments = [{
      id: "seg-1", text: document.text, startSec: 0, endSec: 4,
      index: 1, total: 1, textStart: 0, textEnd: document.text.length,
    }];
    render(<WebApp />);
    await waitFor(() => expect(mock.readerLibrary.loadAudio).toHaveBeenCalled());
    act(() => mock.playerClock.set(4));
    await waitFor(() => expect(mock.readerLibrary.updateProgress).toHaveBeenCalledWith(expect.objectContaining({
      textOffset: document.text.length - 1,
    })));
  });

  it("persists successful completion after the last audio chunk was already cached", async () => {
    mock.getWebGPUStatus.mockReturnValue(new Promise(() => {}));
    mock.routing = { ...mock.routing, activePage: "reader", isReaderPage: true, isStudioPage: false };
    const document = createReaderDocument({ id: "completion-cache", text: "The final chunk can arrive before the success message." });
    mock.readerLibrary.documents = [document];
    mock.readerLibrary.activeDocument = document;
    mock.player.getAudioCacheSnapshot.mockReturnValue([{
      audio: new Float32Array([0.1, -0.1]).buffer,
      samplingRate: 24_000, text: document.text, index: 1, total: 1,
    }]);
    const view = render(<WebApp />);
    await waitFor(() => expect(mock.readerLibrary.loadAudio).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("link", { name: "Studio" }));
    expect(mock.readerLibrary.saveAudio).toHaveBeenLastCalledWith(expect.objectContaining({ synthesisComplete: false }));
    mock.readerLibrary.saveAudio.mockClear();
    vi.useFakeTimers();
    mock.player.isSynthesisComplete = true;
    view.rerender(<WebApp />);
    act(() => vi.advanceTimersByTime(800));
    expect(mock.readerLibrary.saveAudio).toHaveBeenLastCalledWith(expect.objectContaining({ synthesisComplete: true }));
  });

  it.each([undefined, false, true])("restores cached Reader audio without losing completion %s", async (synthesisComplete) => {
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
    const baseDocument = createReaderDocument({
      id: "cached-reader",
      text: "Cached Reader text with enough length.",
    });
    const section = buildReaderSections(baseDocument.text, baseDocument.chapters)[0];
    const document: ReaderDocumentRecord = {
      ...baseDocument,
      progress: {
        ...baseDocument.progress,
        positionSec: 3,
        totalDurationSec: 4,
        textOffset: 20,
        sectionId: section.id,
      },
    };
    mock.readerLibrary.documents = [document];
    mock.readerLibrary.activeDocument = document;
    const cachedAudio = new Float32Array([0.1, -0.1]).buffer;
    mock.readerLibrary.loadAudio.mockResolvedValue({
      cacheKey: createReaderAudioCacheKey(document.id, section.id),
      documentId: document.id,
      chapterId: section.chapterId,
      sectionId: section.id,
      signature: kokoroReaderSignature(document.text),
      chunks: [{
        audio: cachedAudio,
        samplingRate: 24_000,
        text: document.text,
        index: 0,
        total: 1,
      }],
      byteLength: cachedAudio.byteLength,
      currentTime: 2,
      playbackRate: 1,
      totalDuration: 4,
      synthesisComplete,
      updatedAt: Date.now(),
    });

    const view = render(<WebApp />);
    await waitFor(() => expect(mock.player.restoreAudioCache).toHaveBeenCalledTimes(1));
    expect(mock.player.restoreAudioCache).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ currentTime: 3 }),
    );
    expect(mock.player.restoreAudioCache).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ synthesisComplete: synthesisComplete === true }),
    );

    mock.readerLibrary.activeDocument = {
      ...document,
      progress: { ...document.progress, positionSec: 2, percent: 50, updatedAt: Date.now() },
    };
    view.rerender(<WebApp />);
    await Promise.resolve();

    expect(mock.player.restoreAudioCache).toHaveBeenCalledTimes(1);
  });

  it("saves Supertonic 2 Reader audio under its own language before switching languages", async () => {
    mock.getWebGPUStatus.mockReturnValue(new Promise(() => {}));
    mock.initialAppState = { ...mock.initialAppState, model: "supertonic" };
    mock.routing = { ...mock.routing, activePage: "reader", isReaderPage: true, isStudioPage: false };
    const document = createReaderDocument({
      id: "supertonic-language",
      text: "A paragraph with enough words for bounded Reader sections. ".repeat(700),
    });
    const sections = buildReaderSections(document.text, document.chapters);
    expect(sections.length).toBeGreaterThan(1);
    mock.readerLibrary.documents = [document];
    mock.readerLibrary.activeDocument = document;
    const sectionText = getReaderSectionText(document.text, sections[0]);
    // A reset empties the player, as the real one does.
    let playerAudio: CachedReaderAudio["chunks"] = [];
    mock.player.getAudioCacheSnapshot.mockImplementation(() => playerAudio);
    mock.generation.resetGeneratedAudio.mockImplementation(() => { playerAudio = []; });

    render(<WebApp />);
    await waitFor(() => expect(mock.readerLibrary.loadAudio).toHaveBeenCalledWith(document.id, sections[0].id));
    // English audio generated for the first section.
    playerAudio = [{
      audio: new Float32Array([0.1, -0.1]).buffer,
      samplingRate: 24_000, text: sectionText, index: 1, total: 1,
    }];
    fireEvent.change(await screen.findByLabelText("Supertonic 2 language"), { target: { value: "ko" } });
    fireEvent.click(screen.getByRole("button", { name: "reader-next-section" }));

    const savedSignatures = mock.readerLibrary.saveAudio.mock.calls
      .map((call) => (call as unknown as [CachedReaderAudio])[0].signature);
    expect(savedSignatures.length).toBeGreaterThan(0);
    for (const signature of savedSignatures) {
      expect(signature).toBe(supertonicReaderSignature(sectionText, "en"));
    }
    expect(savedSignatures).not.toContain(supertonicReaderSignature(sectionText, "ko"));
    expect(mock.generation.cancelActiveGeneration).toHaveBeenCalled();
  });

  it("clears Studio audio made in another Supertonic 2 language", () => {
    mock.initialAppState = { ...mock.initialAppState, model: "supertonic" };
    render(<WebApp />);
    mock.generation.resetGeneratedAudio.mockClear();

    fireEvent.change(screen.getByLabelText("Supertonic 2 language"), { target: { value: "en" } });
    expect(mock.generation.resetGeneratedAudio).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Supertonic 2 language"), { target: { value: "fr" } });
    expect(mock.generation.cancelActiveGeneration).toHaveBeenCalled();
    expect(mock.generation.resetGeneratedAudio).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Supertonic 2 language")).toHaveValue("fr");
  });

  it("restores and persists the Supertonic 2 language", async () => {
    mock.initialAppState = { ...mock.initialAppState, model: "supertonic" };
    mock.initialEngineSettings = {
      ...mock.initialEngineSettings,
      supertonic: { voice: "Male 2", language: "pt" },
    };
    render(<WebApp />);

    expect(screen.getByLabelText("Supertonic 2 language")).toHaveValue("pt");
    fireEvent.change(screen.getByLabelText("Supertonic 2 language"), { target: { value: "ko" } });
    await waitFor(() => expect(mock.persistEngineSettings).toHaveBeenCalledWith(
      expect.objectContaining({ supertonic: { voice: "Male 2", language: "ko" } }),
    ));
  });

  it("restores a revisited section from its clamped cached time instead of another section's progress", async () => {
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
    const document = createReaderDocument({
      id: "revisited-reader",
      text: "A paragraph with enough words for bounded Reader sections. ".repeat(700),
    });
    const sections = buildReaderSections(document.text, document.chapters);
    expect(sections.length).toBeGreaterThan(1);
    mock.readerLibrary.documents = [document];
    mock.readerLibrary.activeDocument = document;
    const cachedAudio = new Float32Array([0.1, -0.1]).buffer;
    const sectionText = getReaderSectionText(document.text, sections[1]);
    mock.readerLibrary.loadAudio
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        cacheKey: createReaderAudioCacheKey(document.id, sections[1].id),
        documentId: document.id,
        chapterId: sections[1].chapterId,
        sectionId: sections[1].id,
        signature: kokoroReaderSignature(sectionText),
        chunks: [{
          audio: cachedAudio,
          samplingRate: 24_000,
          text: sectionText,
          index: 0,
          total: 1,
        }],
        byteLength: cachedAudio.byteLength,
        currentTime: 9,
        playbackRate: 1,
        totalDuration: 4,
        updatedAt: Date.now(),
      });

    const view = render(<WebApp />);
    await waitFor(() => expect(mock.readerLibrary.loadAudio).toHaveBeenCalledWith(document.id, sections[0].id));
    fireEvent.click(await screen.findByRole("button", { name: "reader-next-section" }));

    const revisitedDocument: ReaderDocumentRecord = {
      ...document,
      progress: {
        ...document.progress,
        positionSec: 0,
        totalDurationSec: 0,
        textOffset: sections[1].start,
        chapterId: sections[1].chapterId,
        sectionId: sections[1].id,
      },
    };
    mock.readerLibrary.documents = [revisitedDocument];
    mock.readerLibrary.activeDocument = revisitedDocument;
    mock.audio8Runtime.cancelActiveGeneration.mockClear();
    mock.audio8Runtime.resetGeneratedAudio.mockClear();
    view.rerender(<WebApp />);

    await waitFor(() => expect(mock.player.restoreAudioCache).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ currentTime: 4 }),
    ));
    expect(mock.audio8Runtime.cancelActiveGeneration).toHaveBeenCalled();
    expect(mock.audio8Runtime.resetGeneratedAudio).toHaveBeenCalled();
  });

  it("does not reopen IndexedDB audio when text changes inside the active section", async () => {
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
    const document = createReaderDocument({
      id: "edit-reader",
      title: "Stable Reader",
      text: "Original Reader section text.",
    });
    mock.readerLibrary.documents = [document];
    mock.readerLibrary.activeDocument = document;
    const view = render(<WebApp />);
    await waitFor(() => expect(mock.readerLibrary.loadAudio).toHaveBeenCalledTimes(1));

    const edited = createReaderDocument({
      id: document.id,
      title: document.title,
      text: "Edited Reader section text.",
      now: document.createdAt,
    });
    mock.readerLibrary.documents = [edited];
    mock.readerLibrary.activeDocument = edited;
    view.rerender(<WebApp />);
    await Promise.resolve();

    expect(buildReaderSections(edited.text, edited.chapters)[0].id)
      .toBe(buildReaderSections(document.text, document.chapters)[0].id);
    expect(mock.readerLibrary.loadAudio).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite Reader progress while cached audio restore is pending", async () => {
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
    const baseDocument = createReaderDocument({
      id: "pending-reader",
      text: "Reader progress must survive an asynchronous cache lookup.",
    });
    const document: ReaderDocumentRecord = {
      ...baseDocument,
      progress: {
        positionSec: 3,
        totalDurationSec: 8,
        textOffset: 20,
        chapterId: baseDocument.chapters[0]?.id ?? null,
        sectionId: baseDocument.progress.sectionId,
        percent: 37.5,
        updatedAt: Date.now(),
      },
    };
    mock.readerLibrary.documents = [document];
    mock.readerLibrary.activeDocument = document;
    let resolveLoad: ((cache: CachedReaderAudio | null) => void) | undefined;
    mock.readerLibrary.loadAudio.mockReturnValue(new Promise((resolve) => {
      resolveLoad = resolve;
    }));

    render(<WebApp />);
    await waitFor(() => expect(mock.readerLibrary.loadAudio).toHaveBeenCalledWith(
      document.id,
      document.progress.sectionId,
    ));
    await Promise.resolve();

    expect(mock.readerLibrary.updateProgress).not.toHaveBeenCalled();
    act(() => resolveLoad?.(null));
    await Promise.resolve();
    expect(mock.readerLibrary.updateProgress).not.toHaveBeenCalled();
  });

  it("hides optional navigation pages without removing inline Qwen from Studio", async () => {
    Object.defineProperty(window, "electron", {
      value: {
        isElectron: true,
        platform: "darwin",
        arch: "arm64",
        localTts: mock.localTts,
      },
      configurable: true,
    });
    mock.routing = {
      activePage: "studio",
      availableTabs: [
        { key: "studio", label: "Studio" },
        { key: "reader", label: "Reader" },
        { key: "neutts", label: "NeuTTS Nano" },
        { key: "qwen3", label: "Qwen3-TTS" },
      ],
      isReaderPage: false,
      isStudioPage: true,
      navigateToPage: vi.fn(),
    };

    render(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);

    expect(screen.queryByRole("link", { name: "NeuTTS Nano" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Qwen3-TTS" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "studio-desktop-qwen3" }));
    expect(screen.getByRole("button", { name: "studio-desktop-qwen3-selected" })).toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(useModelLoader).mock.calls.at(-1)?.[1])
      .toEqual(expect.objectContaining({ active: false })));

    fireEvent.click(screen.getByRole("button", { name: "Open app settings" }));
    fireEvent.click((await screen.findAllByRole("button", { name: "Optional models" }))[0]);
    fireEvent.click(screen.getByRole("checkbox", { name: /Show NeuTTS Nano/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Show Qwen3-TTS/i }));

    expect(screen.getByRole("link", { name: "NeuTTS Nano" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Qwen3-TTS" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /Show Qwen3-TTS/i }));
    expect(screen.queryByRole("link", { name: "Qwen3-TTS" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "studio-desktop-qwen3-selected" })).toBeInTheDocument();
  });

  it.each(["seed", "model path"] as const)("changes Reader cache identity when the Qwen %s changes", async (setting) => {
    mock.getWebGPUStatus.mockReturnValue(new Promise(() => {}));
    Object.defineProperty(window, "electron", {
      value: { isElectron: true, platform: "darwin", arch: "arm64", localTts: mock.localTts },
      configurable: true,
    });
    mock.routing = { ...mock.routing, activePage: "reader", isReaderPage: true, isStudioPage: false };
    const document = createReaderDocument({ id: "qwen-cache-settings", text: "Reader speech depends on the exact Qwen settings." });
    mock.readerLibrary.documents = [document];
    mock.readerLibrary.activeDocument = document;
    render(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);
    fireEvent.click(await screen.findByRole("button", { name: "reader-desktop-qwen3" }));
    await waitFor(() => expect(screen.getByTestId("reader-can-generate")).toHaveTextContent("true"));
    const chunks = [{
      audio: new Float32Array([0.1, -0.1]).buffer,
      samplingRate: 24_000, text: document.text, index: 1, total: 1,
    }];
    mock.player.getAudioCacheSnapshot.mockReturnValue(chunks);
    fireEvent.click(screen.getByRole("link", { name: "Studio" }));
    const originalSignature = (mock.readerLibrary.saveAudio.mock.calls.at(-1) as unknown as [CachedReaderAudio])[0].signature;

    if (setting === "seed") {
      fireEvent.change(screen.getByLabelText("Qwen seed"), { target: { value: "123" } });
    } else {
      const setup = await mock.localTts.getQwen3Setup.mock.results.at(-1)!.value;
      mock.localTts.getQwen3Setup.mockResolvedValue({
        ...setup,
        profiles: setup.profiles.map((profile: { modelDir: string }) => ({ ...profile, modelDir: "/new/model/location" })),
        recommendedModelDir: "/new/model/location",
      });
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "reader-retry" })));
    }

    fireEvent.click(screen.getByRole("link", { name: "Studio" }));
    const changedSignature = (mock.readerLibrary.saveAudio.mock.calls.at(-1) as unknown as [CachedReaderAudio])[0].signature;
    expect(changedSignature).not.toBe(originalSignature);
  });

  it("keeps Qwen3 Reader audio when a Creator control it ignores changes, unlike Kokoro", async () => {
    mock.getWebGPUStatus.mockReturnValue(new Promise(() => {}));
    Object.defineProperty(window, "electron", {
      value: { isElectron: true, platform: "darwin", arch: "arm64", localTts: mock.localTts },
      configurable: true,
    });
    mock.routing = { ...mock.routing, activePage: "reader", isReaderPage: true, isStudioPage: false };
    const document = createReaderDocument({
      id: "capability-cache",
      text: "Reader audio depends only on what its engine reads.",
    });
    mock.readerLibrary.documents = [document];
    mock.readerLibrary.activeDocument = document;
    mock.player.getAudioCacheSnapshot.mockReturnValue([{
      audio: new Float32Array([0.1, -0.1]).buffer,
      samplingRate: 24_000, text: document.text, index: 1, total: 1,
    }]);
    const view = render(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);
    const flushedSignature = () => {
      fireEvent.click(screen.getByRole("link", { name: "Studio" }));
      return (mock.readerLibrary.saveAudio.mock.calls.at(-1) as unknown as [CachedReaderAudio])[0].signature;
    };
    const nudgeCreatorSpeed = () => {
      const { generationSettings } = mock.creator;
      mock.creator = { ...mock.creator, generationSettings: { ...generationSettings, speed: generationSettings.speed + 0.05 } };
      view.rerender(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);
    };

    // Kokoro reads the Creator speed, so changing it invalidates the section.
    await screen.findByRole("button", { name: "reader-desktop-qwen3" });
    const kokoroSignature = flushedSignature();
    expect(kokoroSignature).toBe(kokoroReaderSignature(document.text));
    nudgeCreatorSpeed();
    expect(flushedSignature()).not.toBe(kokoroSignature);

    // Qwen3 never receives Creator speed or quality, so its audio survives both.
    fireEvent.click(screen.getByRole("button", { name: "reader-desktop-qwen3" }));
    await waitFor(() => expect(screen.getByTestId("reader-can-generate")).toHaveTextContent("true"));
    const qwenSignature = flushedSignature();
    nudgeCreatorSpeed();
    expect(flushedSignature()).toBe(qwenSignature);
    fireEvent.click(screen.getByRole("button", { name: "reader-quality" }));
    expect(flushedSignature()).toBe(qwenSignature);
  });

  it("waits until Qwen3 knows its model directory before restoring or discarding a Reader section", async () => {
    mock.getWebGPUStatus.mockReturnValue(new Promise(() => {}));
    Object.defineProperty(window, "electron", {
      value: { isElectron: true, platform: "darwin", arch: "arm64", localTts: mock.localTts },
      configurable: true,
    });
    mock.routing = { ...mock.routing, activePage: "reader", isReaderPage: true, isStudioPage: false };
    const document = createReaderDocument({
      id: "qwen-pending-setup",
      text: "A paragraph with enough words for bounded Reader sections. ".repeat(700),
    });
    const sections = buildReaderSections(document.text, document.chapters);
    expect(sections.length).toBeGreaterThan(1);
    mock.readerLibrary.documents = [document];
    mock.readerLibrary.activeDocument = document;

    const setup = await mock.localTts.getQwen3Setup();
    let resolveSetup: (value: unknown) => void = () => undefined;
    mock.localTts.getQwen3Setup.mockReturnValue(new Promise((resolve) => { resolveSetup = resolve; }));
    const profile: Qwen3Profile = getDefaultQwen3Profile("darwin", "arm64");
    const sectionText = getReaderSectionText(document.text, sections[1]);
    const parts = engineSignatureParts("qwen3", {
      settings: {
        profile,
        modelPath: setup.profiles[0].modelDir,
        speaker: "Aiden",
        language: "English",
        instruct: "",
        temperature: 0.9,
        topK: 50,
        maxNewTokens: 384,
        seed: null,
        referenceAudioSignature: "",
        referenceText: "",
      },
      tuning: mock.creator.generationSettings,
      quality: 5,
    });
    if (!parts) throw new Error("A located Qwen3 model has a signature.");
    const cachedChunks = [{
      audio: new Float32Array([0.3, -0.3]).buffer,
      samplingRate: 24_000, text: sectionText, index: 1, total: 1,
    }];
    // Arguments are (documentId, sectionId); only the second section is cached.
    mock.readerLibrary.loadAudio.mockImplementation(async (...args: unknown[]) => (
      args[1] === sections[1].id
        ? {
            cacheKey: createReaderAudioCacheKey(document.id, sections[1].id),
            documentId: document.id,
            chapterId: sections[1].chapterId,
            sectionId: sections[1].id,
            signature: buildAudioSignature({ text: sectionText, model: "qwen3", ...parts }),
            chunks: cachedChunks,
            byteLength: cachedChunks[0].audio.byteLength,
            currentTime: 0,
            playbackRate: 1,
            totalDuration: 1,
            synthesisComplete: true,
            updatedAt: Date.now(),
          }
        : null
    ));

    const view = render(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);
    fireEvent.click(await screen.findByRole("button", { name: "reader-desktop-qwen3" }));
    fireEvent.click(screen.getByRole("button", { name: "reader-next-section" }));
    const revisited: ReaderDocumentRecord = {
      ...document,
      progress: {
        ...document.progress,
        textOffset: sections[1].start,
        chapterId: sections[1].chapterId,
        sectionId: sections[1].id,
      },
    };
    mock.readerLibrary.documents = [revisited];
    mock.readerLibrary.activeDocument = revisited;
    view.rerender(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);
    await act(async () => { await Promise.resolve(); });

    // Without a model directory there is no signature to judge the entry by:
    // it is neither restored nor thrown away.
    expect(mock.readerLibrary.loadAudio).not.toHaveBeenCalledWith(document.id, sections[1].id);
    expect(mock.readerLibrary.clearAudio).not.toHaveBeenCalled();
    expect(mock.player.restoreAudioCache).not.toHaveBeenCalled();

    await act(async () => { resolveSetup(setup); });
    await waitFor(() => expect(mock.player.restoreAudioCache).toHaveBeenCalledWith(
      cachedChunks,
      expect.objectContaining({ synthesisComplete: true }),
    ));
    expect(mock.readerLibrary.clearAudio).not.toHaveBeenCalled();
  });

  it("runs Qwen3 from the reader model option without leaving the reader tab", async () => {
    let audioChunkListener: ((event: {
      requestId: string;
      model: "qwen3";
      index: number;
      total: number;
      sampleRate: number;
      sampleCount: number;
      silenceAfterSamples: number;
      textUnitIndex?: number;
      textUnitTotal?: number;
      audio: ArrayBuffer;
    }) => void) | undefined;
    mock.localTts.subscribeAudioChunk.mockImplementation((listener) => {
      audioChunkListener = listener;
      return () => undefined;
    });
    mock.localTts.cancel.mockResolvedValue(undefined);
    mock.localTts.generate.mockReturnValue(new Promise(() => {}));
    mock.getWebGPUStatus.mockReturnValue(new Promise(() => {}));
    Object.defineProperty(window, "electron", {
      value: {
        isElectron: true,
        platform: "darwin",
        arch: "arm64",
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

    expect(screen.queryByRole("link", { name: "Qwen3-TTS" })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "reader-desktop-qwen3" }));
    expect(screen.getByRole("button", { name: "reader-desktop-qwen3-selected" })).toBeInTheDocument();
    expect(screen.getByTestId("reader-desktop-voice")).toHaveTextContent("Aiden");
    expect(screen.getByLabelText("Qwen language")).toHaveValue("English");
    await waitFor(() => expect(mock.localTts.getQwen3Setup).toHaveBeenCalled());
    await waitFor(() => expect(mock.localTts.probe).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Aiden" }));
    fireEvent.change(screen.getByLabelText("Qwen language"), { target: { value: "English" } });
    fireEvent.click(screen.getByText("Advanced voice controls"));
    expect(screen.queryByLabelText("Qwen voice instruction")).not.toBeInTheDocument();
    expect(screen.getByTestId("reader-desktop-voice")).toHaveTextContent("Aiden");
    fireEvent.click(screen.getByRole("button", { name: "reader-generate" }));

    expect(mock.generation.handleGenerate).not.toHaveBeenCalled();
    expect(mock.routing.navigateToPage).not.toHaveBeenCalledWith("qwen3");
    await waitFor(() => {
      expect(mock.localTts.generate).toHaveBeenCalledWith(expect.objectContaining({
        model: "qwen3",
        payload: expect.objectContaining({
          text: "Initial script with enough text.",
          modelRepo: "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit",
          mode: "customVoice",
          speaker: "Aiden",
          language: "English",
          instruct: "",
        }),
      }));
    });
    const request = mock.localTts.generate.mock.calls[0][0];
    act(() => {
      audioChunkListener?.({
        requestId: request.requestId,
        model: "qwen3",
        index: 0,
        total: 0,
        sampleRate: 24_000,
        sampleCount: 2,
        silenceAfterSamples: 0,
        textUnitIndex: 0,
        textUnitTotal: 1,
        audio: new Float32Array([0.25, -0.25]).buffer,
      });
    });
    await waitFor(() => expect(mock.player.scheduleChunk).toHaveBeenCalledWith(expect.objectContaining({
      text: "Initial script with enough text.",
      index: 1,
      total: 1,
      textStart: 0,
      textEnd: "Initial script with enough text.".length,
    })));
  });

  it("exposes local EPUB/file and URL import on web builds", async () => {
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

    expect(await screen.findByRole("button", { name: "reader-file-import" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "reader-url-import" })).toBeInTheDocument();
  });

  it("returns a Reader URL failure without duplicating it in the global banner", async () => {
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
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));

    try {
      render(<WebApp />);
      fireEvent.click(await screen.findByRole("button", { name: "reader-url-import" }));
      await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

      expect(screen.queryByText(
        "This site blocks direct browser imports. Use the desktop app for cross-origin article URLs.",
      )).not.toBeInTheDocument();
      expect(mock.readerLibrary.createDocument).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("imports a desktop document into the structured Reader library", async () => {
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
        arch: "arm64",
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

    fireEvent.click(await screen.findByRole("button", { name: "reader-import" }));
    expect(importDocument).toHaveBeenCalled();
    await waitFor(() => {
      expect(mock.readerLibrary.createDocument).toHaveBeenCalledWith(expect.objectContaining({
        title: "chapter",
        description: "2 pages",
        sourceType: "file",
        sourceName: "chapter.pdf",
        text: "Imported chapter text with enough length.",
      }));
    });
  });

  it("parses a desktop EPUB into the Studio script instead of clearing it", async () => {
    mock.getWebGPUStatus.mockReturnValue(new Promise(() => {}));
    const epubBytes = zipSync({
      "META-INF/container.xml": strToU8(`<?xml version="1.0"?>
        <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
          <rootfiles><rootfile full-path="OPS/book.opf" /></rootfiles>
        </container>`),
      "OPS/book.opf": strToU8(`<?xml version="1.0"?>
        <package xmlns="http://www.idpf.org/2007/opf">
          <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Studio Book</dc:title></metadata>
          <manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml" /></manifest>
          <spine><itemref idref="chapter" /></spine>
        </package>`),
      "OPS/chapter.xhtml": strToU8("<html><body><h1>Chapter</h1><p>EPUB text belongs in the Studio script.</p></body></html>"),
    });
    const importDocument = vi.fn().mockResolvedValue({
      canceled: false,
      fileName: "studio.epub",
      text: "",
      epubBytes,
    });
    Object.defineProperty(window, "electron", {
      value: {
        isElectron: true,
        platform: "darwin",
        arch: "arm64",
        documents: { importDocument },
        localTts: mock.localTts,
      },
      configurable: true,
    });

    render(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);
    fireEvent.click(screen.getByRole("button", { name: "studio-import" }));

    await waitFor(() => {
      expect((screen.getByRole("textbox", { name: "script" }) as HTMLTextAreaElement).value)
        .toContain("EPUB text belongs");
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
        arch: "arm64",
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

    fireEvent.click(await screen.findByRole("button", { name: "reader-import" }));
    await waitFor(() => {
      expect(screen.getByText('No readable text found in "scan.pdf".')).toBeInTheDocument();
    });
  });

  it("runs Qwen3 from the studio model option only in Electron without leaving Studio", async () => {
    showOptionalDesktopModels();
    mock.getWebGPUStatus.mockReturnValue(new Promise(() => {}));
    const { rerender } = render(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);
    expect(screen.queryByRole("button", { name: "studio-desktop-qwen3" })).not.toBeInTheDocument();

    Object.defineProperty(window, "electron", {
      value: {
        isElectron: true,
        platform: "darwin",
        arch: "arm64",
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

    expect(screen.getByTestId("creator-engine")).toHaveTextContent("Kokoro");
    expect(screen.getByTestId("creator-speed-disabled")).toHaveTextContent("false");
    fireEvent.click(screen.getByRole("button", { name: "studio-desktop-qwen3" }));
    expect(screen.getByRole("button", { name: "studio-desktop-qwen3-selected" })).toBeInTheDocument();
    // Qwen3 receives the script as written and paces itself.
    expect(screen.getByTestId("creator-engine")).toHaveTextContent("Qwen3-TTS");
    expect(screen.getByTestId("creator-speed-disabled")).toHaveTextContent("true");
    expect(screen.getByTestId("creator-pauses-disabled")).toHaveTextContent("true");
    // The pipeline reads Qwen3's language setting, so its dictionary and normalization follow it.
    expect(screen.getByTestId("creator-language")).toHaveTextContent("en");
    fireEvent.click(screen.getByRole("button", { name: "Serena" }));
    expect(screen.getByRole("button", { name: "Serena" })).toHaveAttribute("aria-pressed", "true");
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
          speaker: "Serena",
        }),
      }));
    });
  });

  it("renders local runtime routes", async () => {
    showOptionalDesktopModels();
    Object.defineProperty(window, "electron", {
      value: { isElectron: true, platform: "darwin", arch: "arm64", localTts: mock.localTts },
      configurable: true,
    });
    mock.getWebGPUStatus.mockReturnValue(new Promise(() => {}));
    mock.routing = {
      activePage: "neutts",
      availableTabs: [{ key: "studio", label: "Studio" }],
      isReaderPage: false,
      isStudioPage: false,
      navigateToPage: vi.fn(),
    };

    const { rerender } = render(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);
    expect(await screen.findByText("NeuTTS Nano / Air (Neuphonic)")).toBeInTheDocument();

    mock.routing = {
      ...mock.routing,
      activePage: "qwen3",
    };
    rerender(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);

    expect(await screen.findByText("Qwen3-TTS 12Hz Native")).toBeInTheDocument();
  });

  it("unmounts inactive local runtimes so their model and audio state is released", async () => {
    showOptionalDesktopModels();
    Object.defineProperty(window, "electron", {
      value: { isElectron: true, platform: "darwin", arch: "arm64", localTts: mock.localTts },
      configurable: true,
    });
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
    const neuttsState = await screen.findByTestId("local-draft-neutts") as HTMLInputElement;
    fireEvent.change(neuttsState, { target: { value: "voice reference kept" } });
    expect(screen.queryByTestId("local-draft-qwen3")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "Qwen3-TTS" }));
    mock.routing = {
      ...mock.routing,
      activePage: "qwen3",
    };
    rerender(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);

    expect(screen.queryByTestId("local-runtime-panel-neutts")).not.toBeInTheDocument();
    const qwen3State = await screen.findByTestId("local-draft-qwen3") as HTMLInputElement;
    fireEvent.change(qwen3State, { target: { value: "qwen3 settings kept" } });

    fireEvent.click(screen.getByRole("link", { name: "Studio" }));
    mock.routing = {
      ...mock.routing,
      activePage: "studio",
      isStudioPage: true,
    };
    rerender(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);

    expect(screen.queryByTestId("local-runtime-panel-neutts")).not.toBeInTheDocument();
    expect(screen.queryByTestId("local-runtime-panel-qwen3")).not.toBeInTheDocument();

    mock.routing = {
      ...mock.routing,
      activePage: "neutts",
      isStudioPage: false,
    };
    rerender(<SynthesisApp enableDesktopRuntimes routeBasePath="/desktop" />);

    expect(screen.getByTestId("local-runtime-panel-neutts")).not.toHaveAttribute("hidden");
    expect(screen.queryByTestId("local-runtime-panel-qwen3")).not.toBeInTheDocument();
    expect(screen.getByTestId("local-draft-neutts")).toHaveValue("neutts draft");
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
