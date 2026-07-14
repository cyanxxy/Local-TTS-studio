import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import type { ChunkPauseKind, ModelType } from "../types";
import { MIN_TEXT_LENGTH } from "../constants";
import { useModelLoader } from "../hooks/useModelLoader";
import { useAudioPlayer } from "../hooks/useAudioPlayer";
import { useTTS } from "../hooks/useTTS";
import { useAppRouting } from "../hooks/useAppRouting";
import { useCreatorSettings } from "../hooks/useCreatorSettings";
import { useGenerationControl } from "../hooks/useGenerationControl";
import { useModelCacheControls } from "../hooks/useModelCacheControls";
import { useQwen3LocalRuntime } from "../hooks/useQwen3LocalRuntime";
import { Qwen3RuntimeProvider, useQwen3Runtime } from "../contexts/Qwen3RuntimeContext";
import { Qwen3InlineSettings } from "../components/Qwen3InlineSettings";
import { useReaderLibrary } from "../hooks/useReaderLibrary";
import { TextInput } from "../components/TextInput";
import { ModelToggle } from "../components/ModelToggle";
import { VoiceSelector } from "../components/VoiceSelector";
import { Controls } from "../components/Controls";
import { ControlsProvider } from "../components/ControlsContext";
import { AudioPlayer } from "../components/AudioPlayer";
import { DownloadProgress } from "../components/DownloadProgress";
import { SettingsPanel } from "../components/SettingsPanel";
import { CreatorToolsPanel } from "../components/CreatorToolsPanel";
import { AdvancedReaderPage } from "../components/AdvancedReaderPage";
import { LocalRuntimePage } from "../components/LocalRuntimePage";
import { getPagePath, type AppPage } from "../lib/appRouting";
import {
  getDefaultSupportedModel,
  getLocalBrowserSupport,
  getUnsupportedModelMessage,
  isModelSupportedInBrowser,
} from "../lib/browserSupport";
import { getWebGPUStatus, type WebGPUStatus } from "../lib/webgpu";
import {
  getInitialAppState,
  getInitialCreatorState,
  persistAppState,
  persistCreatorState,
  type PersistedAppState,
} from "../lib/appState";
import { resolveKokoroVoice } from "../lib/voices";
import { hasMinimumSynthesisText } from "../lib/textValidation";
import {
  buildAudioSignature,
} from "../lib/readerDocument";
import {
  fetchRemoteDocument,
  importReaderFile,
  parseEpubDocument,
  parseHtmlReaderDocument,
} from "../lib/readerImport";

type LocalRuntimePageKey = Extract<AppPage, "neutts" | "qwen3">;
type InlineDesktopModelKey = Extract<LocalRuntimePageKey, "qwen3">;

interface SynthesisAppProps {
  enableDesktopRuntimes: boolean;
  routeBasePath?: string;
}

const LOCAL_RUNTIME_PAGE_KEYS = ["neutts", "qwen3"] as const satisfies readonly LocalRuntimePageKey[];

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
    params: "~120M active (~229M with embeddings)",
    highlights: [
      "CPU-friendly speech with instant voice cloning from short references.",
      "Nano variants for English, German, French, and Spanish.",
      "Runs on the Rust bridge with GGUF models and .npy reference codes.",
    ],
    links: [
      { label: "HF Model", href: "https://huggingface.co/neuphonic/neutts-nano" },
      { label: "HF Collection", href: "https://huggingface.co/collections/neuphonic/neutts-nano-multilingual-collection" },
      { label: "GitHub", href: "https://github.com/neuphonic/neutts" },
    ],
  },
  qwen3: {
    name: "Qwen3-TTS 12Hz Native",
    releaseDate: "January 29, 2026",
    params: "0.6B / 1.7B",
    highlights: [
      "Defaults to the fastest native 0.6B CustomVoice profile for this platform.",
      "Voice cloning available via the Base profile with a reference WAV and transcript.",
      "Runs on the resident Rust bridge — these models ship as local runtime formats, not browser ONNX.",
    ],
    links: [
      { label: "MLX CustomVoice 0.6B", href: "https://huggingface.co/mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit" },
      { label: "MLX CustomVoice 1.7B", href: "https://huggingface.co/mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-6bit" },
      { label: "MLX Base 0.6B", href: "https://huggingface.co/mlx-community/Qwen3-TTS-12Hz-0.6B-Base-6bit" },
      { label: "HF 0.6B", href: "https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice" },
      { label: "HF 1.7B", href: "https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice" },
      { label: "HF Tokenizer", href: "https://huggingface.co/Qwen/Qwen3-TTS-Tokenizer-12Hz" },
      { label: "GitHub", href: "https://github.com/QwenLM/Qwen3-TTS" },
    ],
  },
};

function isLocalRuntimePage(page: AppPage): page is LocalRuntimePageKey {
  return (LOCAL_RUNTIME_PAGE_KEYS as readonly AppPage[]).includes(page);
}

function SynthesisAppContent({ enableDesktopRuntimes, routeBasePath = "" }: SynthesisAppProps) {
  const isElectronRuntime = Boolean(window.electron?.isElectron);
  const qwen3Settings = useQwen3Runtime();
  const qwen3ProviderDetail = window.electron?.platform === "win32"
    ? `${qwen3Settings.profile.parameters} ${qwen3Settings.profile.mode === "customVoice" ? qwen3Settings.speaker : "Voice clone"} · LibTorch`
    : `${qwen3Settings.profile.parameters} ${qwen3Settings.profile.mode === "customVoice" ? qwen3Settings.speaker : "Voice clone"} · Apple MLX`;
  const debugProfiling = useMemo(
    () => typeof window !== "undefined"
      && import.meta.env.DEV
      && new URLSearchParams(window.location.search).get("profile") === "1",
    [],
  );

  useEffect(() => {
    const root = document.documentElement;
    const isMac = typeof navigator !== "undefined"
      && /Mac/i.test(navigator.platform || navigator.userAgent || "");
    root.classList.toggle("is-electron", isElectronRuntime);
    root.classList.toggle("is-mac", isMac);
  }, [isElectronRuntime]);
  const initialState = useMemo(() => getInitialAppState(), []);
  const initialCreatorState = useMemo(() => getInitialCreatorState(), []);
  const browserSupport = useMemo(
    () => getLocalBrowserSupport(typeof navigator === "undefined" ? undefined : navigator, isElectronRuntime),
    [isElectronRuntime],
  );
  const localInferenceSupported = browserSupport.isSupported;
  const unavailableModels = browserSupport.unsupportedModelMessages;
  const { activePage, availableTabs, isReaderPage, isStudioPage, navigateToPage } = useAppRouting(
    enableDesktopRuntimes,
    routeBasePath,
  );

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
  const [importError, setImportError] = useState<string | null>(null);
  const [isImportingDocument, setIsImportingDocument] = useState(false);
  const [studioDesktopModel, setStudioDesktopModel] = useState<InlineDesktopModelKey | null>(null);
  const [readerDesktopModel, setReaderDesktopModel] = useState<InlineDesktopModelKey | null>(() => (
    enableDesktopRuntimes && isElectronRuntime ? "qwen3" : null
  ));
  const [visitedLocalRuntimePages, setVisitedLocalRuntimePages] = useState<Set<LocalRuntimePageKey>>(
    () => (enableDesktopRuntimes && isLocalRuntimePage(activePage) ? new Set([activePage]) : new Set()),
  );
  const readerLibrary = useReaderLibrary(initialState.text);

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
  const isReaderUsingQwen3 = isReaderPage && readerDesktopModel === "qwen3";
  const isStudioUsingQwen3 = isStudioPage && studioDesktopModel === "qwen3";
  const isUsingQwen3Inline = isReaderUsingQwen3 || isStudioUsingQwen3;
  const qwen3LocalRuntime = useQwen3LocalRuntime({
    enabled: enableDesktopRuntimes && isElectronRuntime && isUsingQwen3Inline,
    text,
    player,
    setShowPlayer,
  });

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
    retakeError,
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

  const selectBrowserModel = useCallback((
    model: ModelType,
    currentDesktopModel: InlineDesktopModelKey | null,
    clearDesktopModel: () => void,
  ) => {
    if (!isModelSupportedInBrowser(model, browserSupport)) return;
    if (model === activeModel && currentDesktopModel === null) return;
    cancelActiveGeneration();
    qwen3LocalRuntime.cancelActiveGeneration();
    resetGeneratedAudio();
    qwen3LocalRuntime.resetGeneratedAudio();
    clearDesktopModel();
    if (model !== activeModel) {
      setActiveModel(model);
      loadModel(model);
    }
    setExportError(null);
  }, [
    activeModel,
    browserSupport,
    cancelActiveGeneration,
    loadModel,
    qwen3LocalRuntime,
    resetGeneratedAudio,
  ]);

  const handleStudioModelChange = useCallback((model: ModelType) => {
    selectBrowserModel(model, studioDesktopModel, () => setStudioDesktopModel(null));
  }, [selectBrowserModel, studioDesktopModel]);

  const handleReaderModelChange = useCallback((model: ModelType) => {
    selectBrowserModel(model, readerDesktopModel, () => setReaderDesktopModel(null));
  }, [readerDesktopModel, selectBrowserModel]);

  const handleTextChange = useCallback((nextText: string) => {
    if (nextText === text) return;

    const hasActiveAudioState = tts.isGenerating
      || qwen3LocalRuntime.isGenerating
      || isRetakingSegment
      || player.segments.length > 0
      || player.totalDuration > 0;
    if (hasActiveAudioState) {
      cancelActiveGeneration(true);
      qwen3LocalRuntime.cancelActiveGeneration();
      resetGeneratedAudio();
      qwen3LocalRuntime.resetGeneratedAudio();
      if (isReaderPage && readerLibrary.activeDocument) {
        void readerLibrary.clearAudio(readerLibrary.activeDocument.id);
      }
    }

    setText(nextText);
    if (isReaderPage) readerLibrary.updateActiveText(nextText);
    setExportError(null);
    setImportError(null);
  }, [
    cancelActiveGeneration,
    isRetakingSegment,
    player.segments.length,
    player.totalDuration,
    qwen3LocalRuntime,
    isReaderPage,
    readerLibrary,
    resetGeneratedAudio,
    text,
    tts.isGenerating,
  ]);

  const documentsBridge = enableDesktopRuntimes && isElectronRuntime
    ? window.electron?.documents
    : undefined;

  // An import can take minutes (OCR); by then the click-time handleTextChange
  // closure is stale and would read audio/generation state from before the
  // import started, skipping the cancel-and-reset it exists to guarantee.
  // Always apply the result through the latest closure.
  const handleTextChangeRef = useRef(handleTextChange);
  useEffect(() => {
    handleTextChangeRef.current = handleTextChange;
  }, [handleTextChange]);
  const importInFlightRef = useRef(false);

  const handleImportDocument = useCallback(async () => {
    if (!documentsBridge || importInFlightRef.current) return;
    importInFlightRef.current = true;
    setImportError(null);
    setIsImportingDocument(true);
    try {
      const result = await documentsBridge.importDocument();
      if (!result.canceled) {
        if (result.epubBytes) {
          const document = parseEpubDocument(new Uint8Array(result.epubBytes), result.fileName);
          if (isReaderPage) {
            await readerLibrary.createDocument(document);
          } else {
            handleTextChangeRef.current(document.text);
          }
        } else if (isReaderPage) {
          await readerLibrary.createDocument({
            title: result.fileName.replace(/\.[^.]+$/, ""),
            description: result.pageCount ? `${result.pageCount} pages` : "",
            sourceType: "file",
            sourceName: result.fileName,
            text: result.text,
          });
        } else {
          handleTextChangeRef.current(result.text);
        }
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      // ipcRenderer.invoke wraps main-process errors in a remote-method prefix;
      // strip it so users see only the actionable message.
      setImportError(raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""));
    } finally {
      importInFlightRef.current = false;
      setIsImportingDocument(false);
    }
  }, [documentsBridge, isReaderPage, readerLibrary]);

  const handleImportReaderFile = useCallback(async (file: File) => {
    if (importInFlightRef.current) return;
    importInFlightRef.current = true;
    setImportError(null);
    setIsImportingDocument(true);
    try {
      const document = await importReaderFile(file);
      await readerLibrary.createDocument(document);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setImportError(message);
    } finally {
      importInFlightRef.current = false;
      setIsImportingDocument(false);
    }
  }, [readerLibrary]);

  const handleImportReaderUrl = useCallback(async (url: string) => {
    if (importInFlightRef.current) throw new Error("Another document import is still running.");
    importInFlightRef.current = true;
    setImportError(null);
    setIsImportingDocument(true);
    try {
      const payload = documentsBridge?.importUrl
        ? await documentsBridge.importUrl(url)
        : await fetchRemoteDocument(url);
      const document = parseHtmlReaderDocument(payload);
      await readerLibrary.createDocument(document);
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      if (!documentsBridge && /failed to fetch|networkerror|load failed/i.test(message)) {
        message = "This site blocks direct browser imports. Use the desktop app for cross-origin article URLs.";
      }
      setImportError(message);
      throw new Error(message);
    } finally {
      importInFlightRef.current = false;
      setIsImportingDocument(false);
    }
  }, [documentsBridge, readerLibrary]);

  const handleNewReaderDocument = useCallback(() => {
    void readerLibrary.createDocument({
      title: "Untitled document",
      sourceType: "text",
      text: "Start writing or paste text here.",
    });
  }, [readerLibrary]);

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
    if (!enableDesktopRuntimes) return;

    setVisitedLocalRuntimePages((prev) => {
      if (prev.has(page)) return prev;
      const next = new Set(prev);
      next.add(page);
      return next;
    });
  }, [enableDesktopRuntimes]);

  const handlePageNavigation = useCallback((page: AppPage) => {
    if (enableDesktopRuntimes && isLocalRuntimePage(activePage)) {
      rememberLocalRuntimePage(activePage);
    }
    if (enableDesktopRuntimes && isLocalRuntimePage(page)) {
      rememberLocalRuntimePage(page);
    }
    navigateToPage(page);
  }, [activePage, enableDesktopRuntimes, navigateToPage, rememberLocalRuntimePage]);

  const selectInlineDesktopModel = useCallback((
    page: InlineDesktopModelKey,
    currentDesktopModel: InlineDesktopModelKey | null,
    setDesktopModel: (model: InlineDesktopModelKey) => void,
  ) => {
    if (currentDesktopModel === page) return;
    cancelActiveGeneration();
    resetGeneratedAudio();
    qwen3LocalRuntime.resetGeneratedAudio();
    setDesktopModel(page);
    setExportError(null);
  }, [
    cancelActiveGeneration,
    qwen3LocalRuntime,
    resetGeneratedAudio,
  ]);

  const handleStudioDesktopModelSelect = useCallback((page: InlineDesktopModelKey) => {
    selectInlineDesktopModel(page, studioDesktopModel, setStudioDesktopModel);
  }, [selectInlineDesktopModel, studioDesktopModel]);

  const handleReaderDesktopModelSelect = useCallback((page: InlineDesktopModelKey) => {
    selectInlineDesktopModel(page, readerDesktopModel, setReaderDesktopModel);
  }, [readerDesktopModel, selectInlineDesktopModel]);

  const studioDesktopModelOptions = useMemo(() => (
    enableDesktopRuntimes && isElectronRuntime
      ? [{
          key: "qwen3",
          label: "Qwen3-TTS",
          badge: "Electron",
          detail: qwen3ProviderDetail,
          selected: studioDesktopModel === "qwen3",
          onSelect: () => handleStudioDesktopModelSelect("qwen3"),
        }]
      : []
  ), [enableDesktopRuntimes, handleStudioDesktopModelSelect, isElectronRuntime, qwen3ProviderDetail, studioDesktopModel]);

  const readerDesktopModelOptions = useMemo(() => (
    enableDesktopRuntimes && isElectronRuntime
      ? [{
          key: "qwen3",
          label: "Qwen3-TTS",
          badge: "Electron",
          detail: qwen3ProviderDetail,
          selected: readerDesktopModel === "qwen3",
          onSelect: () => handleReaderDesktopModelSelect("qwen3"),
        }]
      : []
  ), [enableDesktopRuntimes, handleReaderDesktopModelSelect, isElectronRuntime, qwen3ProviderDetail, readerDesktopModel]);

  const mountedLocalRuntimePages = useMemo(() => {
    if (!enableDesktopRuntimes) return [];

    const pages = new Set(visitedLocalRuntimePages);
    if (isLocalRuntimePage(activePage)) {
      pages.add(activePage);
    }
    return LOCAL_RUNTIME_PAGE_KEYS.filter((page) => pages.has(page));
  }, [activePage, enableDesktopRuntimes, visitedLocalRuntimePages]);

  const isUsingWasmFallback = currentModelState.ready && currentModelState.backend === "wasm";

  const handleJumpToSegment = useCallback((segmentId: string) => {
    if (!segmentId) return;
    player.jumpToSegment(segmentId);
    setShowPlayer(true);
  }, [player]);

  const handleGenerate = useCallback(() => {
    setExportError(null);
    if (isStudioUsingQwen3) {
      qwen3LocalRuntime.handleGenerate();
      return;
    }
    runBrowserGeneration();
  }, [isStudioUsingQwen3, qwen3LocalRuntime, runBrowserGeneration]);

  const handleStudioStop = useCallback(() => {
    if (isStudioUsingQwen3) {
      qwen3LocalRuntime.handleStop();
      return;
    }
    handleStop();
  }, [handleStop, isStudioUsingQwen3, qwen3LocalRuntime]);

  const handleStudioRetryLoad = useCallback(() => {
    if (isStudioUsingQwen3) {
      qwen3LocalRuntime.retryLoad();
      return;
    }
    handleRetryActiveModelLoad();
  }, [handleRetryActiveModelLoad, isStudioUsingQwen3, qwen3LocalRuntime]);

  const handleReaderGenerate = useCallback(() => {
    setExportError(null);
    if (isReaderUsingQwen3) {
      qwen3LocalRuntime.handleGenerate();
      return;
    }
    runBrowserGeneration();
  }, [isReaderUsingQwen3, qwen3LocalRuntime, runBrowserGeneration]);

  const handleReaderStop = useCallback(() => {
    if (isReaderUsingQwen3) {
      qwen3LocalRuntime.handleStop();
      return;
    }
    handleStop();
  }, [handleStop, isReaderUsingQwen3, qwen3LocalRuntime]);

  const handleReaderRetryLoad = useCallback(() => {
    if (isReaderUsingQwen3) {
      qwen3LocalRuntime.retryLoad();
      return;
    }
    handleRetryActiveModelLoad();
  }, [handleRetryActiveModelLoad, isReaderUsingQwen3, qwen3LocalRuntime]);

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
    && !isReaderUsingQwen3
    && ((webgpuStatus !== null && !webgpuStatus.available) || isUsingWasmFallback);
  const webgpuModeNote = showWasmBadge
    ? webgpuStatus?.message ?? null
    : null;
  const showSingleThreadedNote = showWasmBadge && !window.crossOriginIsolated;
  const activeModelSupportMessage = getUnsupportedModelMessage(activeModel, browserSupport);
  const studioModelState = isStudioUsingQwen3 ? qwen3LocalRuntime.modelState : currentModelState;
  const studioCanGenerate = isStudioUsingQwen3 ? qwen3LocalRuntime.canGenerate : canGenerate;
  const studioGenerationBusy = isStudioUsingQwen3 ? qwen3LocalRuntime.isGenerating : isGenerationBusy;
  const studioGenerationProgress = isStudioUsingQwen3 ? qwen3LocalRuntime.generationProgress : tts.generationProgress;
  const studioStats = isStudioUsingQwen3 ? qwen3LocalRuntime.stats : tts.stats;
  const studioVisibleError = isStudioUsingQwen3 ? qwen3LocalRuntime.error : (tts.error ?? retakeError);
  const readerModelState = isReaderUsingQwen3 ? qwen3LocalRuntime.modelState : currentModelState;
  const readerCanGenerate = isReaderUsingQwen3 ? qwen3LocalRuntime.canGenerate : canGenerate;
  const readerGenerationBusy = isReaderUsingQwen3 ? qwen3LocalRuntime.isGenerating : isGenerationBusy;
  const readerGenerationProgress = isReaderUsingQwen3 ? qwen3LocalRuntime.generationProgress : tts.generationProgress;
  const readerStats = isReaderUsingQwen3 ? qwen3LocalRuntime.stats : tts.stats;
  const readerVisibleError = isReaderUsingQwen3 ? qwen3LocalRuntime.error : (tts.error ?? retakeError);
  const visibleModelError = isReaderPage
    ? readerModelState.error
    : isStudioPage
    ? studioModelState.error
    : currentModelState.error;
  const visibleGenerationError = isReaderPage
    ? readerVisibleError
    : isStudioPage
    ? studioVisibleError
    : (tts.error ?? retakeError);
  const visibleError = visibleGenerationError ?? visibleModelError ?? importError ?? exportError ?? player.error;

  const lastReaderProgressUpdateRef = useRef(0);
  const readerAudioSaveTimerRef = useRef<number | null>(null);
  const activeReaderDocument = readerLibrary.activeDocument;
  const activeReaderDocumentId = activeReaderDocument?.id ?? null;
  const activeReaderDocumentRef = useRef(activeReaderDocument);
  activeReaderDocumentRef.current = activeReaderDocument;
  const loadReaderAudio = readerLibrary.loadAudio;
  const saveReaderAudio = readerLibrary.saveAudio;
  const updateReaderProgress = readerLibrary.updateProgress;
  const restoreReaderAudio = player.restoreAudioCache;
  const getReaderAudioSnapshot = player.getAudioCacheSnapshot;
  const readerAudioActionsRef = useRef({
    cancel: cancelActiveGeneration,
    load: loadReaderAudio,
    reset: resetGeneratedAudio,
    restore: restoreReaderAudio,
  });
  readerAudioActionsRef.current = {
    cancel: cancelActiveGeneration,
    load: loadReaderAudio,
    reset: resetGeneratedAudio,
    restore: restoreReaderAudio,
  };
  const activeReaderAudioSignature = activeReaderDocument
    ? buildAudioSignature({
        text: activeReaderDocument.text,
        model: isReaderUsingQwen3 ? "qwen3" : activeModel,
        voice: isReaderUsingQwen3 ? qwen3Settings.speaker : voice,
        quality,
        tuning: creator.generationSettings,
      })
    : null;
  const qwenReaderControlsRef = useRef({
    cancel: qwen3LocalRuntime.cancelActiveGeneration,
    reset: qwen3LocalRuntime.resetGeneratedAudio,
  });
  qwenReaderControlsRef.current = {
    cancel: qwen3LocalRuntime.cancelActiveGeneration,
    reset: qwen3LocalRuntime.resetGeneratedAudio,
  };
  const readerPlaybackSnapshotRef = useRef({
    currentTime: player.currentTime,
    playbackRate: player.playbackRate,
    totalDuration: player.totalDuration,
  });
  readerPlaybackSnapshotRef.current = {
    currentTime: player.currentTime,
    playbackRate: player.playbackRate,
    totalDuration: player.totalDuration,
  };

  useEffect(() => {
    const document = activeReaderDocumentRef.current;
    if (!isReaderPage || !document || document.id !== activeReaderDocumentId) return;
    let cancelled = false;

    readerAudioActionsRef.current.cancel(true);
    qwenReaderControlsRef.current.cancel();
    readerAudioActionsRef.current.reset();
    qwenReaderControlsRef.current.reset();
    setText(document.text);
    setExportError(null);
    setImportError(null);

    const restore = async () => {
      const cache = await readerAudioActionsRef.current.load(document.id);
      if (cancelled || !cache) return;
      if (!activeReaderAudioSignature || cache.signature !== activeReaderAudioSignature) return;
      readerAudioActionsRef.current.restore(cache.chunks, {
        currentTime: document.progress.positionSec || cache.currentTime,
        playbackRate: cache.playbackRate,
      });
      setShowPlayer(cache.chunks.length > 0);
    };
    void restore().catch((cause) => {
      if (!cancelled) setImportError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      cancelled = true;
    };
  }, [
    activeReaderDocumentId,
    activeReaderAudioSignature,
    isReaderPage,
  ]);

  useEffect(() => {
    if (!isReaderPage || !activeReaderDocument) return;
    const now = Date.now();
    const atEnd = player.totalDuration > 0 && player.currentTime >= player.totalDuration;
    if (atEnd && activeReaderDocument.progress.percent >= 99.999) return;
    if (!atEnd && now - lastReaderProgressUpdateRef.current < 750) return;
    lastReaderProgressUpdateRef.current = now;

    const segment = player.segments.find((entry) => entry.id === player.activeSegmentId);
    let textOffset = activeReaderDocument.progress.textOffset;
    if (segment && typeof segment.textStart === "number" && typeof segment.textEnd === "number") {
      const duration = Math.max(0.001, segment.endSec - segment.startSec);
      const ratio = Math.max(0, Math.min(1, (player.currentTime - segment.startSec) / duration));
      textOffset = segment.textStart + (segment.textEnd - segment.textStart) * ratio;
    } else if (atEnd) {
      textOffset = activeReaderDocument.text.length;
    }
    updateReaderProgress({
      positionSec: player.currentTime,
      totalDurationSec: player.totalDuration,
      textOffset,
    });
  }, [
    isReaderPage,
    player.activeSegmentId,
    player.currentTime,
    player.segments,
    player.totalDuration,
    activeReaderDocument,
    updateReaderProgress,
  ]);

  useEffect(() => {
    const documentId = activeReaderDocumentId;
    if (!isReaderPage || !documentId || player.segments.length === 0) return;
    if (readerAudioSaveTimerRef.current !== null) window.clearTimeout(readerAudioSaveTimerRef.current);
    readerAudioSaveTimerRef.current = window.setTimeout(() => {
      const chunks = getReaderAudioSnapshot();
      if (chunks.length === 0) return;
      const playback = readerPlaybackSnapshotRef.current;
      void saveReaderAudio({
        documentId,
        signature: buildAudioSignature({
          text,
          model: isReaderUsingQwen3 ? "qwen3" : activeModel,
          voice: isReaderUsingQwen3 ? qwen3Settings.speaker : voice,
          quality,
          tuning: creator.generationSettings,
        }),
        chunks,
        currentTime: playback.currentTime,
        playbackRate: playback.playbackRate,
        totalDuration: playback.totalDuration,
        updatedAt: Date.now(),
      }).catch((cause) => setImportError(cause instanceof Error ? cause.message : String(cause)));
    }, 800);
    return () => {
      if (readerAudioSaveTimerRef.current !== null) {
        window.clearTimeout(readerAudioSaveTimerRef.current);
        readerAudioSaveTimerRef.current = null;
      }
    };
  }, [
    activeModel,
    creator.generationSettings,
    isReaderPage,
    isReaderUsingQwen3,
    qwen3Settings.speaker,
    activeReaderDocumentId,
    getReaderAudioSnapshot,
    player.segments.length,
    quality,
    saveReaderAudio,
    text,
    voice,
  ]);
  const activeSegmentIndex = player.activeSegmentId
    ? player.segments.findIndex((segment) => segment.id === player.activeSegmentId)
    : -1;
  const activeSegmentNumber = activeSegmentIndex >= 0 ? activeSegmentIndex + 1 : null;
  const browserSupportPanel = browserSupport.message ? (
    <div className="rounded-[22px] border border-accent/20 bg-accent-light/50 backdrop-blur-xl shadow-glass-md">
      <div className="p-4 sm:p-6 md:p-8">
        <div className="inline-flex items-center rounded-full border border-accent/20 bg-panel/80 backdrop-blur-sm px-3 py-1 text-sm font-semibold uppercase tracking-[0.14em] text-accent shadow-glass-sm">
          iOS rollout
        </div>
        <h2 className="mt-4 text-2xl font-display font-bold tracking-tight text-text-primary sm:text-3xl">
          Open TTS runs on iPhone and iPad browsers with a limited set of models
        </h2>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-text-secondary">
          {browserSupport.message}
        </p>
      </div>
    </div>
  ) : null;

  return (
    <div className="min-h-screen font-sans text-text-primary">
      <div className={isReaderPage ? "w-full px-3 py-3 sm:px-4 sm:py-4 md:px-6 md:py-6" : "w-full px-4 py-6 sm:px-6 sm:py-8 md:px-8 md:py-10"}>

        {/* Header */}
        <header className={isReaderPage ? "mb-4" : "mb-8 sm:mb-10"}>
          <div className={`flex justify-between gap-4 flex-wrap ${isReaderPage ? "items-center" : "items-start"}`}>
            <div>
              <h1
                className={`${isReaderPage ? "text-3xl sm:text-4xl" : "text-5xl sm:text-6xl"} font-display leading-none font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-br from-text-primary to-accent/70`}
              >
                Open TTS
              </h1>
              {!isReaderPage && (
                <p className="mt-3 text-base font-medium tracking-wide text-text-secondary sm:text-lg">
                  Text to speech, entirely on your device.
                </p>
              )}
            </div>

            {showWasmBadge && (
              <div className="mt-1 flex flex-col items-end gap-1 flex-shrink-0">
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-accent/25 bg-accent-light backdrop-blur-md text-accent text-base font-semibold shadow-glass-sm">
                  <span className="w-1.5 h-1.5 rounded-full bg-accent shadow-[0_0_8px_var(--color-accent)] animate-pulse" />
                  CPU mode
                </div>
                {webgpuModeNote && (
                  <p className="max-w-full text-left text-sm leading-4 text-text-muted sm:max-w-[240px] sm:text-right">
                    {webgpuModeNote}
                  </p>
                )}
                {showSingleThreadedNote && (
                  <p className="max-w-full text-left text-sm leading-4 text-text-muted sm:max-w-[220px] sm:text-right">
                    Cross-origin isolation is off, so CPU mode runs single-threaded.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Page navigation */}
          <nav className={`${isReaderPage ? "mt-4" : "mt-6 sm:mt-8"} grid w-full grid-cols-2 gap-1 rounded-2xl glass p-1 sm:inline-flex sm:w-auto`}>
            {availableTabs.map((tab) => (
              <a
                key={tab.key}
                href={getPagePath(tab.key, routeBasePath)}
                onClick={(event) => {
                  event.preventDefault();
                  handlePageNavigation(tab.key);
                }}
                className={`relative px-5 py-2 text-base font-semibold transition-all duration-200 rounded-xl ${
                  activePage === tab.key
                    ? "bg-panel text-text-primary shadow-glass-sm"
                    : "text-text-muted hover:text-text-secondary hover:bg-white/50"
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
          <div className="mb-4 rounded-xl border border-danger/30 bg-danger-light backdrop-blur-md px-3.5 py-2.5 text-xs text-danger shadow-glass-sm">
            {visibleError}
          </div>
        )}

        {/* Studio page */}
        {isStudioPage ? (
          localInferenceSupported ? (
            <>
            <DownloadProgress kokoroState={kokoroState} supertonicState={supertonicState} />

            <div className="mt-6 glass-panel rounded-[24px]">
              <div className="grid grid-cols-1 lg:grid-cols-5">
                {/* Left: text input */}
                <div className="flex min-h-[320px] flex-col border-border/40 p-4 sm:min-h-[360px] sm:p-6 lg:col-span-3 lg:border-r">
                  <span className="text-xs font-semibold uppercase tracking-widest text-text-muted mb-3 flex-shrink-0">Script</span>
                  <div className="flex-1 min-h-0">
                    <TextInput
                      text={text}
                      onTextChange={handleTextChange}
                      onImportDocument={documentsBridge ? handleImportDocument : undefined}
                      isImportingDocument={isImportingDocument}
                    />
                  </div>
                </div>

                {/* Right: controls */}
                <div className="flex flex-col gap-5 border-t border-border/40 p-4 sm:gap-6 sm:p-6 lg:col-span-2 lg:border-t-0">
                  <ModelToggle
                    activeModel={activeModel}
                    onModelChange={handleStudioModelChange}
                    desktopModelOptions={studioDesktopModelOptions}
                    kokoroState={kokoroState}
                    supertonicState={supertonicState}
                    unavailableModels={unavailableModels}
                  />

                  {isStudioUsingQwen3 && (
                    <Qwen3InlineSettings onOpenSetup={() => handlePageNavigation("qwen3")} />
                  )}

                  {!isStudioUsingQwen3 && (
                    <VoiceSelector
                      activeModel={activeModel}
                      voice={voice}
                      onVoiceChange={handleVoiceChange}
                      kokoroVoices={kokoroVoices}
                    />
                  )}

                  <ControlsProvider
                    value={{
                      activeModel: isStudioUsingQwen3 ? "kokoro" : activeModel,
                      quality,
                      onQualityChange: handleQualityChange,
                      onGenerate: handleGenerate,
                      onRetryLoad: handleStudioRetryLoad,
                      onStop: handleStudioStop,
                      isGenerating: studioGenerationBusy,
                      canGenerate: studioCanGenerate,
                      modelReady: studioModelState.ready,
                      modelError: studioModelState.error,
                      loadingProgress: studioModelState.downloadProgress,
                      generationProgress: studioGenerationProgress,
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
                    stats={studioStats}
                    isGenerating={studioGenerationBusy}
                    onTogglePlay={player.togglePlay}
                    onSeek={player.seek}
                    onSkipBackward={() => player.skip(-10)}
                    onSkipForward={() => player.skip(10)}
                    onDownload={handleDownloadAudio}
                    onStop={handleStudioStop}
                  />
                </div>
              )}
            </div>

            {!isStudioUsingQwen3 && (
              <div className="mt-4">
                <SettingsPanel
                  activeModel={activeModel}
                  busy={cacheBusy || currentModelState.loading}
                  status={cacheStatus}
                  onClearCache={handleClearCache}
                  onRedownloadActive={handleRedownloadActiveModel}
                />
              </div>
            )}

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
              onImportDocument={documentsBridge ? handleImportDocument : undefined}
              onImportFile={handleImportReaderFile}
              onImportUrl={handleImportReaderUrl}
              isImportingDocument={isImportingDocument}
              documents={readerLibrary.documents}
              activeDocument={activeReaderDocument}
              libraryLoading={readerLibrary.loading}
              libraryError={readerLibrary.error}
              libraryPersistent={readerLibrary.persistent}
              onNewDocument={handleNewReaderDocument}
              onOpenDocument={(id) => {
                void readerLibrary.openDocument(id).catch((cause) => (
                  setImportError(cause instanceof Error ? cause.message : String(cause))
                ));
              }}
              onDeleteDocument={(id) => {
                void readerLibrary.deleteDocument(id).catch((cause) => (
                  setImportError(cause instanceof Error ? cause.message : String(cause))
                ));
              }}
              onUpdateDocumentMetadata={readerLibrary.updateActiveMetadata}
              onAddBookmark={readerLibrary.addBookmark}
              onRemoveBookmark={readerLibrary.removeBookmark}
              onAddNote={readerLibrary.addNote}
              onUpdateNote={readerLibrary.updateNote}
              onRemoveNote={readerLibrary.removeNote}
              activeModel={activeModel}
              onModelChange={handleReaderModelChange}
              desktopModelOptions={readerDesktopModelOptions}
              desktopVoiceLabel={isReaderUsingQwen3 ? qwen3Settings.speaker.replace(/_/g, " ") : undefined}
              desktopModelSettings={isReaderUsingQwen3 ? (
                <Qwen3InlineSettings onOpenSetup={() => handlePageNavigation("qwen3")} />
              ) : undefined}
              kokoroState={kokoroState}
              supertonicState={supertonicState}
              unavailableModels={unavailableModels}
              kokoroVoices={kokoroVoices}
              voice={voice}
              onVoiceChange={handleVoiceChange}
              quality={quality}
              onQualityChange={handleQualityChange}
              canGenerate={readerCanGenerate}
              modelReady={readerModelState.ready}
              modelError={readerModelState.error}
              loadingProgress={readerModelState.downloadProgress}
              generationProgress={readerGenerationProgress}
              isGenerating={readerGenerationBusy}
              onGenerate={handleReaderGenerate}
              onRetryLoad={handleReaderRetryLoad}
              onStop={handleReaderStop}
              stats={readerStats}
              isPlaying={player.isPlaying}
              currentTime={player.currentTime}
              totalDuration={player.totalDuration}
              playbackRate={player.playbackRate}
              onPlaybackRateChange={player.setPlaybackRate}
              segments={player.segments}
              activeSegmentId={player.activeSegmentId}
              onTogglePlay={player.togglePlay}
              onSeek={player.seek}
              onSkipBackward={() => player.skip(-10)}
              onSkipForward={() => player.skip(10)}
              onDownload={handleDownloadAudio}
              isRetaking={isReaderUsingQwen3 ? false : isRetakingSegment}
              onRetakeSegment={handleRetakeSegment}
              canRetakeSegments={!isReaderUsingQwen3}
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
                initialText={text}
              />
            </section>
          );
        })}

        {/* Footer */}
        {!isReaderPage && (
          <footer className="mt-16 border-t border-border/40 pt-5">
            {isStudioPage && localInferenceSupported && !browserSupport.message ? (
              <div className="flex items-center flex-wrap gap-1.5">
                {(["Kokoro", "Supertonic", "WebGPU · CPU"] as const).map((label) => (
                  <span
                    key={label}
                    className="px-2.5 py-1 rounded-full border border-white/50 bg-white/40 backdrop-blur-sm font-mono text-xs text-text-muted/70"
                  >
                    {label}
                  </span>
                ))}
                <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-success/25 bg-success/[0.07] backdrop-blur-sm font-mono text-xs text-success/80">
                  <span
                    className="w-1 h-1 rounded-full bg-success opacity-80 animate-pulse"
                    style={{ boxShadow: "0 0 5px var(--color-success)" }}
                  />
                  all local
                </span>
              </div>
            ) : (
              <p className="font-mono text-xs text-text-muted/60">
                {isStudioPage
                  ? activeModelSupportMessage
                    ?? browserSupport.message
                    ?? "More local models as compatible runtimes land."
                  : "More local models as compatible runtimes land."}
              </p>
            )}
          </footer>
        )}

      </div>
    </div>
  );
}

export function SynthesisApp(props: SynthesisAppProps) {
  return (
    <Qwen3RuntimeProvider>
      <SynthesisAppContent {...props} />
    </Qwen3RuntimeProvider>
  );
}

export default SynthesisApp;
