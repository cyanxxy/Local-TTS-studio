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
import type { ModelType } from "../types";
import { useAudioPlayer } from "../hooks/useAudioPlayer";
import { useAppRouting } from "../hooks/useAppRouting";
import { useAppShortcuts } from "../hooks/useAppShortcuts";
import { useDocumentImport } from "../hooks/useDocumentImport";
import { useAppPreferences } from "../hooks/useAppPreferences";
import { useCreatorSettings } from "../hooks/useCreatorSettings";
import { useEngineOrchestrator } from "../hooks/useEngineOrchestrator";
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
import { getLocalBrowserSupport, getUnsupportedModelMessage } from "../lib/browserSupport";
import { getWebGPUStatus, type WebGPUStatus } from "../lib/webgpu";
import {
  getInitialAppState,
  getInitialCreatorState,
  getInitialEngineSettings,
  persistAppState,
  persistCreatorState,
  persistEngineSettings,
  type PersistedAppState,
} from "../lib/appState";
import {
  buildAudioSignature,
  createReaderAudioCacheKey,
  getCachedReaderAudioByteLength,
  normalizeReaderTextFragment,
  readerSectionAtOffset,
} from "../lib/readerDocument";
import { isReaderLibraryShutdownError } from "../lib/readerLibrary";
import {
  ENGINES,
  getEngine,
  surfaceEngineSignatureParts,
  surfaceEngineVoiceLabel,
  type EngineSettings,
  type SurfaceEngineId,
} from "../models/registry";

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
  const [engineSettings, setEngineSettings] = useState<AppEngineSettings>(() => {
    const { kokoro, supertonic, audio8, supertonic3 } = getInitialEngineSettings();
    return { kokoro, supertonic, audio8, supertonic3 };
  });
  const [quality, setQuality] = useState(initialState.quality);
  const [showPlayer, setShowPlayer] = useState(false);
  const [webgpuStatus, setWebgpuStatus] = useState<WebGPUStatus | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const { voice: audio8Voice } = engineSettings.audio8;
  const { voice: supertonic3Voice, language: supertonic3Language } = engineSettings.supertonic3;
  const { language: supertonicLanguage } = engineSettings.supertonic;
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
    skip: skipPlayback,
    togglePlay,
  } = player;

  const creator = useCreatorSettings({
    initialState: initialCreatorState,
    quality,
    language: supertonicLanguage,
  });

  // Anything that replaces the Reader's audio saves it first. The function
  // lives in a ref because the Reader audio cache is declared further down.
  const beforeReaderAudioChange = useCallback(() => flushReaderAudioRef.current(), []);
  const clearExportError = useCallback(() => setExportError(null), []);
  const {
    activeModel,
    desktopModels: { studio: studioDesktopModel, reader: readerDesktopModel },
    chosenDesktopModels,
    engineIds: { studio: studioEngineId, reader: readerEngineId },
    visibleEngineId,
    runtimes,
    audio8: audio8Runtime,
    browser,
    surfaceEngineSettings,
    desktopModelOptions,
    retireAllAudio,
    selectBrowserModel,
    changeEngineInput,
  } = useEngineOrchestrator({
    surface: isReaderPage ? "reader" : isStudioPage ? "studio" : null,
    desktopRuntimesAvailable,
    createSupertonic3Worker,
    enableDesktopRuntimes,
    browserSupport,
    debugProfiling,
    initialState,
    text: synthesisText,
    engineSettings,
    generationSettings: creator.generationSettings,
    player,
    setShowPlayer,
    beforeReaderAudioChange,
    onEngineChange: clearExportError,
  });
  const isStudioUsingQwen3 = studioDesktopModel === "qwen3";
  const isStudioUsingSupertonic3 = studioDesktopModel === "supertonic3";
  const isStudioUsingAudio8 = studioDesktopModel === "audio8";
  const isReaderUsingQwen3 = readerDesktopModel === "qwen3";
  const isReaderUsingSupertonic3 = readerDesktopModel === "supertonic3";
  const isReaderUsingAudio8 = readerDesktopModel === "audio8";
  const { states: { kokoro: kokoroState, supertonic: supertonicState }, voices: { kokoro: kokoroVoices } } = browser;
  const browserRuntime = runtimes[activeModel];
  const currentModelState = browserRuntime.modelState;
  const voice = browser.voicesInUse[activeModel];
  const studioRuntime = runtimes[studioEngineId];
  const readerRuntime = runtimes[readerEngineId];

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const persisted: PersistedAppState = {
        model: activeModel,
        text,
        quality,
        desktopModels: chosenDesktopModels,
      };
      persistAppState(persisted);
      persistEngineSettings(engineSettings);
    }, 200);

    return () => window.clearTimeout(timeoutId);
  }, [activeModel, chosenDesktopModels, engineSettings, quality, text]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      persistCreatorState(creator.persistedState);
    }, 200);

    return () => window.clearTimeout(timeoutId);
  }, [creator.persistedState]);

  const handleStudioModelChange = useCallback((model: ModelType) => {
    selectBrowserModel("studio", model);
  }, [selectBrowserModel]);

  const handleReaderModelChange = useCallback((model: ModelType) => {
    selectBrowserModel("reader", model);
  }, [selectBrowserModel]);

  const resetAudioForTextEdit = useCallback(() => {
    const hasActiveAudioState = Object.values(runtimes).some((runtime) => runtime.isGenerating)
      || player.segments.length > 0
      || player.totalDuration > 0;
    if (hasActiveAudioState) {
      // Unforced: finished audio only needs clearing, and a forced cancel
      // would reload the model on the first keystroke after listening.
      retireAllAudio();
    }
  }, [player.segments.length, player.totalDuration, retireAllAudio, runtimes]);

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

  const {
    isImportingDocument,
    importDocument: handleImportDocument,
    importReaderFile: handleImportReaderFile,
    importReaderUrl: handleImportReaderUrl,
  } = useDocumentImport({
    documentsBridge,
    isReaderPage,
    createReaderDocument: readerLibrary.createDocument,
    onStudioText: handleTextChange,
    setImportError,
  });

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
    if (!visibleEngineId || !getEngine(visibleEngineId).capabilities.quality) {
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
    && visibleEngineId !== null
    && visibleEngineId !== "qwen3"
    && visibleEngineId !== "audio8"
    && ((webgpuStatus !== null && !webgpuStatus.available)
      || (visibleEngineId === "supertonic3" ? runtimes.supertonic3.modelState.backend === "wasm" : isUsingWasmFallback));
  const webgpuModeNote = showWasmBadge
    ? webgpuStatus?.message ?? null
    : null;
  const showSingleThreadedNote = showWasmBadge && !window.crossOriginIsolated;
  const activeModelSupportMessage = getUnsupportedModelMessage(activeModel, browserSupport);

  const handleTogglePlayback = useCallback(() => void togglePlay(), [togglePlay]);
  useAppShortcuts({
    activePage,
    settingsOpen: appSettingsOpen,
    onOpenSettings: openAppSettings,
    onNavigate: handlePageNavigation,
    surface: isStudioPage
      ? { ...studioRuntime, generate: handleGenerate, stop: handleStudioStop }
      : isReaderPage
        ? { ...readerRuntime, generate: handleReaderGenerate, stop: handleReaderStop }
        : null,
    hasAudio: player.totalDuration > 0,
    onTogglePlayback: handleTogglePlayback,
    onSkip: skipPlayback,
  });

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
    : browserRuntime.error;
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
  const resetRuntimesForSection = useEffectEvent(() => retireAllAudio());
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
  useEffect(() => {
    flushReaderAudioRef.current = persistActiveReaderAudio;
  }, [persistActiveReaderAudio]);

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

  useEffect(() => {
    maybeAutoAdvanceSection();
  }, [maybeAutoAdvanceSection]);

  // The position itself is not React state, so watch it through the clock
  // instead of a render dependency. The listener fires on the animation frame
  // but re-renders nothing: both callbacks are guarded (a throttle, and a
  // per-section latch) and only touch state when they actually do something.
  // Listening rather than polling also keeps a scrub-while-paused both
  // recording its resume point and honouring auto-advance at the end.
  const onPlaybackTick = useEffectEvent(() => {
    recordReaderProgress();
    maybeAutoAdvanceSection();
  });
  useEffect(() => {
    if (!isReaderPage) return;
    return player.clock.subscribe(() => onPlaybackTick());
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
                ...(isStudioUsingSupertonic3 ? { supertonic3: runtimes.supertonic3.modelState } : {}),
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
                      onImportDocument={handleImportDocument}
                      isImportingDocument={isImportingDocument}
                    />
                  </div>
                </div>

                {/* Right: controls */}
                <div className="flex flex-col gap-5 border-t border-border/40 p-4 sm:gap-6 sm:p-6 md:col-span-2 md:border-t-0">
                  <ModelToggle
                    activeModel={activeModel}
                    onModelChange={handleStudioModelChange}
                    desktopModelOptions={desktopModelOptions.studio}
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
                  busy={browser.cacheBusy || currentModelState.loading}
                  status={browser.cacheStatus}
                  onClearCache={browser.clearCache}
                  onRedownloadActive={browser.redownloadActiveModel}
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
              onImportDocument={handleImportDocument}
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
              desktopModelOptions={desktopModelOptions.reader}
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
              isRetaking={getEngine(readerEngineId).capabilities.retake && browser.isRetakingSegment}
              onRetakeSegment={browser.handleRetakeSegment}
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
