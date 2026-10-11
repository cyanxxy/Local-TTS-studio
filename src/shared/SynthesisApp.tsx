import {
  lazy,
  Suspense,
  useState,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
} from "react";
import type { ChunkPauseKind, ModelType } from "../types";
import { MIN_TEXT_LENGTH } from "../constants";
import { useModelLoader } from "../hooks/useModelLoader";
import { useAudioPlayer } from "../hooks/useAudioPlayer";
import { useTTS } from "../hooks/useTTS";
import { useAppRouting } from "../hooks/useAppRouting";
import { useAppPreferences } from "../hooks/useAppPreferences";
import { useCreatorSettings } from "../hooks/useCreatorSettings";
import { useGenerationControl } from "../hooks/useGenerationControl";
import { useModelCacheControls } from "../hooks/useModelCacheControls";
import { useQwen3LocalRuntime } from "../hooks/useQwen3LocalRuntime";
import { useSupertonic3Runtime } from "../hooks/useSupertonic3Runtime";
import { useAudio8Runtime } from "../hooks/useAudio8Runtime";
import { Qwen3RuntimeProvider, useQwen3Runtime } from "../contexts/Qwen3RuntimeContext";
import { Qwen3InlineSettings } from "../components/Qwen3InlineSettings";
import { Supertonic3InlineSettings } from "../components/Supertonic3InlineSettings";
import { Audio8InlineSettings } from "../components/Audio8InlineSettings";
import { useReaderLibrary } from "../hooks/useReaderLibrary";
import { useReaderSections } from "../hooks/useReaderSections";
import { useReaderViewPreferences } from "../hooks/useReaderViewPreferences";
import { AppFooter } from "../components/AppFooter";
import { AppHeader } from "../components/AppHeader";
import { BrowserSupportPanel } from "../components/BrowserSupportPanel";
import { ErrorBanner } from "../components/ErrorBanner";
import { TextInput } from "../components/TextInput";
import { ModelToggle } from "../components/ModelToggle";
import { VoiceSelector } from "../components/VoiceSelector";
import { Controls } from "../components/Controls";
import { ControlsProvider } from "../components/ControlsContext";
import { AudioPlayer } from "../components/AudioPlayer";
import { DownloadProgress } from "../components/DownloadProgress";
import { SettingsPanel } from "../components/SettingsPanel";
import { SupertonicLanguageSettings } from "../components/SupertonicLanguageSettings";
import { CreatorToolsPanel, type CreatorEngineSupport } from "../components/CreatorToolsPanel";
import { isSetupPage, type AppPage } from "../lib/appRouting";
import {
  getDefaultSupportedModel,
  getLocalBrowserSupport,
  getUnsupportedModelMessage,
  isModelSupportedInBrowser,
} from "../lib/browserSupport";
import { getWebGPUStatus, type WebGPUStatus } from "../lib/webgpu";
import {
  hasPrimaryShortcutModifier,
  isEditableShortcutTarget,
} from "../lib/appShortcuts";
import {
  getInitialAppState,
  getInitialCreatorState,
  getInitialEngineSettings,
  persistAppState,
  persistCreatorState,
  persistEngineSettings,
  type PersistedAppState,
} from "../lib/appState";
import { resolveKokoroVoice } from "../lib/voices";
import { hasMinimumSynthesisText } from "../lib/textValidation";
import {
  buildAudioSignature,
  createReaderAudioCacheKey,
  getCachedReaderAudioByteLength,
  normalizeReaderTextFragment,
  readerSectionAtOffset,
  unwrapHardLineBreaks,
} from "../lib/readerDocument";
import { isReaderLibraryShutdownError } from "../lib/readerLibrary";
import {
  ENGINES,
  getEngine,
  surfaceEngineSignatureParts,
  surfaceEngineVoiceLabel,
  type DesktopInlineEngineId,
  type EngineSettings,
  type SurfaceEngineId,
  type SurfaceEngineSettings,
} from "../models/registry";
import { describeDesktopModelOptions } from "./desktopModelOptions";
import type { RuntimeControls, SurfaceRuntime } from "./engineRuntime";

interface SynthesisAppProps {
  enableDesktopRuntimes: boolean;
  routeBasePath?: string;
  createSupertonic3Worker?: () => Worker;
}

// Split out of the entry chunk: the Reader and the per-model local-runtime
// pages are each a large subtree that most sessions never open, and the app
// settings dialog is only mounted once the user asks for it. Studio — the
// landing surface — stays in the entry chunk so it never waits on a fetch.
const AdvancedReaderPage = lazy(() => import("../components/AdvancedReaderPage")
  .then((module) => ({ default: module.AdvancedReaderPage })));
const LocalRuntimePage = lazy(() => import("../components/LocalRuntimePage")
  .then((module) => ({ default: module.LocalRuntimePage })));
const AppSettingsDialog = lazy(() => import("../components/AppSettingsDialog")
  .then((module) => ({ default: module.AppSettingsDialog })));

// Document import pulls in Readability and a zip reader — roughly a tenth of the
// entry chunk — but is only ever reached from a user-initiated import, which is
// already asynchronous. Load it on demand instead of at startup.
const loadReaderImport = () => import("../lib/readerImport");

/** How often the Reader samples playback position to persist reading progress. */
const READER_PROGRESS_SAMPLE_MS = 750;

/**
 * The engines whose settings Studio owns and persists. Qwen3's settings live
 * in `Qwen3RuntimeProvider`, which persists them itself.
 */
type AppEngineId = Exclude<SurfaceEngineId, "qwen3">;
type AppEngineSettings = { [Id in AppEngineId]: EngineSettings<Id> };

function SynthesisAppContent({ enableDesktopRuntimes, routeBasePath = "", createSupertonic3Worker }: SynthesisAppProps) {
  const isElectronRuntime = Boolean(window.electron?.isElectron);
  // Every desktop-only runtime needs both halves: the entry point that opts in
  // and a live preload bridge. Studio previously gated Audio8 on the bridge
  // alone, so the two surfaces could disagree about which models exist.
  const desktopRuntimesAvailable = enableDesktopRuntimes && isElectronRuntime;
  const { preferences, updatePreferences, resetPreferences } = useAppPreferences();
  const [appSettingsOpen, setAppSettingsOpen] = useState(false);
  // Reader focus layout: hides the app header and page tabs for reading.
  const [readerImmersive, setReaderImmersive] = useState(false);
  const qwen3Settings = useQwen3Runtime();
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
  // The desktop entry owns this capability by supplying the worker factory.
  // Do not also gate it on the preload bridge: Supertonic 3 runs entirely in
  // the renderer worker, and a delayed/stale preload must not hide the model.
  const supertonic3Available = enableDesktopRuntimes
    && typeof createSupertonic3Worker === "function";
  const desktopEngineAvailability = useMemo<Record<DesktopInlineEngineId, boolean>>(() => ({
    audio8: desktopRuntimesAvailable,
    supertonic3: supertonic3Available,
    qwen3: qwen3Settings.available,
  }), [desktopRuntimesAvailable, qwen3Settings.available, supertonic3Available]);
  const initialCreatorState = useMemo(() => getInitialCreatorState(), []);
  const browserSupport = useMemo(
    () => getLocalBrowserSupport(typeof navigator === "undefined" ? undefined : navigator, isElectronRuntime),
    [isElectronRuntime],
  );
  const localInferenceSupported = browserSupport.isSupported;
  const unavailableModels = browserSupport.unsupportedModelMessages;
  const { activePage, availableTabs: routeTabs, isReaderPage, isStudioPage, navigateToPage } = useAppRouting(
    enableDesktopRuntimes,
    routeBasePath,
  );
  const availableTabs = useMemo(() => routeTabs.filter((tab) => {
    if (tab.key === "neutts") return preferences.showNeuTTS;
    if (tab.key === "qwen3") return preferences.showQwen3TTS && qwen3Settings.available;
    return true;
  }), [preferences.showNeuTTS, preferences.showQwen3TTS, qwen3Settings.available, routeTabs]);

  const [text, setText] = useState(initialState.text);
  const [activeModel, setActiveModel] = useState<ModelType>(() => (
    isModelSupportedInBrowser(initialState.model, browserSupport)
      ? initialState.model
      : getDefaultSupportedModel(browserSupport)
  ));
  const [engineSettings, setEngineSettings] = useState<AppEngineSettings>(() => {
    const { kokoro, supertonic, audio8, supertonic3 } = getInitialEngineSettings();
    return { kokoro, supertonic, audio8, supertonic3 };
  });
  const [quality, setQuality] = useState(initialState.quality);
  const [showPlayer, setShowPlayer] = useState(false);
  const [webgpuStatus, setWebgpuStatus] = useState<WebGPUStatus | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [isImportingDocument, setIsImportingDocument] = useState(false);
  // The desktop engine each surface last chose, persisted across launches. A
  // surface uses it only while that engine is available and otherwise runs the
  // browser model, without forgetting the choice for when it returns.
  const [chosenStudioDesktopModel, setStudioDesktopModel] = useState(initialState.desktopModels.studio);
  const [chosenReaderDesktopModel, setReaderDesktopModel] = useState(initialState.desktopModels.reader);
  const studioDesktopModel = chosenStudioDesktopModel && desktopEngineAvailability[chosenStudioDesktopModel]
    ? chosenStudioDesktopModel
    : null;
  const readerDesktopModel = chosenReaderDesktopModel && desktopEngineAvailability[chosenReaderDesktopModel]
    ? chosenReaderDesktopModel
    : null;
  const { voice: audio8Voice } = engineSettings.audio8;
  const { voice: supertonic3Voice, language: supertonic3Language } = engineSettings.supertonic3;
  const { voice: supertonicVoice, language: supertonicLanguage } = engineSettings.supertonic;
  const readerLibrary = useReaderLibrary(initialState.text);
  // Quitting holds the window open while the Reader worker drains, so a cache
  // write that loses that race is expected and must not surface as an error.
  const reportReaderError = useCallback((cause: unknown) => {
    if (isReaderLibraryShutdownError(cause)) return;
    setImportError(cause instanceof Error ? cause.message : String(cause));
  }, []);
  const {
    preferences: readerViewPreferences,
    updatePreferences: updateReaderViewPreferences,
  } = useReaderViewPreferences();
  const activeReaderDocument = readerLibrary.activeDocument;
  const activeReaderDocumentId = activeReaderDocument?.id ?? null;
  const {
    sections: readerSections,
    activeSection: activeReaderSection,
    activeSectionIndex: activeReaderSectionIndex,
    activeChapter: activeReaderChapter,
    previousSection: previousReaderSection,
    nextSection: nextReaderSection,
    activeSectionText: activeReaderSectionText,
  } = useReaderSections(activeReaderDocument);
  const activeReaderSectionRef = useRef(activeReaderSection);
  activeReaderSectionRef.current = activeReaderSection;
  const readerSectionEditRef = useRef<{
    documentId: string;
    sectionId: string;
    documentText: string;
    start: number;
    end: number;
  } | null>(null);
  const readerAudioClearedForEditRef = useRef<string | null>(null);
  useEffect(() => {
    readerAudioClearedForEditRef.current = null;
  }, [activeReaderDocumentId, activeReaderSection?.id]);
  const synthesisText = isReaderPage && activeReaderSection
    ? activeReaderSectionText
    : text;
  const readerContinuationRef = useRef<{
    sectionId: string;
    autoPlay: boolean;
    autoGenerate: boolean;
  } | null>(null);
  const readerRestoreRequestRef = useRef<{
    sectionId: string;
    currentTime?: number;
  } | null>(null);
  const flushReaderAudioRef = useRef<() => void>(() => undefined);

  const openAppSettings = useCallback(() => setAppSettingsOpen(true), []);
  const closeAppSettings = useCallback(() => setAppSettingsOpen(false), []);

  useEffect(() => {
    if (activePage === "neutts" && !preferences.showNeuTTS) {
      navigateToPage("studio");
    }
  }, [activePage, navigateToPage, preferences.showNeuTTS]);

  useEffect(() => {
    if (activePage === "qwen3" && !qwen3Settings.available) navigateToPage("studio");
  }, [activePage, navigateToPage, qwen3Settings.available]);

  const isReaderUsingQwen3 = isReaderPage && readerDesktopModel === "qwen3";
  const isStudioUsingQwen3 = isStudioPage && studioDesktopModel === "qwen3";
  const isReaderUsingSupertonic3 = isReaderPage && readerDesktopModel === "supertonic3";
  const isStudioUsingSupertonic3 = isStudioPage && studioDesktopModel === "supertonic3";
  const isReaderUsingAudio8 = isReaderPage && readerDesktopModel === "audio8";
  const isStudioUsingAudio8 = isStudioPage && studioDesktopModel === "audio8";
  const isUsingQwen3Inline = isReaderUsingQwen3 || isStudioUsingQwen3;
  const isUsingSupertonic3Inline = isReaderUsingSupertonic3 || isStudioUsingSupertonic3;
  const isUsingAudio8Inline = isReaderUsingAudio8 || isStudioUsingAudio8;
  const studioEngineId: SurfaceEngineId = studioDesktopModel ?? activeModel;
  const readerEngineId: SurfaceEngineId = readerDesktopModel ?? activeModel;
  // The engine whose audio the visible surface plays and saves.
  const visibleEngineId: SurfaceEngineId = isReaderPage ? readerEngineId : studioEngineId;

  const {
    kokoroState,
    supertonicState,
    kokoroWorker,
    supertonicWorker,
    kokoroVoices,
    hardRestartModel,
    loadModel,
    reloadModel,
  } = useModelLoader(activeModel, {
    enabled: localInferenceSupported && !isUsingQwen3Inline && !isUsingSupertonic3Inline && !isUsingAudio8Inline,
    preferredSupertonicVoice: supertonicVoice,
    debugProfiling,
    supportedModels: browserSupport.supportedModels,
  });

  const player = useAudioPlayer();
  // The player object changes identity with its state; its functions never do.
  // Callbacks below depend on the functions so they stay stable while streaming.
  const {
    download: downloadPlayerAudio,
    downloadCaptions: downloadPlayerCaptions,
    getAudioCacheSnapshot: getReaderAudioSnapshot,
    getCurrentTime,
    getPlaybackSnapshot,
    jumpToSegment,
    restoreAudioCache: restoreReaderAudio,
    scheduleChunk,
    skip: skipPlayback,
    togglePlay,
  } = player;
  const qwen3LocalRuntime = useQwen3LocalRuntime({
    enabled: desktopRuntimesAvailable && qwen3Settings.available && isUsingQwen3Inline,
    text: synthesisText,
    allowLongText: isUsingQwen3Inline,
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
      void scheduleChunk({
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
    [scheduleChunk],
  );

  const endStream = player.endStream;
  const onComplete = useCallback(() => endStream({ completed: true }), [endStream]);

  const tts = useTTS({ kokoroWorker, supertonicWorker, onAudioChunk, onComplete });
  const currentModelState = activeModel === "kokoro" ? kokoroState : supertonicState;
  const activeModelSupported = isModelSupportedInBrowser(activeModel, browserSupport);
  const canGenerate = localInferenceSupported
    && activeModelSupported
    && hasMinimumSynthesisText(synthesisText, MIN_TEXT_LENGTH)
    && currentModelState.ready;

  const creator = useCreatorSettings({
    initialState: initialCreatorState,
    quality,
    language: supertonicLanguage,
  });
  const supertonic3Runtime = useSupertonic3Runtime({
    available: supertonic3Available,
    active: isUsingSupertonic3Inline,
    createWorker: createSupertonic3Worker,
    text: synthesisText,
    voice: supertonic3Voice,
    language: supertonic3Language,
    generationSettings: creator.generationSettings,
    player,
    setShowPlayer,
  });
  const audio8Runtime = useAudio8Runtime({
    active: isUsingAudio8Inline,
    text: synthesisText,
    voice: audio8Voice,
    generationSettings: creator.generationSettings,
    player,
    setShowPlayer,
  });

  const savedKokoroVoice = engineSettings.kokoro.voice;
  const kokoroVoice = useMemo(() => {
    if (kokoroVoices.length === 0) return savedKokoroVoice;
    return resolveKokoroVoice(savedKokoroVoice, kokoroVoices) ?? savedKokoroVoice;
  }, [kokoroVoices, savedKokoroVoice]);
  const voice = activeModel === "kokoro" ? kokoroVoice : supertonicVoice;
  // What every engine a surface can select reads right now, keyed by engine.
  // Picker rows, voice labels and Reader cache signatures all derive from it.
  const surfaceEngineSettings = useMemo<SurfaceEngineSettings>(() => ({
    kokoro: { voice: kokoroVoice },
    supertonic: { voice: supertonicVoice, language: supertonicLanguage },
    audio8: { voice: audio8Voice },
    supertonic3: { voice: supertonic3Voice, language: supertonic3Language },
    qwen3: qwen3Settings,
  }), [
    audio8Voice,
    kokoroVoice,
    qwen3Settings,
    supertonic3Language,
    supertonic3Voice,
    supertonicLanguage,
    supertonicVoice,
  ]);
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
    hardRestartModel,
    kokoroWorker,
    supertonicWorker,
    player,
    setShowPlayer,
    text: synthesisText,
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

  const {
    cancelActiveGeneration: cancelAudio8Generation,
    resetGeneratedAudio: resetAudio8Audio,
  } = audio8Runtime;
  const {
    cancelActiveGeneration: cancelSupertonic3Generation,
    resetGeneratedAudio: resetSupertonic3Audio,
  } = supertonic3Runtime;
  const {
    cancelActiveGeneration: cancelQwen3Generation,
    resetGeneratedAudio: resetQwen3Audio,
  } = qwen3LocalRuntime;
  // How to stop each engine's generation and clear what it put in the shared
  // player. Kokoro and Supertonic 2 share the browser path.
  const engineRuntimeControls = useMemo<Readonly<Record<SurfaceEngineId, RuntimeControls>>>(() => {
    const browser: RuntimeControls = {
      // Unforced: only a running browser generation restarts its worker.
      cancel: () => cancelActiveGeneration(),
      reset: resetGeneratedAudio,
    };
    return {
      kokoro: browser,
      supertonic: browser,
      audio8: { cancel: cancelAudio8Generation, reset: resetAudio8Audio },
      supertonic3: { cancel: cancelSupertonic3Generation, reset: resetSupertonic3Audio },
      qwen3: { cancel: cancelQwen3Generation, reset: resetQwen3Audio },
    };
  }, [
    cancelActiveGeneration,
    cancelAudio8Generation,
    cancelQwen3Generation,
    cancelSupertonic3Generation,
    resetAudio8Audio,
    resetGeneratedAudio,
    resetQwen3Audio,
    resetSupertonic3Audio,
  ]);
  // A model switch or a text edit retires every runtime's audio, each once.
  const cancelAllRuntimes = useCallback(() => {
    for (const controls of new Set(Object.values(engineRuntimeControls))) controls.cancel();
  }, [engineRuntimeControls]);
  const resetAllRuntimes = useCallback(() => {
    for (const controls of new Set(Object.values(engineRuntimeControls))) controls.reset();
  }, [engineRuntimeControls]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const persisted: PersistedAppState = {
        model: activeModel,
        text,
        quality,
        desktopModels: { studio: chosenStudioDesktopModel, reader: chosenReaderDesktopModel },
      };
      persistAppState(persisted);
      persistEngineSettings(engineSettings);
    }, 200);

    return () => window.clearTimeout(timeoutId);
  }, [activeModel, chosenReaderDesktopModel, chosenStudioDesktopModel, engineSettings, quality, text]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      persistCreatorState(creator.persistedState);
    }, 200);

    return () => window.clearTimeout(timeoutId);
  }, [creator.persistedState]);

  const selectBrowserModel = useCallback((
    model: ModelType,
    currentDesktopModel: DesktopInlineEngineId | null,
    clearDesktopModel: () => void,
  ) => {
    if (!isModelSupportedInBrowser(model, browserSupport)) return;
    if (model === activeModel && currentDesktopModel === null) return;
    cancelAllRuntimes();
    resetAllRuntimes();
    clearDesktopModel();
    if (model !== activeModel) {
      setActiveModel(model);
      loadModel(model);
    }
    setExportError(null);
  }, [
    activeModel,
    browserSupport,
    cancelAllRuntimes,
    loadModel,
    resetAllRuntimes,
  ]);

  const handleStudioModelChange = useCallback((model: ModelType) => {
    selectBrowserModel(model, studioDesktopModel, () => setStudioDesktopModel(null));
  }, [selectBrowserModel, studioDesktopModel]);

  const handleReaderModelChange = useCallback((model: ModelType) => {
    flushReaderAudioRef.current();
    selectBrowserModel(model, readerDesktopModel, () => setReaderDesktopModel(null));
  }, [readerDesktopModel, selectBrowserModel]);

  const resetAudioForTextEdit = useCallback(() => {
    const hasActiveAudioState = tts.isGenerating
      || audio8Runtime.isGenerating
      || qwen3LocalRuntime.isGenerating
      || supertonic3Runtime.isGenerating
      || isRetakingSegment
      || player.segments.length > 0
      || player.totalDuration > 0;
    if (hasActiveAudioState) {
      // Unforced: finished audio only needs clearing, and a forced cancel
      // would reload the model on the first keystroke after listening.
      cancelAllRuntimes();
      resetAllRuntimes();
    }
  }, [
    audio8Runtime.isGenerating,
    cancelAllRuntimes,
    isRetakingSegment,
    player.segments.length,
    player.totalDuration,
    qwen3LocalRuntime.isGenerating,
    resetAllRuntimes,
    supertonic3Runtime.isGenerating,
    tts.isGenerating,
  ]);

  const handleTextChange = useCallback((nextText: string) => {
    if (nextText === text) return;

    resetAudioForTextEdit();
    setText(nextText);
    setExportError(null);
    setImportError(null);
  }, [
    resetAudioForTextEdit,
    text,
  ]);

  const handleReaderSectionEditStart = useCallback(() => {
    if (!activeReaderDocument || !activeReaderSection) return;
    readerSectionEditRef.current = {
      documentId: activeReaderDocument.id,
      sectionId: activeReaderSection.id,
      documentText: activeReaderDocument.text,
      start: activeReaderSection.start,
      end: activeReaderSection.end,
    };
  }, [activeReaderDocument, activeReaderSection]);

  const handleReaderSectionTextChange = useCallback((nextSectionText: string) => {
    const edit = readerSectionEditRef.current;
    if (!activeReaderDocument || (!edit && !activeReaderSection)) return;
    if (edit && edit.documentId !== activeReaderDocument.id) return;
    const sourceText = edit?.documentText ?? activeReaderDocument.text;
    const start = edit?.start ?? activeReaderSection!.start;
    const end = edit?.end ?? activeReaderSection!.end;
    const normalizedSectionText = normalizeReaderTextFragment(nextSectionText);
    const nextDocumentText = `${sourceText.slice(0, start)}${normalizedSectionText}${sourceText.slice(end)}`;
    if (nextDocumentText === activeReaderDocument.text) return;
    resetAudioForTextEdit();
    const editedSectionId = edit?.sectionId ?? activeReaderSection!.id;
    const cacheKey = createReaderAudioCacheKey(activeReaderDocument.id, editedSectionId);
    if (readerAudioClearedForEditRef.current !== cacheKey) {
      readerAudioClearedForEditRef.current = cacheKey;
      void readerLibrary.clearAudio(activeReaderDocument.id, editedSectionId);
    }
    readerLibrary.updateActiveText(nextDocumentText, {
      preserveText: true,
      deferStructure: edit !== null,
    });
    setExportError(null);
    setImportError(null);
  }, [activeReaderDocument, activeReaderSection, readerLibrary, resetAudioForTextEdit]);

  const handleReaderSectionEditEnd = useCallback(() => {
    const edit = readerSectionEditRef.current;
    readerSectionEditRef.current = null;
    if (edit) readerLibrary.finalizeActiveTextEdit(edit.documentId);
  }, [readerLibrary]);

  const finalizeActiveReaderTextEdit = readerLibrary.finalizeActiveTextEdit;
  useEffect(() => () => {
    const edit = readerSectionEditRef.current;
    if (!edit || edit.documentId !== activeReaderDocumentId) return;
    readerSectionEditRef.current = null;
    finalizeActiveReaderTextEdit(edit.documentId);
  }, [activeReaderDocumentId, finalizeActiveReaderTextEdit]);

  const documentsBridge = desktopRuntimesAvailable
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
          const { parseEpubDocument } = await loadReaderImport();
          const document = parseEpubDocument(new Uint8Array(result.epubBytes), result.fileName);
          if (isReaderPage) {
            await readerLibrary.createDocument(document);
          } else {
            handleTextChangeRef.current(document.text);
          }
        } else if (isReaderPage && /\.md$/i.test(result.fileName)) {
          const { parseMarkdownReaderDocument } = await loadReaderImport();
          await readerLibrary.createDocument(parseMarkdownReaderDocument(result.text, result.fileName));
        } else {
          // PDF and OCR text arrives hard-wrapped at the page's line width.
          const text = /\.(pdf|png|jpe?g|tiff?|webp)$/i.test(result.fileName)
            ? unwrapHardLineBreaks(result.text)
            : result.text;
          if (isReaderPage) {
            await readerLibrary.createDocument({
              title: result.fileName.replace(/\.[^.]+$/, ""),
              description: result.pageCount ? `${result.pageCount} pages` : "",
              sourceType: "file",
              sourceName: result.fileName,
              text,
            });
          } else {
            handleTextChangeRef.current(text);
          }
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
      const { importReaderFile } = await loadReaderImport();
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
      const { fetchRemoteDocument, parseHtmlReaderDocument } = await loadReaderImport();
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
      // AdvancedReaderPage owns URL-import failures while its popover remains
      // open. Storing the same rejection here also renders the global banner,
      // duplicating the message and leaving it behind after the popover closes.
      throw new Error(message);
    } finally {
      importInFlightRef.current = false;
      setIsImportingDocument(false);
    }
  }, [documentsBridge, readerLibrary]);

  const handleNewReaderDocument = useCallback(() => {
    flushReaderAudioRef.current();
    void readerLibrary.createDocument({
      title: "Untitled document",
      sourceType: "text",
      text: "Start writing or paste text here.",
    });
  }, [readerLibrary]);

  const navigateReaderToOffset = useCallback((
    textOffset: number,
    positionSec?: number,
    continuation?: { autoPlay: boolean; autoGenerate: boolean },
  ) => {
    if (!activeReaderDocument) return;
    const targetOffset = Math.max(0, Math.min(activeReaderDocument.text.length, textOffset));
    const targetSection = readerSectionAtOffset(readerSections, targetOffset);
    if (targetSection && targetSection.id !== activeReaderSectionRef.current?.id) {
      flushReaderAudioRef.current();
      readerRestoreRequestRef.current = {
        sectionId: targetSection.id,
        ...(positionSec === undefined ? {} : { currentTime: Math.max(0, positionSec) }),
      };
    }
    readerContinuationRef.current = continuation && targetSection
      ? { sectionId: targetSection.id, ...continuation }
      : null;
    readerLibrary.updateProgress({
      positionSec: Math.max(0, positionSec ?? 0),
      totalDurationSec: 0,
      textOffset: targetOffset,
    });
  }, [activeReaderDocument, readerLibrary, readerSections]);

  const handleReaderNavigateToOffset = useCallback((textOffset: number, positionSec?: number) => {
    navigateReaderToOffset(textOffset, positionSec);
  }, [navigateReaderToOffset]);

  /**
   * Changes an input that shapes `engine`'s audio. When that engine drives the
   * visible surface, the audio made with the old input is first saved under
   * the old Reader signature, then its generation is cancelled and its audio
   * cleared, so it is never presented (or cached) as the new input's. Another
   * engine's input changes nothing audible, so the player keeps its audio.
   */
  const changeEngineInput = useCallback((engine: SurfaceEngineId, apply: () => void) => {
    if (engine === visibleEngineId) {
      if (isReaderPage) flushReaderAudioRef.current();
      const controls = engineRuntimeControls[engine];
      controls.cancel();
      controls.reset();
    }
    apply();
    setExportError(null);
  }, [engineRuntimeControls, isReaderPage, visibleEngineId]);

  const patchEngineSettings = useCallback(<Id extends AppEngineId>(
    engine: Id,
    patch: Partial<AppEngineSettings[Id]>,
  ) => {
    setEngineSettings((current) => ({ ...current, [engine]: { ...current[engine], ...patch } }));
  }, []);

  const handleVoiceChange = useCallback((nextVoice: string) => {
    if (nextVoice === voice) return;
    changeEngineInput(activeModel, () => patchEngineSettings(activeModel, { voice: nextVoice }));
  }, [activeModel, changeEngineInput, patchEngineSettings, voice]);

  const handleAudio8VoiceChange = useCallback((nextVoice: string) => {
    if (nextVoice === audio8Voice) return;
    changeEngineInput("audio8", () => patchEngineSettings("audio8", { voice: nextVoice }));
  }, [audio8Voice, changeEngineInput, patchEngineSettings]);

  const handleSupertonic3VoiceChange = useCallback((nextVoice: string) => {
    if (nextVoice === supertonic3Voice) return;
    changeEngineInput("supertonic3", () => patchEngineSettings("supertonic3", { voice: nextVoice }));
  }, [changeEngineInput, patchEngineSettings, supertonic3Voice]);

  // The language shapes Supertonic 2 audio like its voice does, so it goes
  // through the same save-then-clear path rather than being set directly.
  const handleSupertonicLanguageChange = useCallback((nextLanguage: string) => {
    if (nextLanguage === supertonicLanguage) return;
    changeEngineInput("supertonic", () => patchEngineSettings("supertonic", { language: nextLanguage }));
  }, [changeEngineInput, patchEngineSettings, supertonicLanguage]);

  const handleSupertonic3LanguageChange = useCallback((nextLanguage: string) => {
    if (nextLanguage === supertonic3Language) return;
    changeEngineInput("supertonic3", () => patchEngineSettings("supertonic3", { language: nextLanguage }));
  }, [changeEngineInput, patchEngineSettings, supertonic3Language]);

  const handleQualityChange = useCallback((nextQuality: number) => {
    if (nextQuality === quality) return;
    // Both Supertonic engines read the shared quality. Audio from an engine
    // that ignores it stays valid, so it is neither saved nor cleared.
    if (!getEngine(visibleEngineId).capabilities.quality) {
      setQuality(nextQuality);
      return;
    }
    changeEngineInput(visibleEngineId, () => setQuality(nextQuality));
  }, [changeEngineInput, quality, visibleEngineId]);

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

  const handlePageNavigation = useCallback((page: AppPage) => {
    if (isReaderPage && page !== "reader") flushReaderAudioRef.current();
    navigateToPage(page);
  }, [isReaderPage, navigateToPage]);

  const selectInlineDesktopModel = useCallback((
    page: DesktopInlineEngineId,
    currentDesktopModel: DesktopInlineEngineId | null,
    setDesktopModel: (model: DesktopInlineEngineId) => void,
  ) => {
    if (currentDesktopModel === page) return;
    cancelAllRuntimes();
    resetAllRuntimes();
    setDesktopModel(page);
    setExportError(null);
  }, [cancelAllRuntimes, resetAllRuntimes]);

  const handleStudioDesktopModelSelect = useCallback((page: DesktopInlineEngineId) => {
    selectInlineDesktopModel(page, studioDesktopModel, setStudioDesktopModel);
  }, [selectInlineDesktopModel, studioDesktopModel]);

  const handleReaderDesktopModelSelect = useCallback((page: DesktopInlineEngineId) => {
    flushReaderAudioRef.current();
    selectInlineDesktopModel(page, readerDesktopModel, setReaderDesktopModel);
  }, [readerDesktopModel, selectInlineDesktopModel]);

  const studioDesktopModelOptions = useMemo(() => (
    describeDesktopModelOptions(desktopEngineAvailability, surfaceEngineSettings, studioDesktopModel)
      .map((option) => ({ ...option, onSelect: () => handleStudioDesktopModelSelect(option.key) }))
  ), [desktopEngineAvailability, handleStudioDesktopModelSelect, studioDesktopModel, surfaceEngineSettings]);

  const readerDesktopModelOptions = useMemo(() => (
    describeDesktopModelOptions(desktopEngineAvailability, surfaceEngineSettings, readerDesktopModel)
      .map((option) => ({ ...option, onSelect: () => handleReaderDesktopModelSelect(option.key) }))
  ), [desktopEngineAvailability, handleReaderDesktopModelSelect, readerDesktopModel, surfaceEngineSettings]);

  const mountedLocalRuntimePages = useMemo(() => {
    if (!enableDesktopRuntimes || !isSetupPage(activePage)) return [];
    // Local runtime pages own model/audio buffers and an active native request.
    // Unmounting the inactive page releases those resources immediately instead
    // of retaining every runtime visited during the session.
    return [activePage];
  }, [activePage, enableDesktopRuntimes]);

  const isUsingWasmFallback = currentModelState.ready && currentModelState.backend === "wasm";

  const handleJumpToSegment = useCallback((segmentId: string) => {
    if (!segmentId) return;
    jumpToSegment(segmentId);
    setShowPlayer(true);
  }, [jumpToSegment]);

  // The browser path is spread across `useModelLoader`, `useTTS` and
  // `useGenerationControl`; the three desktop runtimes each expose the whole
  // surface from one hook. Adapting the browser path once is what lets every
  // reader below pick a runtime instead of re-deriving the same four-way
  // choice per field.
  const browserRuntime = useMemo<SurfaceRuntime>(() => ({
    modelState: currentModelState,
    canGenerate,
    isGenerating: isGenerationBusy,
    generationProgress: tts.generationProgress,
    stats: tts.stats,
    error: tts.error ?? retakeError,
    handleGenerate: runBrowserGeneration,
    handleStop,
    retryLoad: handleRetryActiveModelLoad,
  }), [
    canGenerate,
    currentModelState,
    handleRetryActiveModelLoad,
    handleStop,
    isGenerationBusy,
    retakeError,
    runBrowserGeneration,
    tts.error,
    tts.generationProgress,
    tts.stats,
  ]);

  const studioRuntime: SurfaceRuntime = isStudioUsingAudio8 ? audio8Runtime
    : isStudioUsingQwen3 ? qwen3LocalRuntime
    : isStudioUsingSupertonic3 ? supertonic3Runtime
    : browserRuntime;
  const readerRuntime: SurfaceRuntime = isReaderUsingAudio8 ? audio8Runtime
    : isReaderUsingQwen3 ? qwen3LocalRuntime
    : isReaderUsingSupertonic3 ? supertonic3Runtime
    : browserRuntime;

  const handleGenerate = useCallback(() => {
    setExportError(null);
    studioRuntime.handleGenerate();
  }, [studioRuntime]);

  const handleStudioStop = useCallback(() => {
    studioRuntime.handleStop();
  }, [studioRuntime]);

  const handleStudioRetryLoad = useCallback(() => {
    studioRuntime.retryLoad();
  }, [studioRuntime]);

  const handleReaderGenerate = useCallback(() => {
    setExportError(null);
    readerRuntime.handleGenerate();
  }, [readerRuntime]);

  const handleReaderStop = useCallback(() => {
    readerRuntime.handleStop();
  }, [readerRuntime]);

  const handleReaderRetryLoad = useCallback(() => {
    readerRuntime.retryLoad();
  }, [readerRuntime]);

  const handleDownloadAudio = useCallback(() => {
    setExportError(null);
    void downloadPlayerAudio(creator.exportOptions).catch((error: unknown) => {
      setExportError(error instanceof Error ? error.message : String(error));
    });
  }, [creator.exportOptions, downloadPlayerAudio]);

  const handleDownloadCaptions = useCallback((format: "srt" | "vtt" | "json") => {
    downloadPlayerCaptions(format);
  }, [downloadPlayerCaptions]);

  const handleSkipBackward = useCallback(() => skipPlayback(-10), [skipPlayback]);
  const handleSkipForward = useCallback(() => skipPlayback(10), [skipPlayback]);

  const creatorEngineSupport = useMemo<CreatorEngineSupport>(() => {
    const { label, capabilities } = getEngine(studioEngineId);
    return {
      engineLabel: label,
      speed: capabilities.speed,
      pauses: capabilities.pauses,
      pronunciationLexicon: capabilities.pronunciationLexicon,
    };
  }, [studioEngineId]);

  const creatorPanel = (
    <CreatorToolsPanel
      preset={creator.creatorPreset}
      onPresetChange={creator.onCreatorPresetChange}
      speed={creator.speed}
      onSpeedChange={creator.onSpeedChange}
      engineSupport={creatorEngineSupport}
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
    && !isUsingQwen3Inline
    && !isUsingAudio8Inline
    && ((webgpuStatus !== null && !webgpuStatus.available)
      || (isUsingSupertonic3Inline ? supertonic3Runtime.modelState.backend === "wasm" : isUsingWasmFallback));
  const webgpuModeNote = showWasmBadge
    ? webgpuStatus?.message ?? null
    : null;
  const showSingleThreadedNote = showWasmBadge && !window.crossOriginIsolated;
  const activeModelSupportMessage = getUnsupportedModelMessage(activeModel, browserSupport);

  // An effect event always sees the latest page, runtime and player state, so
  // the document listener below is attached once rather than on every render.
  const handleAppShortcut = useEffectEvent((event: KeyboardEvent) => {
    const primaryModifier = hasPrimaryShortcutModifier(event);

    if (primaryModifier && event.key === ",") {
      event.preventDefault();
      setAppSettingsOpen(true);
      return;
    }

    if (appSettingsOpen) return;

    if (primaryModifier && event.key === "1") {
      event.preventDefault();
      handlePageNavigation("studio");
      return;
    }

    if (primaryModifier && event.key === "2") {
      event.preventDefault();
      handlePageNavigation("reader");
      return;
    }

    if (primaryModifier && event.key === "Enter") {
      if (isStudioPage && studioRuntime.canGenerate && !studioRuntime.isGenerating) {
        event.preventDefault();
        handleGenerate();
      } else if (isReaderPage && readerRuntime.canGenerate && !readerRuntime.isGenerating) {
        event.preventDefault();
        handleReaderGenerate();
      }
      return;
    }

    if (primaryModifier && event.key === ".") {
      if (isStudioPage && studioRuntime.isGenerating) {
        event.preventDefault();
        handleStudioStop();
      } else if (isReaderPage && readerRuntime.isGenerating) {
        event.preventDefault();
        handleReaderStop();
      }
      return;
    }

    if (isSetupPage(activePage) || isEditableShortcutTarget(event.target)) return;

    // A focused control keeps Space for itself: Space on Download should
    // download, not toggle playback behind the user's back.
    const onInteractiveControl = event.target instanceof Element
      && event.target.closest("button, a[href], [role='button'], [role='slider'], [role='menuitem']") !== null;
    const canTogglePlayback = player.totalDuration > 0;
    if (!primaryModifier && !event.altKey && event.code === "Space" && canTogglePlayback && !onInteractiveControl) {
      event.preventDefault();
      void togglePlay();
      return;
    }

    if (!primaryModifier && event.altKey && player.totalDuration > 0) {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        skipPlayback(-10);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        skipPlayback(10);
      }
    }
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => handleAppShortcut(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);

  const visibleModelError = isReaderPage
    // Desktop Reader models render an inline recovery card beside the toolbar.
    // Keep the global banner for browser-model failures, whose Reader controls
    // otherwise expose only the generic "Model failed to load" status.
    ? readerDesktopModel === null ? readerRuntime.modelState.error : null
    : isStudioPage
    ? studioRuntime.modelState.error
    : currentModelState.error;
  const visibleGenerationError = isReaderPage
    ? readerRuntime.error
    : isStudioPage
    ? studioRuntime.error
    : (tts.error ?? retakeError);
  const visibleError = visibleGenerationError ?? visibleModelError ?? importError ?? exportError ?? player.error;

  const lastReaderProgressUpdateRef = useRef(0);
  const readerAudioSaveTimerRef = useRef<number | null>(null);
  const readerRestorePendingRef = useRef(false);
  const readerRestoreVersionRef = useRef(0);
  const readerAudioSaveVersionRef = useRef(0);
  const activeReaderDocumentRef = useRef(activeReaderDocument);
  activeReaderDocumentRef.current = activeReaderDocument;
  const loadReaderAudio = readerLibrary.loadAudio;
  const saveReaderAudio = readerLibrary.saveAudio;
  const clearReaderAudio = readerLibrary.clearAudio;
  const updateReaderProgress = readerLibrary.updateProgress;
  // The inputs that shape the Reader engine's audio — only those it reads, so
  // a control the engine ignores never discards its cached sections. Null
  // while one of them is still unknown (Qwen3 before its model is located).
  const readerSignatureParts = useMemo(() => surfaceEngineSignatureParts(
    readerEngineId,
    surfaceEngineSettings,
    { tuning: creator.generationSettings, quality },
  ), [creator.generationSettings, quality, readerEngineId, surfaceEngineSettings]);
  const readerSignatureKnown = readerSignatureParts !== null;
  // Signatures are section-local: editing one passage or moving chapter
  // boundaries does not invalidate hours of unrelated generated audio.
  const activeReaderAudioSignature = useMemo(() => (
    activeReaderSection && readerSignatureParts
      ? buildAudioSignature({
          text: activeReaderSectionText,
          model: readerEngineId,
          ...readerSignatureParts,
        })
      : null
  ), [activeReaderSection, activeReaderSectionText, readerEngineId, readerSignatureParts]);
  const activeReaderAudioSignatureRef = useRef(activeReaderAudioSignature);
  activeReaderAudioSignatureRef.current = activeReaderAudioSignature;
  // The restore effect below runs once per section. These effect events reach
  // the latest runtimes and library functions from it, and from the async
  // work it starts, without re-running it whenever their identities change.
  // (The library's audio functions change when its storage backend settles.)
  const resetRuntimesForSection = useEffectEvent(() => {
    cancelAllRuntimes();
    resetAllRuntimes();
  });
  const loadSectionAudio = useEffectEvent((documentId: string, sectionId: string) => (
    loadReaderAudio(documentId, sectionId)
  ));
  const clearSectionAudio = useEffectEvent((documentId: string, sectionId: string) => (
    clearReaderAudio(documentId, sectionId)
  ));
  const generateRestoredSection = useEffectEvent(() => handleReaderGenerate());

  const persistActiveReaderAudio = useCallback(() => {
    if (readerAudioSaveTimerRef.current !== null) {
      window.clearTimeout(readerAudioSaveTimerRef.current);
      readerAudioSaveTimerRef.current = null;
    }
    const documentId = activeReaderDocumentRef.current?.id;
    const section = activeReaderSectionRef.current;
    const signature = activeReaderAudioSignatureRef.current;
    if (!documentId || !section || !signature) return;
    const chunks = getReaderAudioSnapshot();
    if (chunks.length === 0) return;
    readerAudioClearedForEditRef.current = null;

    // Read at call time from the buffers just snapshotted: neither the
    // position nor the streamed duration is current in React state.
    const playback = getPlaybackSnapshot();
    const updatedAt = Math.max(Date.now(), readerAudioSaveVersionRef.current + 1);
    readerAudioSaveVersionRef.current = updatedAt;
    void saveReaderAudio({
      cacheKey: createReaderAudioCacheKey(documentId, section.id),
      documentId,
      chapterId: section.chapterId,
      sectionId: section.id,
      signature,
      chunks,
      byteLength: getCachedReaderAudioByteLength(chunks),
      currentTime: getCurrentTime(),
      playbackRate: playback.playbackRate,
      totalDuration: playback.totalDuration,
      synthesisComplete: playback.synthesisComplete,
      updatedAt,
    }).catch(reportReaderError);
  }, [
    getCurrentTime,
    getPlaybackSnapshot,
    getReaderAudioSnapshot,
    reportReaderError,
    saveReaderAudio,
  ]);
  flushReaderAudioRef.current = persistActiveReaderAudio;

  useEffect(() => {
    const restoreVersion = ++readerRestoreVersionRef.current;
    readerRestorePendingRef.current = false;
    const document = activeReaderDocumentRef.current;
    const section = activeReaderSectionRef.current;
    if (
      !isReaderPage
      || !document
      || !section
      || document.id !== activeReaderDocumentId
      || section.id !== activeReaderSection?.id
    ) return;
    let cancelled = false;
    readerRestorePendingRef.current = true;

    // Not forced: a forced cancel hard-restarts the browser model even when
    // nothing is generating, which reloaded Kokoro/Supertonic on every page
    // turn. An in-flight generation is still cancelled (and its worker
    // restarted) because `cancel` checks the live generating state itself.
    resetRuntimesForSection();
    setExportError(null);
    setImportError(null);
    // An engine whose inputs are not known yet has no signature to compare a
    // cache entry against. Restoring or discarding the entry now would act on
    // a guess; this effect runs again once the signature is known.
    if (!readerSignatureKnown) {
      readerRestorePendingRef.current = false;
      return;
    }

    const restore = async () => {
      try {
        const cache = await loadSectionAudio(document.id, section.id);
        if (cancelled) return;
        const continuation = readerContinuationRef.current?.sectionId === section.id
          ? readerContinuationRef.current
          : null;
        const restoreRequest = readerRestoreRequestRef.current?.sectionId === section.id
          ? readerRestoreRequestRef.current
          : null;
        const signature = activeReaderAudioSignatureRef.current;
        if (cache && signature && cache.signature === signature) {
          const preferredTime = restoreRequest
            ? restoreRequest.currentTime ?? cache.currentTime
            : document.progress.sectionId === section.id
              ? document.progress.positionSec
              : cache.currentTime;
          const maximumTime = Math.max(0, cache.totalDuration);
          restoreReaderAudio(cache.chunks, {
            // A saved 0 is meaningful (the user stopped or rewound).
            currentTime: Math.max(0, Math.min(maximumTime, preferredTime)),
            playbackRate: cache.playbackRate,
            synthesisComplete: cache.synthesisComplete === true,
          });
          setShowPlayer(cache.chunks.length > 0);
          if (continuation?.autoPlay && cache.chunks.length > 0) {
            window.setTimeout(() => void togglePlay(), 0);
          }
        } else {
          if (cache) void clearSectionAudio(document.id, section.id);
          if (continuation?.autoGenerate) {
            window.setTimeout(() => generateRestoredSection(), 0);
          }
        }
      } finally {
        if (readerContinuationRef.current?.sectionId === section.id) {
          readerContinuationRef.current = null;
        }
        if (readerRestoreRequestRef.current?.sectionId === section.id) {
          readerRestoreRequestRef.current = null;
        }
        if (readerRestoreVersionRef.current === restoreVersion) {
          readerRestorePendingRef.current = false;
        }
      }
    };
    void restore().catch((cause) => {
      if (!cancelled) reportReaderError(cause);
    });
    return () => {
      cancelled = true;
      readerRestorePendingRef.current = false;
    };
  }, [
    activeReaderDocumentId,
    activeReaderSection?.id,
    isReaderPage,
    readerSignatureKnown,
    reportReaderError,
    restoreReaderAudio,
    togglePlay,
  ]);

  const recordReaderProgress = useCallback(() => {
    if (!isReaderPage || !activeReaderDocument || !activeReaderSection) return;
    // Switching Reader documents resets the shared player before IndexedDB
    // audio has loaded. Never persist that temporary zero state over a real
    // resume point, and do not create progress from an empty transport.
    if (readerRestorePendingRef.current || player.segments.length === 0 || player.totalDuration <= 0) return;
    const currentTime = getCurrentTime();
    const now = Date.now();
    const atEnd = player.isSynthesisComplete && player.totalDuration > 0 && currentTime >= player.totalDuration;
    const isLastSection = activeReaderSectionIndex === readerSections.length - 1;
    const terminalTextOffset = isLastSection && player.isSynthesisComplete
      ? activeReaderDocument.text.length
      : Math.max(activeReaderSection.start, activeReaderSection.end - 1);
    if (atEnd && activeReaderDocument.progress.textOffset >= terminalTextOffset) return;
    if (!atEnd && now - lastReaderProgressUpdateRef.current < READER_PROGRESS_SAMPLE_MS) return;
    lastReaderProgressUpdateRef.current = now;

    const segment = player.segments.find((entry) => entry.id === player.activeSegmentId);
    let textOffset = activeReaderDocument.progress.textOffset;
    if (segment && typeof segment.textStart === "number" && typeof segment.textEnd === "number") {
      const duration = Math.max(0.001, segment.endSec - segment.startSec);
      const ratio = Math.max(0, Math.min(1, (currentTime - segment.startSec) / duration));
      const localOffset = segment.textStart + (segment.textEnd - segment.textStart) * ratio;
      textOffset = activeReaderSection.start + localOffset;
    }
    if (atEnd) textOffset = terminalTextOffset;
    else textOffset = Math.max(activeReaderSection.start, Math.min(terminalTextOffset, textOffset));
    updateReaderProgress({
      positionSec: currentTime,
      totalDurationSec: player.totalDuration,
      textOffset,
    });
  }, [
    getCurrentTime,
    isReaderPage,
    player.activeSegmentId,
    player.isSynthesisComplete,
    player.segments,
    player.totalDuration,
    activeReaderDocument,
    activeReaderSection,
    activeReaderSectionIndex,
    readerSections.length,
    updateReaderProgress,
  ]);
  const recordReaderProgressRef = useRef(recordReaderProgress);
  recordReaderProgressRef.current = recordReaderProgress;

  // Transport-shape changes (a new active segment, pausing, the stream ending)
  // are React state, so they still drive a progress write directly.
  useEffect(() => {
    recordReaderProgress();
  }, [recordReaderProgress, player.isPlaying]);

  const autoAdvancedSectionRef = useRef<string | null>(null);
  useEffect(() => {
    autoAdvancedSectionRef.current = null;
  }, [activeReaderSection?.id]);

  const maybeAutoAdvanceSection = useCallback(() => {
    if (
      !isReaderPage
      || !readerViewPreferences.autoAdvance
      || !activeReaderSection
      || !nextReaderSection
      || readerRestorePendingRef.current
      || readerRuntime.isGenerating
      || !player.isSynthesisComplete
      || player.isPlaying
      || player.segments.length === 0
      || player.totalDuration <= 0
      || getCurrentTime() < player.totalDuration - 0.02
      || autoAdvancedSectionRef.current === activeReaderSection.id
    ) return;
    autoAdvancedSectionRef.current = activeReaderSection.id;
    navigateReaderToOffset(nextReaderSection.start, 0, { autoPlay: true, autoGenerate: true });
  }, [
    activeReaderSection,
    getCurrentTime,
    isReaderPage,
    navigateReaderToOffset,
    nextReaderSection,
    player.isPlaying,
    player.isSynthesisComplete,
    player.segments.length,
    player.totalDuration,
    readerRuntime.isGenerating,
    readerViewPreferences.autoAdvance,
  ]);
  const maybeAutoAdvanceSectionRef = useRef(maybeAutoAdvanceSection);
  maybeAutoAdvanceSectionRef.current = maybeAutoAdvanceSection;

  useEffect(() => {
    maybeAutoAdvanceSection();
  }, [maybeAutoAdvanceSection]);

  // The position itself is not React state, so watch it through the clock
  // instead of a render dependency. The listener fires on the animation frame
  // but re-renders nothing: both callbacks are guarded (a throttle, and a
  // per-section latch) and only touch state when they actually do something.
  // Listening rather than polling also keeps a scrub-while-paused both
  // recording its resume point and honouring auto-advance at the end.
  useEffect(() => {
    if (!isReaderPage) return;
    return player.clock.subscribe(() => {
      recordReaderProgressRef.current();
      maybeAutoAdvanceSectionRef.current();
    });
  }, [isReaderPage, player.clock]);

  useEffect(() => {
    if (!isReaderPage || !activeReaderDocumentId || !activeReaderSectionRef.current || player.segments.length === 0) return;
    if (readerAudioSaveTimerRef.current !== null) window.clearTimeout(readerAudioSaveTimerRef.current);
    readerAudioSaveTimerRef.current = window.setTimeout(persistActiveReaderAudio, 800);
    return () => {
      if (readerAudioSaveTimerRef.current !== null) {
        window.clearTimeout(readerAudioSaveTimerRef.current);
        readerAudioSaveTimerRef.current = null;
      }
    };
  }, [
    activeReaderDocumentId,
    activeReaderSection?.id,
    isReaderPage,
    persistActiveReaderAudio,
    // Segment identity changes for appended transport chunks and same-count
    // retakes. Watching only length could persist a partial Reader stream.
    player.segments,
    player.isSynthesisComplete,
  ]);
  const activeSegmentIndex = player.activeSegmentId
    ? player.segments.findIndex((segment) => segment.id === player.activeSegmentId)
    : -1;
  const activeSegmentNumber = activeSegmentIndex >= 0 ? activeSegmentIndex + 1 : null;
  const browserSupportPanel = browserSupport.message
    ? <BrowserSupportPanel message={browserSupport.message} />
    : null;

  return (
    <div className="min-h-screen font-sans text-text-primary">
      <div className={`app-page ${isReaderPage ? "w-full px-3 py-3 sm:px-4 sm:py-4 md:px-6 md:py-6" : "w-full px-4 py-6 sm:px-6 sm:py-8 md:px-8 md:py-6 lg:py-10"}`}>

        <AppHeader
          immersive={isReaderPage && readerImmersive}
          compact={isReaderPage}
          subtitle={isStudioUsingAudio8
            ? "Audio8 ONNX INT4 synthesis runs locally after its one-time model download."
            : "Text to speech, entirely on your device."}
          cpuMode={showWasmBadge ? { note: webgpuModeNote, singleThreaded: showSingleThreadedNote } : null}
          onOpenSettings={openAppSettings}
          tabs={availableTabs}
          activePage={activePage}
          routeBasePath={routeBasePath}
          onNavigate={handlePageNavigation}
        />

        {(isStudioPage || isReaderPage) && browserSupportPanel && (
          <div className="mb-4">{browserSupportPanel}</div>
        )}

        <ErrorBanner error={localInferenceSupported && (isStudioPage || isReaderPage) ? visibleError : null} />

        {/* Studio and Reader swap in place. Keying the wrapper on the page
            replays the fade; the animation is opacity-only so the Reader's
            fixed player dock keeps the viewport as its containing block. */}
        <div key={activePage} className="animate-page-swap">
        {/* Studio page */}
        {isStudioPage ? (
          localInferenceSupported ? (
            <>
            <DownloadProgress
              states={{
                kokoro: kokoroState,
                supertonic: supertonicState,
                ...(isStudioUsingSupertonic3 ? { supertonic3: supertonic3Runtime.modelState } : {}),
              }}
            />

            <div className="mt-6 surface rounded-[24px]">
              <div className="grid grid-cols-1 md:grid-cols-5">
                {/* Left: text input */}
                <div className="flex min-h-[320px] flex-col border-border/40 p-4 sm:min-h-[360px] sm:p-6 md:col-span-3 md:border-r">
                  <span className="text-sm font-semibold text-text-secondary mb-3 flex-shrink-0">Script</span>
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
                <div className="flex flex-col gap-5 border-t border-border/40 p-4 sm:gap-6 sm:p-6 md:col-span-2 md:border-t-0">
                  <ModelToggle
                    activeModel={activeModel}
                    onModelChange={handleStudioModelChange}
                    desktopModelOptions={studioDesktopModelOptions}
                    kokoroState={kokoroState}
                    supertonicState={supertonicState}
                    visibleModels={browserSupport.supportedModels}
                    unavailableModels={unavailableModels}
                  />

                  {!studioDesktopModel && activeModel === "supertonic" && (
                    <SupertonicLanguageSettings language={supertonicLanguage} onChange={handleSupertonicLanguageChange} />
                  )}
                  {isStudioUsingQwen3 && (
                    <Qwen3InlineSettings onOpenSetup={() => handlePageNavigation("qwen3")} />
                  )}

                  {isStudioUsingSupertonic3 && (
                    <Supertonic3InlineSettings
                      voice={supertonic3Voice}
                      language={supertonic3Language}
                      onVoiceChange={handleSupertonic3VoiceChange}
                      onLanguageChange={handleSupertonic3LanguageChange}
                    />
                  )}

                  {isStudioUsingAudio8 && (
                    <Audio8InlineSettings
                      voice={audio8Voice}
                      onVoiceChange={handleAudio8VoiceChange}
                      cacheInfo={audio8Runtime.cacheInfo}
                      cacheBusy={audio8Runtime.cacheBusy}
                      cacheStatus={audio8Runtime.cacheStatus}
                      onClearCache={audio8Runtime.clearCache}
                    />
                  )}

                  {!isStudioUsingAudio8 && !isStudioUsingQwen3 && !isStudioUsingSupertonic3 && (
                    <VoiceSelector
                      activeModel={activeModel}
                      voice={voice}
                      onVoiceChange={handleVoiceChange}
                      kokoroVoices={kokoroVoices}
                    />
                  )}

                  <ControlsProvider
                    value={{
                      // Only engines with a quality range get the slider.
                      qualityRange: getEngine(studioEngineId).capabilities.quality,
                      quality,
                      onQualityChange: handleQualityChange,
                      onGenerate: handleGenerate,
                      onRetryLoad: handleStudioRetryLoad,
                      onStop: handleStudioStop,
                      isGenerating: studioRuntime.isGenerating,
                      canGenerate: studioRuntime.canGenerate,
                      modelReady: studioRuntime.modelState.ready,
                      modelError: studioRuntime.modelState.error,
                      loadingProgress: studioRuntime.modelState.downloadProgress,
                      generationProgress: studioRuntime.generationProgress,
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
                    clock={player.clock}
                    totalDuration={player.totalDuration}
                    segmentCount={player.segments.length}
                    activeSegmentNumber={activeSegmentNumber}
                    stats={studioRuntime.stats}
                    isGenerating={studioRuntime.isGenerating}
                    allowPlaybackDuringGeneration
                    playbackRate={player.playbackRate}
                    onPlaybackRateChange={player.setPlaybackRate}
                    onTogglePlay={togglePlay}
                    onSeek={player.seek}
                    onSkipBackward={handleSkipBackward}
                    onSkipForward={handleSkipForward}
                    onDownload={handleDownloadAudio}
                    onStop={handleStudioStop}
                  />
                </div>
              )}
            </div>

            {!isStudioUsingAudio8 && !isStudioUsingQwen3 && !isStudioUsingSupertonic3 && (
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
            <Suspense fallback={null}>
            <AdvancedReaderPage
              fullScreen
              text={activeReaderSectionText}
              onTextChange={handleReaderSectionTextChange}
              onEditStart={handleReaderSectionEditStart}
              onEditEnd={handleReaderSectionEditEnd}
              onImportDocument={documentsBridge ? handleImportDocument : undefined}
              onImportFile={handleImportReaderFile}
              onImportUrl={handleImportReaderUrl}
              isImportingDocument={isImportingDocument}
              documents={readerLibrary.documents}
              activeDocument={activeReaderDocument}
              activeChapter={activeReaderChapter}
              activeSection={activeReaderSection}
              previousSection={previousReaderSection}
              nextSection={nextReaderSection}
              onNavigateToOffset={handleReaderNavigateToOffset}
              viewPreferences={readerViewPreferences}
              onViewPreferencesChange={updateReaderViewPreferences}
              libraryLoading={readerLibrary.loading}
              libraryError={readerLibrary.error}
              libraryPersistent={readerLibrary.persistent}
              onNewDocument={handleNewReaderDocument}
              onOpenDocument={(id) => {
                flushReaderAudioRef.current();
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
              desktopQwenMode={isReaderUsingQwen3 ? qwen3Settings.profile.mode : undefined}
              // Unit-streaming engines keep extending a segment's duration while
              // it generates, so estimated word timing settles only afterwards.
              estimatedWordTrackingStable={
                getEngine(readerEngineId).capabilities.streamingGranularity !== "unit" || !readerRuntime.isGenerating
              }
              desktopVoiceLabel={readerDesktopModel
                ? surfaceEngineVoiceLabel(readerDesktopModel, surfaceEngineSettings)
                : undefined}
              desktopModelSettings={isReaderUsingAudio8
                ? (
                  <Audio8InlineSettings
                    voice={audio8Voice}
                    onVoiceChange={handleAudio8VoiceChange}
                    cacheInfo={audio8Runtime.cacheInfo}
                    cacheBusy={audio8Runtime.cacheBusy}
                    cacheStatus={audio8Runtime.cacheStatus}
                    onClearCache={audio8Runtime.clearCache}
                  />
                )
                : isReaderUsingQwen3
                  ? <Qwen3InlineSettings onOpenSetup={() => handlePageNavigation("qwen3")} />
                : isReaderUsingSupertonic3
                  ? (
                    <Supertonic3InlineSettings
                      voice={supertonic3Voice}
                      language={supertonic3Language}
                      onVoiceChange={handleSupertonic3VoiceChange}
                      onLanguageChange={handleSupertonic3LanguageChange}
                    />
                  )
                  : activeModel === "supertonic"
                    ? <SupertonicLanguageSettings language={supertonicLanguage} onChange={handleSupertonicLanguageChange} />
                    : undefined}
              kokoroState={kokoroState}
              supertonicState={supertonicState}
              visibleModels={browserSupport.supportedModels}
              unavailableModels={unavailableModels}
              kokoroVoices={kokoroVoices}
              voice={voice}
              onVoiceChange={handleVoiceChange}
              quality={quality}
              onQualityChange={handleQualityChange}
              canGenerate={readerRuntime.canGenerate}
              modelReady={readerRuntime.modelState.ready}
              modelError={readerRuntime.modelState.error}
              loadingProgress={readerRuntime.modelState.downloadProgress}
              generationProgress={readerRuntime.generationProgress}
              isGenerating={readerRuntime.isGenerating}
              onGenerate={handleReaderGenerate}
              onRetryLoad={handleReaderRetryLoad}
              onStop={handleReaderStop}
              stats={readerRuntime.stats}
              isPlaying={player.isPlaying}
              clock={player.clock}
              totalDuration={player.totalDuration}
              playbackRate={player.playbackRate}
              onPlaybackRateChange={player.setPlaybackRate}
              segments={player.segments}
              activeSegmentId={player.activeSegmentId}
              onTogglePlay={togglePlay}
              onSeek={player.seek}
              onSkipBackward={handleSkipBackward}
              onSkipForward={handleSkipForward}
              onDownload={handleDownloadAudio}
              isRetaking={getEngine(readerEngineId).capabilities.retake && isRetakingSegment}
              onRetakeSegment={handleRetakeSegment}
              canRetakeSegments={getEngine(readerEngineId).capabilities.retake}
              onJumpToSegment={handleJumpToSegment}
              generationError={readerRuntime.error}
              immersive={readerImmersive}
              onImmersiveChange={setReaderImmersive}
            />
            </Suspense>
          ) : browserSupportPanel
        ) : null}
        </div>

        {mountedLocalRuntimePages.map((page) => {
          const config = ENGINES[page].setupPage;
          const isActive = activePage === page;
          return (
            <section
              key={page}
              data-testid={`local-runtime-panel-${page}`}
              hidden={!isActive}
              aria-hidden={!isActive}
            >
              <Suspense fallback={null}>
              <LocalRuntimePage
                active={isActive}
                model={page}
                name={config.name}
                releaseDate={config.releaseDate}
                params={config.params}
                highlights={config.highlights}
                links={config.links}
                initialText={text}
              />
              </Suspense>
            </section>
          );
        })}

        {!isReaderPage && (
          <AppFooter
            // The badges name the runtimes this build ships, not the one that
            // happens to be selected, so Audio8 is listed on the same terms as
            // Kokoro and Supertonic wherever it exists.
            runtimeBadges={isStudioPage && localInferenceSupported && !browserSupport.message
              ? ["Kokoro", "Supertonic", "WebGPU · CPU", ...(desktopRuntimesAvailable ? ["Audio8 · Native CPU"] : [])]
              : null}
            note={(isStudioPage ? activeModelSupportMessage ?? browserSupport.message : null)
              ?? "More local models as compatible runtimes land."}
          />
        )}

      </div>
      {appSettingsOpen && (
        <Suspense fallback={null}>
          <AppSettingsDialog
            open={appSettingsOpen}
            desktopModelsAvailable={desktopRuntimesAvailable}
            preferences={preferences}
            onChange={updatePreferences}
            onReset={resetPreferences}
            onClose={closeAppSettings}
          />
        </Suspense>
      )}
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
