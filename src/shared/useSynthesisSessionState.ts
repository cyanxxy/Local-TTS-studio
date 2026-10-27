import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useQwen3Runtime } from "../contexts/Qwen3RuntimeContext";
import { useAppEnvironment } from "../hooks/useAppEnvironment";
import { useAppPreferences } from "../hooks/useAppPreferences";
import { useAppRouting } from "../hooks/useAppRouting";
import { useAppShortcuts } from "../hooks/useAppShortcuts";
import { useAudioExport } from "../hooks/useAudioExport";
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
import { useLibraryChatterboxClips } from "../hooks/useLibraryChatterboxClips";
import { useVoiceApplier } from "../hooks/useVoiceApplier";
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
import { buildExportFileName } from "../lib/audioExportClient";
import { describeSpeechPipeline } from "../lib/speechPipeline";
import { isSpeechNormalizationSupported } from "../lib/text/normalize";
import { chatterboxClipForVoice } from "../lib/voiceLibrary/chatterboxLibrary";
import { getVoiceLibraryStore } from "../lib/voiceLibrary/store";
import {
  engineIsWasmOnly,
  getEngine,
  isBrowserEngineId,
  surfaceEnginePreviewChunks,
  parseEngineSettings,
  surfaceEngineSignatureParts,
  surfaceEngineVoiceLabel,
  type EngineSettings,
  type SurfaceEngineId,
} from "../models/registry";
import type { ModelType } from "../types";
import type { CreatorEngineSupport } from "../components/CreatorToolsPanel";
import { useStableCallback } from "../components/reader/useStableCallback";
import type { SynthesisChunk, SynthesisRequest } from "./engineRuntime";
import { engineSpeechLanguage, resolveSpeechPipelineSettings } from "./speechPipelineRuntime";

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
 * `saved` with the sampling settings `current` has (Audio8's seed and
 * temperature, Chatterbox's temperature and seed, Supertonic 3's seed).
 * Sampling is not part of a book's listening profile, so it is one setting
 * for both pages: putting Studio's settings back after a Reader visit keeps
 * it as it is now. Reverting it would also leave the Reader audio made with
 * it signed with a sampling the Reader no longer has, and so discarded.
 */
function withCurrentSampling(saved: AppEngineSettings, current: AppEngineSettings): AppEngineSettings {
  return {
    ...saved,
    audio8: { ...saved.audio8, seed: current.audio8.seed, temperature: current.audio8.temperature },
    chatterbox: { ...saved.chatterbox, temperature: current.chatterbox.temperature, seed: current.chatterbox.seed },
    supertonic3: { ...saved.supertonic3, seed: current.supertonic3.seed },
  };
}

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
  // Anything that replaces the Reader's audio saves it first. The Reader
  // session that knows how is created after the engines it saves for, so the
  // engines (and the router) reach it through this ref.
  const flushReaderAudioRef = useRef<() => void>(() => undefined);
  const beforeReaderAudioChange = useCallback(() => flushReaderAudioRef.current(), []);
  // The browser's Back and Forward leave a page without `handlePageNavigation`;
  // the Reader's audio is saved all the same before the next page shows.
  const handleHistoryLeave = useCallback((from: AppPage) => {
    if (from === "reader") flushReaderAudioRef.current();
  }, []);
  const { activePage, availableTabs: routeTabs, isReaderPage, isStudioPage, navigateToPage } = useAppRouting(
    enableDesktopRuntimes,
    routeBasePath,
    handleHistoryLeave,
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
    spokenText,
    audio8,
    browser,
    surfaceEngineSettings,
    desktopModelOptions,
    desktopEngineAvailability,
    retireAllAudio,
    selectBrowserModel,
    putBackBrowserModel,
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
    speech: creator.speechSettings,
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
  // A book's remembered engine, voice, quality and speed belong to the
  // Reader. The values Studio had are set aside the first time the Reader
  // changes them and put back when Studio is shown again or a book without a
  // profile is opened. That includes the browser model: both pages share it,
  // so a book that speaks with another one would otherwise change Studio's.
  const [studioGlobals, setStudioGlobals] = useState<{
    engineSettings: AppEngineSettings;
    quality: number;
    playbackRate: number;
    chosenModel: ModelType;
  } | null>(null);
  const currentPlaybackRate = player.playbackRate;
  const setAsideStudioGlobals = useCallback(() => {
    setStudioGlobals((current) => current ?? { engineSettings, quality, playbackRate: currentPlaybackRate, chosenModel });
  }, [chosenModel, currentPlaybackRate, engineSettings, quality]);
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
    setEngineSettings(withCurrentSampling(studioGlobals.engineSettings, engineSettings));
    setQuality(studioGlobals.quality);
    setPlaybackRate(studioGlobals.playbackRate);
    putBackBrowserModel(studioGlobals.chosenModel);
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
        model: studioGlobals?.chosenModel ?? chosenModel,
        text,
        quality: studioGlobals?.quality ?? quality,
        desktopModels: chosenDesktopModels,
      };
      persistAppState(persisted);
      persistEngineSettings(studioGlobals ? withCurrentSampling(studioGlobals.engineSettings, engineSettings) : engineSettings);
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

  // The script, the runtimes and the player change with every keystroke,
  // model-state tick and streamed chunk. The edit handlers read them when they
  // run, so the editors they are handed to keep one handler throughout.
  const resetAudioForTextEdit = useStableCallback(() => {
    const hasActiveAudioState = Object.values(runtimes).some((runtime) => runtime.isGenerating)
      || player.segments.length > 0
      || player.totalDuration > 0;
    if (hasActiveAudioState) {
      // Unforced: finished audio only needs clearing, and a forced cancel
      // would reload the model on the first keystroke after listening.
      retireAllAudio();
    }
  });

  const handleTextChange = useStableCallback((nextText: string) => {
    if (nextText === text) return;

    resetAudioForTextEdit();
    setText(nextText);
    setExportError(null);
    setImportError(null);
  });

  // A look-ahead render holds the engine's queue, so a generate asked for
  // while one runs first yields the engine and then waits for it to free up.
  const lookaheadControlsRef = useRef<LookaheadControls>({
    preempt: () => undefined,
    isBusy: () => false,
    settled: () => Promise.resolve(),
  });
  const {
    requestGenerate: requestReaderGenerate,
    cancelPending: cancelPendingReaderGenerate,
    waiting: readerGenerateWaiting,
  } = useGenerateAfterLookahead({
    controls: lookaheadControlsRef,
    canGenerate: readerRuntime.canGenerate,
    isGenerating: readerRuntime.isGenerating,
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
    {
      tuning: {
        ...creator.generationSettings,
        speechFingerprint: describeSpeechPipeline(resolveSpeechPipelineSettings(
          creator.speechSettings,
          engineSpeechLanguage(readerEngineId, surfaceEngineSettings),
        )),
      },
      quality,
    },
  ), [creator.generationSettings, creator.speechSettings, quality, readerEngineId, surfaceEngineSettings]);
  const clearReaderErrors = useCallback(() => {
    setExportError(null);
    setImportError(null);
  }, []);
  const reportReaderError = useCallback((message: string) => setImportError(message), []);
  // The Reader empties the shared player as it enters a section; Studio's
  // unsaved audio is set aside first and put back when Studio returns.
  const { keepStudioAudio, dropKeptStudioAudio, isPutBackStudioAudio } = useStudioAudioKeeper({
    isStudioPage,
    player,
    setShowPlayer,
  });
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
  // Qwen3's entry is all of its provider's settings, the clone reference
  // included, keyed on the fields so a download's progress changes nothing here.
  const renderReaderSection = useCallback((text: string, signal: AbortSignal) => readerSynthesize({
    text,
    settings: surfaceEngineSettings[readerEngineId],
    tuning: readerTuning,
    signal,
  } as SynthesisRequest), [readerEngineId, readerSynthesize, readerTuning, surfaceEngineSettings]);
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
    // A generate waiting for the look-ahead to yield already owns the engine.
    engineBusy: readerRuntime.isGenerating || readerGenerateWaiting,
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
  const { handleRetakeSegment: retakeBrowserSegment } = browser;
  const handleReaderRetakeSegment = useCallback((...args: Parameters<typeof retakeBrowserSegment>) => {
    preemptLookahead();
    retakeBrowserSegment(...args);
  }, [preemptLookahead, retakeBrowserSegment]);
  const { flushAudio: flushReaderAudio, generate: generateReaderSection } = readerSession;
  useEffect(() => {
    flushReaderAudioRef.current = flushReaderAudio;
  }, [flushReaderAudio]);
  // What the Reader's controls see of its runtime. The engine refuses its own
  // generation while the look-ahead renders on it, but Generate yields the
  // look-ahead first (see `useGenerateAfterLookahead`), so the controls offer
  // it all the same.
  const lookaheadHoldsReaderEngine = readerLookahead.status === "rendering"
    && !readerRuntime.canGenerate
    && !readerRuntime.isGenerating
    && readerRuntime.modelState.ready;
  const readerSurfaceRuntime = useMemo(
    () => (lookaheadHoldsReaderEngine ? { ...readerRuntime, canGenerate: true } : readerRuntime),
    [lookaheadHoldsReaderEngine, readerRuntime],
  );

  // An import started on Studio can finish after the listener has moved to
  // the Reader. The script still changes, but the player then holds the
  // Reader's audio, which is not Studio's to retire: only what was kept for
  // Studio is stale.
  const handleImportedStudioText = useCallback((nextText: string) => {
    if (!isStudioPage && dropKeptStudioAudio()) {
      setText(nextText);
      setExportError(null);
      setImportError(null);
      return;
    }
    handleTextChange(nextText);
  }, [dropKeptStudioAudio, handleTextChange, isStudioPage]);

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
    onStudioText: handleImportedStudioText,
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

  // The Voice Library sends a voice to Studio or the Reader: engine, voice and
  // settings in one step. Language only applies to the engines that have one.
  const patchVoice = useCallback((engine: AppEngineId, patch: { voice?: string; language?: string }) => {
    const accepted = engine === "supertonic" || engine === "supertonic3" ? patch : { voice: patch.voice };
    setEngineSettings((current) => ({
      ...current,
      [engine]: parseEngineSettings(engine, { ...current[engine], ...accepted }),
    }));
  }, []);
  useLibraryChatterboxClips();
  const applyVoice = useVoiceApplier({
    selectBrowserModel,
    selectDesktopModel,
    desktopEngineAvailability,
    patchVoice,
    setSpeed: creator.onSpeedChange,
    navigate: handlePageNavigation,
    qwen3: qwen3Settings,
    library: getVoiceLibraryStore(),
    resolveChatterboxVoice: async (record) => (await chatterboxClipForVoice(getVoiceLibraryStore(), record)).id,
    neuttsEnabled: preferences.showNeuTTS,
  });

  const handleJumpToSegment = useCallback((segmentId: string) => {
    if (!segmentId) return;
    jumpToSegment(segmentId);
    setShowPlayer(true);
  }, [jumpToSegment]);

  // A runtime object changes identity with its model state and progress;
  // these commands run whichever runtime the surface has when they are used.
  const handleGenerate = useStableCallback(() => {
    setExportError(null);
    studioRuntime.handleGenerate();
  });

  const handleStudioStop = useStableCallback(() => {
    studioRuntime.handleStop();
  });

  const handleStudioRetryLoad = useStableCallback(() => {
    studioRuntime.retryLoad();
  });

  // The Reader's Generate button and shortcut: generating now also drops a
  // lookup of the section's saved audio that is still running.
  const handleReaderGenerateNow = useCallback(() => {
    setExportError(null);
    generateReaderSection();
  }, [generateReaderSection]);

  const handleReaderStop = useStableCallback(() => {
    cancelPendingReaderGenerate();
    readerRuntime.handleStop();
  });

  const handleReaderRetryLoad = useStableCallback(() => {
    readerRuntime.retryLoad();
  });

  const reportExportError = useCallback((message: string) => setExportError(message), []);
  const exportFileName = useCallback(() => buildExportFileName({
    title: isReaderPage ? readerLibrary.activeDocument?.title : undefined,
    voice: surfaceEngineVoiceLabel(visibleEngineId ?? activeModel, surfaceEngineSettings),
  }), [activeModel, isReaderPage, readerLibrary.activeDocument?.title, surfaceEngineSettings, visibleEngineId]);
  const audioExport = useAudioExport({
    download: downloadPlayerAudio,
    options: creator.exportOptions,
    presetId: creator.loudnessPresetId,
    getFileName: exportFileName,
    onError: reportExportError,
    onStart: clearExportError,
  });

  const captionStyle = creator.captionStyle;
  const exportPost = creator.exportOptions.post;
  const handleDownloadCaptions = useCallback((format: "srt" | "vtt" | "json") => {
    downloadPlayerCaptions(format, captionStyle, exportPost);
  }, [captionStyle, downloadPlayerCaptions, exportPost]);

  const handleSkipBackward = useCallback(() => skipPlayback(-10), [skipPlayback]);
  const handleSkipForward = useCallback(() => skipPlayback(10), [skipPlayback]);

  const studioBackend = studioRuntime.modelState.backend;
  const creatorEngineSupport = useMemo<CreatorEngineSupport>(() => {
    const { label, capabilities } = getEngine(studioEngineId);
    const speechLanguage = engineSpeechLanguage(studioEngineId, surfaceEngineSettings);
    return {
      engineLabel: label,
      speed: capabilities.speed,
      pauses: capabilities.pauses,
      speechLanguage,
      normalization: isSpeechNormalizationSupported(speechLanguage),
      // No engine reads IPA yet; a phoneme rule speaks its alias.
      phonemes: false,
      chunkScript: (script) => surfaceEnginePreviewChunks(
        studioEngineId,
        script,
        surfaceEngineSettings,
        { backend: studioBackend, quality },
      ),
    };
  }, [quality, studioBackend, studioEngineId, surfaceEngineSettings]);

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
        ? { ...readerSurfaceRuntime, generate: handleReaderGenerateNow, stop: handleReaderStop }
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

  // The app shell reads only these, through its own context (see
  // `SynthesisSessionProvider`), so each keeps its identity until one of its
  // fields changes: the header and footer then sit out the keystrokes,
  // model-state ticks and streamed chunks that re-render the surfaces.
  const preferencesState = useMemo(
    () => ({ value: preferences, update: updatePreferences, reset: resetPreferences }),
    [preferences, resetPreferences, updatePreferences],
  );
  const appSettings = useMemo(
    () => ({ open: appSettingsOpen, onOpen: openAppSettings, onClose: closeAppSettings }),
    [appSettingsOpen, closeAppSettings, openAppSettings],
  );
  const routing = useMemo(() => ({
    activePage,
    isReaderPage,
    isStudioPage,
    routeBasePath,
    tabs: availableTabs,
    navigate: handlePageNavigation,
  }), [activePage, availableTabs, handlePageNavigation, isReaderPage, isStudioPage, routeBasePath]);
  /** What the header and footer say about the visible surface. */
  const chrome = useMemo(() => ({
    visibleError,
    showWasmBadge,
    webgpuModeNote,
    showSingleThreadedNote,
    activeModelSupportMessage,
  }), [activeModelSupportMessage, showSingleThreadedNote, showWasmBadge, visibleError, webgpuModeNote]);

  return {
    environment,
    preferences: preferencesState,
    appSettings,
    routing,
    chrome,
    player: {
      state: player,
      show: showPlayer,
      setShow: setShowPlayer,
      isPutBackStudioAudio,
      activeSegmentNumber: activeSegmentIndex >= 0 ? activeSegmentIndex + 1 : null,
      togglePlay,
      skipBackward: handleSkipBackward,
      skipForward: handleSkipForward,
      downloadAudio: audioExport.start,
      downloadCaptions: handleDownloadCaptions,
      audioExport,
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
      spokenText,
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
      runtime: readerSurfaceRuntime,
      changeModel: handleReaderModelChange,
      setPlaybackRate: handleReaderPlaybackRateChange,
      generate: handleReaderGenerateNow,
      stop: handleReaderStop,
      retryLoad: handleReaderRetryLoad,
      jumpToSegment: handleJumpToSegment,
      retakeSegment: handleReaderRetakeSegment,
      lookahead: readerLookahead,
      audiobook,
    },
    voices: { apply: applyVoice },
    documents: {
      isImporting: isImportingDocument,
      importDocument: handleImportDocument,
      importReaderFile: handleImportReaderFile,
      importReaderUrl: handleImportReaderUrl,
    },
  };
}

export type SynthesisSession = ReturnType<typeof useSynthesisSessionState>;
