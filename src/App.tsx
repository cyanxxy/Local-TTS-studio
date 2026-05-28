import { useState, useCallback, useEffect, useMemo } from "react";
import type { ChunkPauseKind, ModelType } from "./types";
import { MIN_TEXT_LENGTH } from "./constants";
import { useModelLoader } from "./hooks/useModelLoader";
import { useAudioPlayer } from "./hooks/useAudioPlayer";
import { useTTS } from "./hooks/useTTS";
import { useAppRouting } from "./hooks/useAppRouting";
import { useCreatorSettings } from "./hooks/useCreatorSettings";
import { useGenerationControl } from "./hooks/useGenerationControl";
import { useModelCacheControls } from "./hooks/useModelCacheControls";
import { TextInput } from "./components/TextInput";
import { ModelToggle } from "./components/ModelToggle";
import { VoiceSelector } from "./components/VoiceSelector";
import { Controls } from "./components/Controls";
import { ControlsProvider } from "./components/ControlsContext";
import { AudioPlayer } from "./components/AudioPlayer";
import { DownloadProgress } from "./components/DownloadProgress";
import { SettingsPanel } from "./components/SettingsPanel";
import { CreatorToolsPanel } from "./components/CreatorToolsPanel";
import { AdvancedReaderPage } from "./components/AdvancedReaderPage";
import { LocalRuntimePage } from "./components/LocalRuntimePage";
import { PAGE_PATH, type AppPage } from "./lib/appRouting";
import {
  getDefaultSupportedModel,
  getLocalBrowserSupport,
  getUnsupportedModelMessage,
  isModelSupportedInBrowser,
} from "./lib/browserSupport";
import { getWebGPUStatus, type WebGPUStatus } from "./lib/webgpu";
import {
  getInitialAppState,
  getInitialCreatorState,
  persistAppState,
  persistCreatorState,
  type PersistedAppState,
} from "./lib/appState";
import { resolveKokoroVoice } from "./lib/voices";
import { hasMinimumSynthesisText } from "./lib/textValidation";

type LocalRuntimePageKey = Extract<AppPage, "neutts" | "kani" | "qwen3">;

const LOCAL_RUNTIME_PAGE_KEYS = ["neutts", "kani", "qwen3"] as const satisfies readonly LocalRuntimePageKey[];

const LOCAL_RUNTIME_PAGE_CONFIG: Record<LocalRuntimePageKey, {
  name: string;
  releaseDate: string;
  params: string;
  highlights: string[];
  links: Array<{ label: string; href: string }>;
}> = {
  neutts: {
    name: "NeuTTS Nano (Neuphonic)",
    releaseDate: "February 12, 2026",
    params: "~120M active params (~229M incl. embeddings)",
    highlights: [
      "On-device, CPU-focused speech generation and instant voice cloning from short references.",
      "Multilingual Nano variants published for English, German, French, and Spanish.",
      "Uses local Python runtime bridge with cache controls in this desktop app.",
    ],
    links: [
      { label: "HF Model", href: "https://huggingface.co/neuphonic/neutts-nano" },
      { label: "HF Collection", href: "https://huggingface.co/collections/neuphonic/neutts-nano-multilingual-collection" },
      { label: "GitHub", href: "https://github.com/neuphonic/neutts" },
    ],
  },
  kani: {
    name: "Kani-TTS-2 (nineninesix)",
    releaseDate: "February 15, 2026",
    params: "~400M",
    highlights: [
      "Open model with low-VRAM local inference profile for desktop generation.",
      "Maintainer reports stable generation expectations around long utterances; docs note quality drops past ~40 seconds.",
      "Uses local Python runtime bridge with cache controls in this desktop app.",
    ],
    links: [
      { label: "HF Model", href: "https://huggingface.co/nineninesix/kani-tts-2-en" },
      { label: "GitHub", href: "https://github.com/nineninesix-ai/kani-tts-2" },
    ],
  },
  qwen3: {
    name: "Qwen3-TTS 12Hz CustomVoice",
    releaseDate: "January 29, 2026",
    params: "~1.9B",
    highlights: [
      "CustomVoice model with nine built-in premium speakers and instruction-guided style control.",
      "Supports Chinese, English, Japanese, Korean, German, French, Russian, Portuguese, Spanish, and Italian.",
      "Runs through the Electron Python bridge because the released model ships qwen-tts/safetensors assets, not browser ONNX artifacts.",
    ],
    links: [
      { label: "HF Model", href: "https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice" },
      { label: "HF Tokenizer", href: "https://huggingface.co/Qwen/Qwen3-TTS-Tokenizer-12Hz" },
      { label: "GitHub", href: "https://github.com/QwenLM/Qwen3-TTS" },
    ],
  },
};

function isLocalRuntimePage(page: AppPage): page is LocalRuntimePageKey {
  return (LOCAL_RUNTIME_PAGE_KEYS as readonly AppPage[]).includes(page);
}

export default function App() {
  const isElectronRuntime = Boolean(window.electron?.isElectron);
  const debugProfiling = useMemo(
    () => typeof window !== "undefined"
      && import.meta.env.DEV
      && new URLSearchParams(window.location.search).get("profile") === "1",
    [],
  );
  const initialState = useMemo(() => getInitialAppState(), []);
  const initialCreatorState = useMemo(() => getInitialCreatorState(), []);
  const browserSupport = useMemo(
    () => getLocalBrowserSupport(typeof navigator === "undefined" ? undefined : navigator, isElectronRuntime),
    [isElectronRuntime],
  );
  const localInferenceSupported = browserSupport.isSupported;
  const unavailableModels = browserSupport.unsupportedModelMessages;
  const { activePage, availableTabs, isReaderPage, isStudioPage, navigateToPage } = useAppRouting(isElectronRuntime);

  const [text, setText] = useState(initialState.text);
  const [activeModel, setActiveModel] = useState<ModelType>(() => (
    isModelSupportedInBrowser(initialState.model, browserSupport)
      ? initialState.model
      : getDefaultSupportedModel(browserSupport)
  ));
  const [voicesByModel, setVoicesByModel] = useState<Record<ModelType, string>>(initialState.voicesByModel);
  const [quality, setQuality] = useState(initialState.quality);
  const [showPlayer, setShowPlayer] = useState(false);
  const [webgpuStatus, setWebgpuStatus] = useState<WebGPUStatus | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [visitedLocalRuntimePages, setVisitedLocalRuntimePages] = useState<Set<LocalRuntimePageKey>>(
    () => (isLocalRuntimePage(activePage) ? new Set([activePage]) : new Set()),
  );

  const {
    kokoroState,
    supertonicState,
    kokoroWorker,
    supertonicWorker,
    kokoroVoices,
    loadModel,
    reloadModel,
  } = useModelLoader(activeModel, {
    enabled: localInferenceSupported,
    preferredSupertonicVoice: voicesByModel.supertonic,
    debugProfiling,
    supportedModels: browserSupport.supportedModels,
  });

  const player = useAudioPlayer();

  const onAudioChunk = useCallback(
    (chunk: {
      audio: Float32Array;
      samplingRate: number;
      text: string;
      index: number;
      total: number;
      textStart?: number;
      textEnd?: number;
      pauseAfterSec?: number;
      pauseKind?: ChunkPauseKind;
    }) => {
      void player.scheduleChunk({
        audio: chunk.audio,
        samplingRate: chunk.samplingRate,
        text: chunk.text,
        index: chunk.index,
        total: chunk.total,
        textStart: chunk.textStart,
        textEnd: chunk.textEnd,
        pauseAfterSec: chunk.pauseAfterSec,
        pauseKind: chunk.pauseKind,
      });
    },
    [player],
  );

  const onComplete = useCallback(() => {}, []);

  const tts = useTTS({ kokoroWorker, supertonicWorker, onAudioChunk, onComplete });
  const currentModelState = activeModel === "kokoro" ? kokoroState : supertonicState;
  const activeModelSupported = isModelSupportedInBrowser(activeModel, browserSupport);
  const canGenerate = localInferenceSupported
    && activeModelSupported
    && hasMinimumSynthesisText(text, MIN_TEXT_LENGTH)
    && currentModelState.ready;

  const creator = useCreatorSettings({
    initialState: initialCreatorState,
    quality,
  });

  const kokoroVoice = useMemo(() => {
    if (kokoroVoices.length === 0) return voicesByModel.kokoro;
    return resolveKokoroVoice(voicesByModel.kokoro, kokoroVoices) ?? voicesByModel.kokoro;
  }, [kokoroVoices, voicesByModel.kokoro]);
  const voice = activeModel === "kokoro" ? kokoroVoice : voicesByModel.supertonic;
  const {
    isRetakingSegment,
    isGenerationBusy,
    cancelActiveGeneration,
    resetGeneratedAudio,
    handleGenerate: runBrowserGeneration,
    handleStop,
    handleRetakeSegment,
  } = useGenerationControl({
    activeModel,
    canGenerate,
    generationSettings: creator.generationSettings,
    kokoroWorker,
    supertonicWorker,
    player,
    setShowPlayer,
    text,
    tts,
    voice,
  });

  const {
    cacheBusy,
    cacheStatus,
    clearCache: handleClearCache,
    redownloadActiveModel: handleRedownloadActiveModel,
    retryActiveModelLoad: handleRetryActiveModelLoad,
  } = useModelCacheControls({
    activeModel,
    cancelActiveGeneration,
    resetGeneratedAudio,
    reloadModel,
  });

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const persisted: PersistedAppState = {
        model: activeModel,
        text,
        voicesByModel,
        quality,
      };
      persistAppState(persisted);
    }, 200);

    return () => window.clearTimeout(timeoutId);
  }, [activeModel, quality, text, voicesByModel]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      persistCreatorState(creator.persistedState);
    }, 200);

    return () => window.clearTimeout(timeoutId);
  }, [creator.persistedState]);

  const handleModelChange = useCallback((model: ModelType) => {
    if (model === activeModel) return;
    if (!isModelSupportedInBrowser(model, browserSupport)) return;
    cancelActiveGeneration();
    resetGeneratedAudio();
    setActiveModel(model);
    loadModel(model);
    setExportError(null);
  }, [activeModel, browserSupport, cancelActiveGeneration, loadModel, resetGeneratedAudio]);

  const handleTextChange = useCallback((nextText: string) => {
    if (nextText === text) return;

    const hasActiveAudioState = tts.isGenerating || isRetakingSegment || player.segments.length > 0 || player.totalDuration > 0;
    if (hasActiveAudioState) {
      cancelActiveGeneration(true);
      resetGeneratedAudio();
    }

    setText(nextText);
    setExportError(null);
  }, [cancelActiveGeneration, isRetakingSegment, player.segments.length, player.totalDuration, resetGeneratedAudio, text, tts.isGenerating]);

  const handleVoiceChange = useCallback((nextVoice: string) => {
    if (nextVoice === voice) return;
    cancelActiveGeneration();
    resetGeneratedAudio();
    setVoicesByModel((prev) => ({ ...prev, [activeModel]: nextVoice }));
    setExportError(null);
  }, [activeModel, cancelActiveGeneration, resetGeneratedAudio, voice]);

  const handleQualityChange = useCallback((nextQuality: number) => {
    if (nextQuality === quality) return;
    cancelActiveGeneration();
    resetGeneratedAudio();
    setQuality(nextQuality);
    setExportError(null);
  }, [cancelActiveGeneration, quality, resetGeneratedAudio]);

  useEffect(() => {
    if (!localInferenceSupported) return;

    let cancelled = false;
    const check = async () => {
      const status = await getWebGPUStatus();
      if (!cancelled) {
        setWebgpuStatus(status);
      }
    };
    void check();

    return () => {
      cancelled = true;
    };
  }, [localInferenceSupported]);

  const rememberLocalRuntimePage = useCallback((page: LocalRuntimePageKey) => {
    setVisitedLocalRuntimePages((prev) => {
      if (prev.has(page)) return prev;
      const next = new Set(prev);
      next.add(page);
      return next;
    });
  }, []);

  const handlePageNavigation = useCallback((page: AppPage) => {
    if (isLocalRuntimePage(activePage)) {
      rememberLocalRuntimePage(activePage);
    }
    if (isLocalRuntimePage(page)) {
      rememberLocalRuntimePage(page);
    }
    navigateToPage(page);
  }, [activePage, navigateToPage, rememberLocalRuntimePage]);

  const mountedLocalRuntimePages = useMemo(() => {
    const pages = new Set(visitedLocalRuntimePages);
    if (isLocalRuntimePage(activePage)) {
      pages.add(activePage);
    }
    return LOCAL_RUNTIME_PAGE_KEYS.filter((page) => pages.has(page));
  }, [activePage, visitedLocalRuntimePages]);

  const isUsingWasmFallback = currentModelState.ready && currentModelState.backend === "wasm";

  const handleJumpToSegment = useCallback((segmentId: string) => {
    if (!segmentId) return;
    player.jumpToSegment(segmentId);
    setShowPlayer(true);
  }, [player]);

  const handleGenerate = useCallback(() => {
    setExportError(null);
    runBrowserGeneration();
  }, [runBrowserGeneration]);

  const handleDownloadAudio = useCallback(() => {
    setExportError(null);
    void player.download(creator.exportOptions).catch((error: unknown) => {
      setExportError(error instanceof Error ? error.message : String(error));
    });
  }, [creator.exportOptions, player]);

  const handleDownloadCaptions = useCallback((format: "srt" | "vtt" | "json") => {
    player.downloadCaptions(format);
  }, [player]);

  const creatorPanel = (
    <CreatorToolsPanel
      preset={creator.creatorPreset}
      onPresetChange={creator.onCreatorPresetChange}
      speed={creator.speed}
      onSpeedChange={creator.onSpeedChange}
      pauseCommaSec={creator.pauseCommaSec}
      onPauseCommaSecChange={creator.onPauseCommaChange}
      pauseSentenceSec={creator.pauseSentenceSec}
      onPauseSentenceSecChange={creator.onPauseSentenceChange}
      pauseParagraphSec={creator.pauseParagraphSec}
      onPauseParagraphSecChange={creator.onPauseParagraphChange}
      pronunciationLexicon={creator.pronunciationLexicon}
      onPronunciationLexiconChange={creator.onPronunciationLexiconChange}
      exportOptions={creator.exportOptions}
      onExportFormatChange={creator.onExportFormatChange}
      onExportSampleRateChange={creator.onExportSampleRateChange}
      onExportBitrateKbpsChange={creator.onExportBitrateChange}
      onMasteringEnabledChange={creator.onMasteringEnabledChange}
      hasAudio={player.totalDuration > 0}
      onDownloadAudio={handleDownloadAudio}
      onDownloadCaptions={handleDownloadCaptions}
    />
  );

  const showWasmBadge = localInferenceSupported
    && (isStudioPage || isReaderPage)
    && ((webgpuStatus !== null && !webgpuStatus.available) || isUsingWasmFallback);
  const webgpuModeNote = showWasmBadge
    ? webgpuStatus?.message ?? null
    : null;
  const showSingleThreadedNote = showWasmBadge && !window.crossOriginIsolated;
  const activeModelSupportMessage = getUnsupportedModelMessage(activeModel, browserSupport);
  const visibleError = tts.error ?? currentModelState.error ?? exportError ?? player.error;
  const activeSegmentIndex = player.activeSegmentId
    ? player.segments.findIndex((segment) => segment.id === player.activeSegmentId)
    : -1;
  const activeSegmentNumber = activeSegmentIndex >= 0 ? activeSegmentIndex + 1 : null;
  const browserSupportPanel = browserSupport.message ? (
    <div className="rounded-2xl border border-accent/20 bg-accent-light/60 shadow-sm">
      <div className="p-4 sm:p-6 md:p-8">
        <div className="inline-flex items-center rounded-full border border-accent/20 bg-panel px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-accent">
          iOS rollout
        </div>
        <h2 className="mt-4 text-[1.5rem] font-display font-bold tracking-tight text-text-primary sm:text-[1.8rem]">
          Open TTS runs on iPhone and iPad browsers with a guarded model set
        </h2>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-text-secondary">
          {browserSupport.message}
        </p>
      </div>
    </div>
  ) : null;

  return (
    <div className="min-h-screen font-sans text-text-primary">
      <div className={isReaderPage ? "w-full px-3 py-3 sm:px-4 sm:py-4 md:px-6 md:py-6" : "mx-auto max-w-5xl px-4 py-8 sm:px-5 sm:py-10 md:py-14"}>

        {/* Header */}
        <header className={isReaderPage ? "mb-4" : "mb-8 sm:mb-10"}>
          <div className={`flex justify-between gap-4 flex-wrap ${isReaderPage ? "items-center" : "items-start"}`}>
            <div>
              <h1
                className={`${isReaderPage ? "text-[1.75rem] sm:text-[2rem]" : "text-[2.2rem] sm:text-[2.8rem]"} font-display leading-none font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-br from-text-primary to-accent/70`}
              >
                Open TTS
              </h1>
              {!isReaderPage && (
                <p className="mt-3 text-[13px] font-medium tracking-wide text-text-secondary sm:text-[14px]">
                  On-device synthesis — no server, no keys, no data leaves your browser.
                </p>
              )}
            </div>

            {showWasmBadge && (
              <div className="mt-1 flex flex-col items-end gap-1 flex-shrink-0">
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-accent-light text-accent text-[13px] font-semibold shadow-sm">
                  <span className="w-1.5 h-1.5 rounded-full bg-accent shadow-[0_0_8px_var(--color-accent)] animate-pulse" />
                  CPU mode
                </div>
                {webgpuModeNote && (
                  <p className="max-w-full text-left text-[11px] leading-4 text-text-muted sm:max-w-[240px] sm:text-right">
                    {webgpuModeNote}
                  </p>
                )}
                {showSingleThreadedNote && (
                  <p className="max-w-full text-left text-[11px] leading-4 text-text-muted sm:max-w-[220px] sm:text-right">
                    Cross-origin isolation is missing, so CPU fallback is stuck single-threaded.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Page navigation */}
          <nav className={`${isReaderPage ? "mt-4" : "mt-6 sm:mt-8"} grid w-full grid-cols-2 gap-1.5 rounded-xl border border-border bg-panel p-1 shadow-sm sm:inline-flex sm:w-auto`}>
            {availableTabs.map((tab) => (
              <a
                key={tab.key}
                href={PAGE_PATH[tab.key]}
                onClick={(event) => {
                  event.preventDefault();
                  handlePageNavigation(tab.key);
                }}
                className={`relative px-5 py-2 text-[13px] font-semibold transition-all duration-200 rounded-lg ${
                  activePage === tab.key
                    ? "bg-surface text-text-primary shadow-sm border border-border-strong/60"
                    : "text-text-muted hover:text-text-secondary hover:bg-surface/60"
                } text-center`}
              >
                {tab.label}
              </a>
            ))}
          </nav>
        </header>

        {(isStudioPage || isReaderPage) && browserSupportPanel && (
          <div className="mb-4">{browserSupportPanel}</div>
        )}

        {localInferenceSupported && (isStudioPage || isReaderPage) && visibleError && (
          <div className="mb-4 rounded-lg border border-danger/30 bg-danger-light px-3 py-2 text-xs text-danger">
            {visibleError}
          </div>
        )}

        {/* Studio page */}
        {isStudioPage ? (
          localInferenceSupported ? (
            <>
            <DownloadProgress kokoroState={kokoroState} supertonicState={supertonicState} />

            <div className="mt-6 bg-panel border border-border/60 rounded-2xl shadow-lg">
              <div className="grid grid-cols-1 lg:grid-cols-5">
                {/* Left: text input */}
                <div className="flex min-h-[320px] flex-col border-border/40 p-4 sm:min-h-[360px] sm:p-6 lg:col-span-3 lg:border-r">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-text-muted mb-3 flex-shrink-0">Script</span>
                  <div className="flex-1 min-h-0">
                    <TextInput text={text} onTextChange={handleTextChange} />
                  </div>
                </div>

                {/* Right: controls */}
                <div className="flex flex-col gap-5 border-t border-border/40 p-4 sm:gap-6 sm:p-6 lg:col-span-2 lg:border-t-0">
                  <ModelToggle
                    activeModel={activeModel}
                    onModelChange={handleModelChange}
                    kokoroState={kokoroState}
                    supertonicState={supertonicState}
                    unavailableModels={unavailableModels}
                  />

                  <VoiceSelector
                    activeModel={activeModel}
                    voice={voice}
                    onVoiceChange={handleVoiceChange}
                    kokoroVoices={kokoroVoices}
                  />

                  <ControlsProvider
                    value={{
                      activeModel,
                      quality,
                      onQualityChange: handleQualityChange,
                      onGenerate: handleGenerate,
                      onRetryLoad: handleRetryActiveModelLoad,
                      onStop: handleStop,
                      isGenerating: isGenerationBusy,
                      canGenerate,
                      modelReady: currentModelState.ready,
                      modelError: currentModelState.error,
                      loadingProgress: currentModelState.downloadProgress,
                      generationProgress: tts.generationProgress,
                    }}
                  >
                    <Controls />
                  </ControlsProvider>
                </div>
              </div>

              {showPlayer && (
                <div className="border-t border-border/40 animate-fade-up">
                  <AudioPlayer
                    embedded
                    isPlaying={player.isPlaying}
                    currentTime={player.currentTime}
                    totalDuration={player.totalDuration}
                    segmentCount={player.segments.length}
                    activeSegmentNumber={activeSegmentNumber}
                    stats={tts.stats}
                    isGenerating={tts.isGenerating}
                    onTogglePlay={player.togglePlay}
                    onSeek={player.seek}
                    onSkipBackward={() => player.skip(-10)}
                    onSkipForward={() => player.skip(10)}
                    onDownload={handleDownloadAudio}
                    onStop={handleStop}
                  />
                </div>
              )}
            </div>

            <div className="mt-4">
              <SettingsPanel
                activeModel={activeModel}
                busy={cacheBusy}
                status={cacheStatus}
                onClearCache={handleClearCache}
                onRedownloadActive={handleRedownloadActiveModel}
              />
            </div>

            <div className="mt-4">
              {creatorPanel}
            </div>
            </>
          ) : browserSupportPanel
        ) : isReaderPage ? (
          localInferenceSupported ? (
            <AdvancedReaderPage
              fullScreen
              text={text}
              onTextChange={handleTextChange}
              activeModel={activeModel}
              onModelChange={handleModelChange}
              kokoroState={kokoroState}
              supertonicState={supertonicState}
              unavailableModels={unavailableModels}
              kokoroVoices={kokoroVoices}
              voice={voice}
              onVoiceChange={handleVoiceChange}
              quality={quality}
              onQualityChange={handleQualityChange}
              canGenerate={canGenerate}
              modelReady={currentModelState.ready}
              modelError={currentModelState.error}
              loadingProgress={currentModelState.downloadProgress}
              generationProgress={tts.generationProgress}
              isGenerating={isGenerationBusy}
              onGenerate={handleGenerate}
              onRetryLoad={handleRetryActiveModelLoad}
              onStop={handleStop}
              stats={tts.stats}
              isPlaying={player.isPlaying}
              currentTime={player.currentTime}
              totalDuration={player.totalDuration}
              segments={player.segments}
              activeSegmentId={player.activeSegmentId}
              onTogglePlay={player.togglePlay}
              onSeek={player.seek}
              onSkipBackward={() => player.skip(-10)}
              onSkipForward={() => player.skip(10)}
              onDownload={handleDownloadAudio}
              isRetaking={isRetakingSegment}
              onRetakeSegment={handleRetakeSegment}
              onJumpToSegment={handleJumpToSegment}
            />
          ) : browserSupportPanel
        ) : null}

        {mountedLocalRuntimePages.map((page) => {
          const config = LOCAL_RUNTIME_PAGE_CONFIG[page];
          const isActive = activePage === page;
          return (
            <section
              key={page}
              data-testid={`local-runtime-panel-${page}`}
              hidden={!isActive}
              aria-hidden={!isActive}
            >
              <LocalRuntimePage
                model={page}
                name={config.name}
                releaseDate={config.releaseDate}
                params={config.params}
                highlights={config.highlights}
                links={config.links}
              />
            </section>
          );
        })}

        {/* Footer */}
        {!isReaderPage && (
          <footer className="mt-16 border-t border-border/40 pt-5">
            {isStudioPage && localInferenceSupported && !browserSupport.message ? (
              <div className="flex items-center flex-wrap gap-1.5">
                {(["Kokoro-82M", "Supertonic TTS", "WebGPU · WASM"] as const).map((label) => (
                  <span
                    key={label}
                    className="px-2 py-0.5 rounded-md border border-border/60 font-mono text-[10px] text-text-muted/60"
                  >
                    {label}
                  </span>
                ))}
                <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-md border border-success/20 bg-success/[0.04] font-mono text-[10px] text-success/70">
                  <span
                    className="w-1 h-1 rounded-full bg-success opacity-80 animate-pulse"
                    style={{ boxShadow: "0 0 5px var(--color-success)" }}
                  />
                  all local
                </span>
              </div>
            ) : (
              <p className="font-mono text-[10px] text-text-muted/60">
                {isStudioPage
                  ? activeModelSupportMessage
                    ?? browserSupport.message
                    ?? "Tracking promising local TTS models — full in-app integration depends on compatible runtimes."
                  : "Tracking promising local TTS models — full in-app integration depends on compatible runtimes."}
              </p>
            )}
          </footer>
        )}

      </div>
    </div>
  );
}
