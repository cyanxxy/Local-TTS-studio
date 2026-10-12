import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useQwen3Runtime } from "../contexts/Qwen3RuntimeContext";
import { useAppEnvironment } from "../hooks/useAppEnvironment";
import { useAppPreferences } from "../hooks/useAppPreferences";
import { useAppRouting } from "../hooks/useAppRouting";
import { useAppShortcuts } from "../hooks/useAppShortcuts";
import { useAudioPlayer } from "../hooks/useAudioPlayer";
import { useCreatorSettings } from "../hooks/useCreatorSettings";
import { useDocumentImport } from "../hooks/useDocumentImport";
import { useEngineOrchestrator } from "../hooks/useEngineOrchestrator";
import { useReaderLibrary } from "../hooks/useReaderLibrary";
import { useAudiobookExport } from "../hooks/useAudiobookExport";
import { useGenerateAfterLookahead, type LookaheadControls } from "../hooks/useGenerateAfterLookahead";
import { useReaderLookahead } from "../hooks/useReaderLookahead";
import { useReaderListeningProfile, type ListeningTarget } from "../hooks/useReaderListeningProfile";
import { useReaderSections } from "../hooks/useReaderSections";
import { useReaderSession } from "../hooks/useReaderSession";
import { useReaderViewPreferences } from "../hooks/useReaderViewPreferences";
import { useStudioAudioKeeper } from "../hooks/useStudioAudioKeeper";
import {
  getInitialAppState,
  getInitialCreatorState,
  getInitialEngineSettings,
  persistAppState,
  persistCreatorState,
  persistEngineSettings,
  type PersistedAppState,
} from "../lib/appState";
import type { AppPage } from "../lib/appRouting";
import { getReaderSectionText } from "../lib/readerDocument";
import { getUnsupportedModelMessage, getWebGPUUnavailableModelMessages, isModelSupportedInBrowser, withoutUnavailableModels } from "../lib/browserSupport";
import {
  engineIsWasmOnly,
  getEngine,
  isBrowserEngineId,
  surfaceEngineSignatureParts,
  type EngineSettings,
  type SurfaceEngineId,
} from "../models/registry";
import type { ModelType } from "../types";
import type { CreatorEngineSupport } from "../components/CreatorToolsPanel";
import type { SynthesisChunk, SynthesisRequest } from "./engineRuntime";

export interface SynthesisSessionOptions {
  enableDesktopRuntimes: boolean;
  routeBasePath?: string;
  createSupertonic3Worker?: () => Worker;
}

/**
 * The engines whose settings Studio owns and persists. Qwen3's settings live
 * in `Qwen3RuntimeProvider`, which persists them itself.
 */
type AppEngineId = Exclude<SurfaceEngineId, "qwen3">;
type AppEngineSettings = { [Id in AppEngineId]: EngineSettings<Id> };

/**
 * Everything the app's surfaces share: the routed page, the engines and their
 * settings, the one audio player, the Studio script, and the Reader's library
 * and session. The surfaces read it through `SynthesisSessionContext`; this
 * hook is the only place the pieces are wired together.
 */
export function useSynthesisSessionState({
  enableDesktopRuntimes,
  routeBasePath = "",
  createSupertonic3Worker,
}: SynthesisSessionOptions) {
  const environment = useAppEnvironment(enableDesktopRuntimes);
  const { desktopRuntimesAvailable, browserSupport, debugProfiling, webgpuStatus } = environment;
  const localInferenceSupported = browserSupport.isSupported;
  // Why each browser model cannot run on this device. A model that needs WebGPU
  // is ruled out once WebGPU is known to be missing, so no surface selects it
  // and no worker is started for it.
  const webgpuUnavailableModels = useMemo(
    () => getWebGPUUnavailableModelMessages(webgpuStatus === null ? null : webgpuStatus.available),
    [webgpuStatus],
  );
  const unavailableModels = useMemo(
    () => ({ ...browserSupport.unsupportedModelMessages, ...webgpuUnavailableModels }),
    [browserSupport.unsupportedModelMessages, webgpuUnavailableModels],
  );
  const runnableBrowserSupport = useMemo(
    () => withoutUnavailableModels(browserSupport, unavailableModels),
    [browserSupport, unavailableModels],
  );
  const { preferences, updatePreferences, resetPreferences } = useAppPreferences();
  const [appSettingsOpen, setAppSettingsOpen] = useState(false);
  const qwen3Settings = useQwen3Runtime();
  const initialState = useMemo(() => getInitialAppState(), []);
  const initialCreatorState = useMemo(() => getInitialCreatorState(), []);
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
    const { kokoro, supertonic, kitten, paradee, piper, chatterbox, audio8, supertonic3 } = getInitialEngineSettings();
    return { kokoro, supertonic, kitten, paradee, piper, chatterbox, audio8, supertonic3 };
  });
  const [quality, setQuality] = useState(initialState.quality);
  const [showPlayer, setShowPlayer] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const { voice: audio8Voice } = engineSettings.audio8;
  const { voice: supertonic3Voice, language: supertonic3Language } = engineSettings.supertonic3;
  const { language: supertonicLanguage } = engineSettings.supertonic;

  const readerLibrary = useReaderLibrary(initialState.text);
  const {
    preferences: readerViewPreferences,
    updatePreferences: updateReaderViewPreferences,
  } = useReaderViewPreferences();
  const readerSections = useReaderSections(readerLibrary.activeDocument);
  const synthesisText = isReaderPage && readerSections.activeSection
    ? readerSections.activeSectionText
    : text;
  // Anything that replaces the Reader's audio saves it first. The Reader
  // session that knows how is created after the engines it saves for, so the
  // engines reach it through this ref.
  const flushReaderAudioRef = useRef<() => void>(() => undefined);
  const beforeReaderAudioChange = useCallback(() => flushReaderAudioRef.current(), []);

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
    jumpToSegment,
    skip: skipPlayback,
    togglePlay,
  } = player;

  const creator = useCreatorSettings({
    initialState: initialCreatorState,
    quality,
    language: supertonicLanguage,
  });

  const clearExportError = useCallback(() => setExportError(null), []);
  const {
    activeModel,
    chosenModel,
    desktopModels: { studio: studioDesktopModel, reader: readerDesktopModel },
    chosenDesktopModels,
    engineIds: { studio: studioEngineId, reader: readerEngineId },
    visibleEngineId,
    runtimes,
    audio8,
    browser,
    surfaceEngineSettings,
    desktopModelOptions,
    desktopEngineAvailability,
    retireAllAudio,
    selectBrowserModel,
    selectDesktopModel,
    changeEngineInput,
  } = useEngineOrchestrator({
    surface: isReaderPage ? "reader" : isStudioPage ? "studio" : null,
    desktopRuntimesAvailable,
    createSupertonic3Worker,
    enableDesktopRuntimes,
    browserSupport: runnableBrowserSupport,
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
  const browserRuntime = runtimes[activeModel];
  const currentModelState = browserRuntime.modelState;
  const voice = browser.voicesInUse[activeModel];
  const studioRuntime = runtimes[studioEngineId];
  const readerRuntime = runtimes[readerEngineId];

  const patchEngineSettings = useCallback(<Id extends AppEngineId>(
    engine: Id,
    patch: Partial<AppEngineSettings[Id]>,
  ) => {
    setEngineSettings((current) => ({ ...current, [engine]: { ...current[engine], ...patch } }));
  }, []);

  const { setPlaybackRate } = player;
  const isListeningEngineUsable = useCallback((engine: SurfaceEngineId) => (
    isBrowserEngineId(engine)
      ? isModelSupportedInBrowser(engine, runnableBrowserSupport)
      : desktopEngineAvailability[engine]
  ), [desktopEngineAvailability, runnableBrowserSupport]);
  // A book's remembered voice, quality and speed belong to the Reader. The
  // values Studio had are set aside the first time the Reader changes them and
  // put back when Studio is shown again or a book without a profile is opened.
  const [studioGlobals, setStudioGlobals] = useState<{
    engineSettings: AppEngineSettings;
    quality: number;
    playbackRate: number;
  } | null>(null);
  const currentPlaybackRate = player.playbackRate;
  const setAsideStudioGlobals = useCallback(() => {
    setStudioGlobals((current) => current ?? { engineSettings, quality, playbackRate: currentPlaybackRate });
  }, [currentPlaybackRate, engineSettings, quality]);
  const applyListeningProfile = useCallback(({ engine: profile, playbackRate: rate }: ListeningTarget) => {
    setAsideStudioGlobals();
    if (profile) {
      const { engine } = profile;
      if (engine !== readerEngineId) {
        if (isBrowserEngineId(engine)) selectBrowserModel("reader", engine);
        else selectDesktopModel("reader", engine);
      }
      switch (engine) {
        case "kokoro":
        case "audio8":
        case "kitten":
        case "paradee":
        case "piper":
        case "chatterbox":
          patchEngineSettings(engine, { voice: profile.voice });
          break;
        case "supertonic":
          patchEngineSettings(engine, { voice: profile.voice, ...(profile.language ? { language: profile.language } : {}) });
          break;
        case "supertonic3":
          patchEngineSettings(engine, { voice: profile.voice, ...(profile.language ? { language: profile.language } : {}) });
          break;
        case "qwen3":
          break;
        default: {
          const unhandled: never = engine;
          throw new Error(`Listening profile has no apply rule for ${String(unhandled)}`);
        }
      }
      if (profile.quality !== undefined && getEngine(engine).capabilities.quality) setQuality(profile.quality);
    }
    if (rate !== null) setPlaybackRate(rate);
  }, [patchEngineSettings, readerEngineId, selectBrowserModel, selectDesktopModel, setAsideStudioGlobals, setPlaybackRate]);
  const readerListening = useReaderListeningProfile({
    active: isReaderPage,
    loading: readerLibrary.loading,
    document: readerLibrary.activeDocument,
    engineId: readerEngineId,
    surfaceEngineSettings,
    quality,
    playbackRate: player.playbackRate,
    isEngineUsable: isListeningEngineUsable,
    apply: applyListeningProfile,
    updateListening: readerLibrary.updateActiveListening,
  });
  const { remember: rememberProfile } = readerListening;
  const rememberListening = useCallback((change: Parameters<typeof rememberProfile>[0]) => {
    if (!isReaderPage) return;
    setAsideStudioGlobals();
    rememberProfile(change);
  }, [isReaderPage, rememberProfile, setAsideStudioGlobals]);

  const putBackStudioGlobals = useEffectEvent(() => {
    if (!studioGlobals) return;
    setEngineSettings(studioGlobals.engineSettings);
    setQuality(studioGlobals.quality);
    setPlaybackRate(studioGlobals.playbackRate);
    setStudioGlobals(null);
  });
  const readerBookHasProfile = readerLibrary.activeDocument?.listening !== undefined;
  const readerBookId = readerLibrary.activeDocument?.id ?? null;
  useEffect(() => {
    if (isReaderPage && (readerBookHasProfile || readerLibrary.loading)) return;
    const timer = window.setTimeout(() => putBackStudioGlobals(), 0);
    return () => window.clearTimeout(timer);
  }, [isReaderPage, readerBookHasProfile, readerBookId, readerLibrary.loading]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const persisted: PersistedAppState = {
        model: chosenModel,
        text,
        quality: studioGlobals?.quality ?? quality,
        desktopModels: chosenDesktopModels,
      };
      persistAppState(persisted);
      persistEngineSettings(studioGlobals?.engineSettings ?? engineSettings);
    }, 200);

    return () => window.clearTimeout(timeoutId);
  }, [chosenDesktopModels, chosenModel, engineSettings, quality, studioGlobals, text]);

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
    rememberListening({ engine: model });
  }, [rememberListening, selectBrowserModel]);

  const handleReaderPlaybackRateChange = useCallback((rate: number) => {
    setPlaybackRate(rate);
    rememberListening({ playbackRate: rate });
  }, [rememberListening, setPlaybackRate]);

  // A Reader choice is remembered for the open book. The pickers are shared
  // with Studio, so only a change that reaches the Reader's own engine counts.
  const readerEngineHas = useCallback((engine: SurfaceEngineId) => isReaderPage && readerEngineId === engine, [
    isReaderPage,
    readerEngineId,
  ]);
  const readerDesktopModelOptions = useMemo(() => desktopModelOptions.reader.map((option) => ({
    ...option,
    onSelect: () => {
      option.onSelect();
      rememberListening({ engine: option.key });
    },
  })), [desktopModelOptions.reader, rememberListening]);

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

  // A look-ahead render holds the engine's queue, so a generate asked for
  // while one runs first yields the engine and then waits for it to free up.
  const lookaheadControlsRef = useRef<LookaheadControls>({
    preempt: () => undefined,
    isBusy: () => false,
    settled: () => Promise.resolve(),
  });
  const { requestGenerate: requestReaderGenerate, cancelPending: cancelPendingReaderGenerate } = useGenerateAfterLookahead({
    controls: lookaheadControlsRef,
    canGenerate: readerRuntime.canGenerate,
    startGenerate: readerRuntime.handleGenerate,
    scopeKey: `${readerLibrary.activeDocument?.id ?? ""}:${readerSections.activeSection?.id ?? ""}`,
  });
  const handleReaderGenerate = useCallback(() => {
    setExportError(null);
    requestReaderGenerate();
  }, [requestReaderGenerate]);

  // The inputs that shape the Reader engine's audio — only those it reads, so
  // a control the engine ignores never discards its cached sections. Null
  // while one of them is still unknown (Qwen3 before its model is located).
  const readerSignatureParts = useMemo(() => surfaceEngineSignatureParts(
    readerEngineId,
    surfaceEngineSettings,
    { tuning: creator.generationSettings, quality },
  ), [creator.generationSettings, quality, readerEngineId, surfaceEngineSettings]);
  const clearReaderErrors = useCallback(() => {
    setExportError(null);
    setImportError(null);
  }, []);
  const reportReaderError = useCallback((message: string) => setImportError(message), []);
  // The Reader empties the shared player as it enters a section; Studio's
  // unsaved audio is set aside first and put back when Studio returns.
  const { keepStudioAudio } = useStudioAudioKeeper({ isStudioPage, player, setShowPlayer });
  const retireAudioForReader = useCallback(() => {
    keepStudioAudio();
    retireAllAudio();
  }, [keepStudioAudio, retireAllAudio]);
  const readerSession = useReaderSession({
    active: isReaderPage,
    library: readerLibrary,
    sections: readerSections,
    player,
    engineId: readerEngineId,
    // Held back until the book's remembered voice is in place, because a
    // lookup under the wrong voice would discard the audio saved under its own.
    signatureParts: readerListening.settled ? readerSignatureParts : null,
    playbackRate: readerLibrary.activeDocument?.listening?.playbackRate ?? null,
    keepMismatchedAudio: readerListening.pending,
    isGenerating: readerRuntime.isGenerating,
    generate: handleReaderGenerate,
    autoAdvance: readerViewPreferences.autoAdvance,
    retireAllAudio: retireAudioForReader,
    resetAudioForTextEdit,
    setShowPlayer,
    clearErrors: clearReaderErrors,
    onError: reportReaderError,
  });
  const readerNextSectionText = useMemo(() => (
    readerLibrary.activeDocument && readerSections.nextSection
      ? getReaderSectionText(readerLibrary.activeDocument.text, readerSections.nextSection)
      : ""
  ), [readerLibrary.activeDocument, readerSections.nextSection]);
  const readerTuning = creator.generationSettings;
  const readerSynthesize = readerRuntime.synthesize as (request: SynthesisRequest) => AsyncIterable<SynthesisChunk>;
  const renderReaderSection = useCallback((text: string, signal: AbortSignal) => readerSynthesize({
    text,
    // Qwen3's settings live in its provider, which also holds the clone reference.
    settings: readerEngineId === "qwen3" ? qwen3Settings : surfaceEngineSettings[readerEngineId],
    tuning: readerTuning,
    signal,
  } as SynthesisRequest), [qwen3Settings, readerEngineId, readerSynthesize, readerTuning, surfaceEngineSettings]);
  const readerSignaturePartsWhenSettled = readerListening.settled ? readerSignatureParts : null;
  const audiobook = useAudiobookExport({
    document: readerLibrary.activeDocument,
    sections: readerSections.sections,
    engineId: readerEngineId,
    signatureParts: readerSignaturePartsWhenSettled,
    renderSection: renderReaderSection,
    library: readerLibrary,
  });
  const audiobookRunning = audiobook.state.status === "running";
  const readerLookahead = useReaderLookahead({
    // An export renders through the same queue; the look-ahead would only wait behind it.
    enabled: readerViewPreferences.prepareAhead && !audiobookRunning,
    active: isReaderPage,
    document: readerLibrary.activeDocument,
    nextSection: readerSections.nextSection,
    nextSectionText: readerNextSectionText,
    engineId: readerEngineId,
    signatureParts: readerSignaturePartsWhenSettled,
    renderSection: renderReaderSection,
    engineBusy: readerRuntime.isGenerating,
    modelReady: readerRuntime.modelState.ready,
    currentSectionPlaying: player.isPlaying && player.isSynthesisComplete && player.segments.length > 0,
    isRetaking: browser.isRetakingSegment,
    library: readerLibrary,
    onFailure: (cause) => console.warn("Could not prepare the next part:", cause),
  });
  const { preempt: preemptLookahead, isBusy: isLookaheadBusy, settled: lookaheadSettled } = readerLookahead;
  useEffect(() => {
    lookaheadControlsRef.current = { preempt: preemptLookahead, isBusy: isLookaheadBusy, settled: lookaheadSettled };
  }, [isLookaheadBusy, lookaheadSettled, preemptLookahead]);
  const handleReaderRetakeSegment = useCallback((...args: Parameters<typeof browser.handleRetakeSegment>) => {
    preemptLookahead();
    browser.handleRetakeSegment(...args);
  }, [browser, preemptLookahead]);
  const { flushAudio: flushReaderAudio } = readerSession;
  useEffect(() => {
    flushReaderAudioRef.current = flushReaderAudio;
  }, [flushReaderAudio]);

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

  const handleVoiceChange = useCallback((nextVoice: string) => {
    if (nextVoice === voice) return;
    changeEngineInput(activeModel, () => patchEngineSettings(activeModel, { voice: nextVoice }));
    if (readerEngineHas(activeModel)) rememberListening({ voice: nextVoice });
  }, [activeModel, changeEngineInput, patchEngineSettings, readerEngineHas, rememberListening, voice]);

  const handleAudio8VoiceChange = useCallback((nextVoice: string) => {
    if (nextVoice === audio8Voice) return;
    changeEngineInput("audio8", () => patchEngineSettings("audio8", { voice: nextVoice }));
    if (readerEngineHas("audio8")) rememberListening({ voice: nextVoice });
  }, [audio8Voice, changeEngineInput, patchEngineSettings, readerEngineHas, rememberListening]);

  // Seed and temperature shape the audio, so they save-then-clear like the voice.
  const handleAudio8SamplingChange = useCallback((patch: Partial<Pick<AppEngineSettings["audio8"], "seed" | "temperature">>) => {
    changeEngineInput("audio8", () => patchEngineSettings("audio8", patch));
  }, [changeEngineInput, patchEngineSettings]);

  const handleSupertonic3SeedChange = useCallback((seed: number | null) => {
    changeEngineInput("supertonic3", () => patchEngineSettings("supertonic3", { seed }));
  }, [changeEngineInput, patchEngineSettings]);

  const handleSupertonic3VoiceChange = useCallback((nextVoice: string) => {
    if (nextVoice === supertonic3Voice) return;
    changeEngineInput("supertonic3", () => patchEngineSettings("supertonic3", { voice: nextVoice }));
    if (readerEngineHas("supertonic3")) rememberListening({ voice: nextVoice });
  }, [changeEngineInput, patchEngineSettings, readerEngineHas, rememberListening, supertonic3Voice]);

  // The language shapes Supertonic 2 audio like its voice does, so it goes
  // through the same save-then-clear path rather than being set directly.
  const handleSupertonicLanguageChange = useCallback((nextLanguage: string) => {
    if (nextLanguage === supertonicLanguage) return;
    changeEngineInput("supertonic", () => patchEngineSettings("supertonic", { language: nextLanguage }));
    if (readerEngineHas("supertonic")) rememberListening({ language: nextLanguage });
  }, [changeEngineInput, patchEngineSettings, readerEngineHas, rememberListening, supertonicLanguage]);

  const handleSupertonic3LanguageChange = useCallback((nextLanguage: string) => {
    if (nextLanguage === supertonic3Language) return;
    changeEngineInput("supertonic3", () => patchEngineSettings("supertonic3", { language: nextLanguage }));
    if (readerEngineHas("supertonic3")) rememberListening({ language: nextLanguage });
  }, [changeEngineInput, patchEngineSettings, readerEngineHas, rememberListening, supertonic3Language]);

  // Temperature and seed shape Chatterbox's audio, so they go through the same
  // save-then-clear path as its voice.
  const handleChatterboxChange = useCallback((patch: Partial<Pick<AppEngineSettings["chatterbox"], "temperature" | "seed">>) => {
    changeEngineInput("chatterbox", () => patchEngineSettings("chatterbox", patch));
  }, [changeEngineInput, patchEngineSettings]);

  const handleQualityChange = useCallback((nextQuality: number) => {
    if (nextQuality === quality) return;
    // Both Supertonic engines read the shared quality. Audio from an engine
    // that ignores it stays valid, so it is neither saved nor cleared.
    if (!visibleEngineId || !getEngine(visibleEngineId).capabilities.quality) {
      setQuality(nextQuality);
      return;
    }
    changeEngineInput(visibleEngineId, () => setQuality(nextQuality));
    if (isReaderPage) rememberListening({ quality: nextQuality });
  }, [changeEngineInput, isReaderPage, quality, rememberListening, visibleEngineId]);

  const handlePageNavigation = useCallback((page: AppPage) => {
    if (isReaderPage && page !== "reader") flushReaderAudio();
    navigateToPage(page);
  }, [flushReaderAudio, isReaderPage, navigateToPage]);

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

  const handleReaderStop = useCallback(() => {
    cancelPendingReaderGenerate();
    readerRuntime.handleStop();
  }, [cancelPendingReaderGenerate, readerRuntime]);

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

  const isUsingWasmFallback = currentModelState.ready && currentModelState.backend === "wasm";
  const showWasmBadge = localInferenceSupported
    && visibleEngineId !== null
    && visibleEngineId !== "qwen3"
    && visibleEngineId !== "audio8"
    // Paradee and Piper run on the CPU by design; there is no GPU path to miss.
    && !engineIsWasmOnly(visibleEngineId)
    && ((webgpuStatus !== null && !webgpuStatus.available)
      || (visibleEngineId === "supertonic3" ? runtimes.supertonic3.modelState.backend === "wasm" : isUsingWasmFallback));
  const webgpuModeNote = showWasmBadge
    ? webgpuStatus?.message ?? null
    : null;
  const showSingleThreadedNote = showWasmBadge && !window.crossOriginIsolated;
  // A chosen model the device cannot run explains itself while another runs in its place.
  const activeModelSupportMessage = getUnsupportedModelMessage(activeModel, browserSupport)
    ?? (webgpuUnavailableModels[chosenModel] ?? null);

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

  const activeSegmentIndex = player.activeSegmentId
    ? player.segments.findIndex((segment) => segment.id === player.activeSegmentId)
    : -1;

  return {
    environment,
    preferences: { value: preferences, update: updatePreferences, reset: resetPreferences },
    appSettings: { open: appSettingsOpen, onOpen: openAppSettings, onClose: closeAppSettings },
    routing: {
      activePage,
      isReaderPage,
      isStudioPage,
      routeBasePath,
      tabs: availableTabs,
      navigate: handlePageNavigation,
    },
    /** What the header and footer say about the visible surface. */
    chrome: {
      visibleError,
      showWasmBadge,
      webgpuModeNote,
      showSingleThreadedNote,
      activeModelSupportMessage,
    },
    player: {
      state: player,
      show: showPlayer,
      setShow: setShowPlayer,
      activeSegmentNumber: activeSegmentIndex >= 0 ? activeSegmentIndex + 1 : null,
      togglePlay,
      skipBackward: handleSkipBackward,
      skipForward: handleSkipForward,
      downloadAudio: handleDownloadAudio,
      downloadCaptions: handleDownloadCaptions,
    },
    creator,
    creatorEngineSupport,
    engines: {
      activeModel,
      runtimes,
      audio8,
      browser,
      desktopModelOptions: { ...desktopModelOptions, reader: readerDesktopModelOptions },
      surfaceEngineSettings,
      voice,
      kokoroVoices: browser.voices.kokoro,
      currentModelState,
      quality,
      changeQuality: handleQualityChange,
      changeVoice: handleVoiceChange,
      audio8Voice,
      changeAudio8Voice: handleAudio8VoiceChange,
      audio8Settings: engineSettings.audio8,
      changeAudio8Sampling: handleAudio8SamplingChange,
      unavailableModels,
      chatterbox: engineSettings.chatterbox,
      changeChatterbox: handleChatterboxChange,
      supertonicLanguage,
      changeSupertonicLanguage: handleSupertonicLanguageChange,
      supertonic3Voice,
      supertonic3Language,
      supertonic3Seed: engineSettings.supertonic3.seed,
      changeSupertonic3Seed: handleSupertonic3SeedChange,
      changeSupertonic3Voice: handleSupertonic3VoiceChange,
      changeSupertonic3Language: handleSupertonic3LanguageChange,
    },
    studio: {
      text,
      changeText: handleTextChange,
      engineId: studioEngineId,
      desktopModel: studioDesktopModel,
      runtime: studioRuntime,
      changeModel: handleStudioModelChange,
      generate: handleGenerate,
      stop: handleStudioStop,
      retryLoad: handleStudioRetryLoad,
    },
    reader: {
      library: readerLibrary,
      session: readerSession,
      viewPreferences: readerViewPreferences,
      updateViewPreferences: updateReaderViewPreferences,
      engineId: readerEngineId,
      desktopModel: readerDesktopModel,
      runtime: readerRuntime,
      changeModel: handleReaderModelChange,
      setPlaybackRate: handleReaderPlaybackRateChange,
      generate: handleReaderGenerate,
      stop: handleReaderStop,
      retryLoad: handleReaderRetryLoad,
      jumpToSegment: handleJumpToSegment,
      retakeSegment: handleReaderRetakeSegment,
      lookahead: readerLookahead,
      audiobook,
    },
    documents: {
      isImporting: isImportingDocument,
      importDocument: handleImportDocument,
      importReaderFile: handleImportReaderFile,
      importReaderUrl: handleImportReaderUrl,
    },
  };
}

export type SynthesisSession = ReturnType<typeof useSynthesisSessionState>;
