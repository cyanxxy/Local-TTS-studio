import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Settings2 } from "lucide-react";
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
import { Qwen3RuntimeProvider, useQwen3Runtime } from "../contexts/Qwen3RuntimeContext";
import { Qwen3InlineSettings } from "../components/Qwen3InlineSettings";
import { Supertonic3InlineSettings } from "../components/Supertonic3InlineSettings";
import { useReaderLibrary } from "../hooks/useReaderLibrary";
import { useReaderViewPreferences } from "../hooks/useReaderViewPreferences";
import { TextInput } from "../components/TextInput";
import { ModelToggle } from "../components/ModelToggle";
import { VoiceSelector } from "../components/VoiceSelector";
import { Controls } from "../components/Controls";
import { ControlsProvider } from "../components/ControlsContext";
import { AudioPlayer } from "../components/AudioPlayer";
import { DownloadProgress } from "../components/DownloadProgress";
import { SettingsPanel } from "../components/SettingsPanel";
import { AppSettingsDialog } from "../components/AppSettingsDialog";
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
  hasPrimaryShortcutModifier,
  isEditableShortcutTarget,
  isMacPlatform,
} from "../lib/appShortcuts";
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
  buildReaderSections,
  buildAudioSignature,
  chapterAtOffset,
  createReaderAudioCacheKey,
  getCachedReaderAudioByteLength,
  getReaderSectionText,
  normalizeReaderTextFragment,
  readerSectionAtOffset,
  type ReaderDocumentRecord,
  type ReaderSection,
} from "../lib/readerDocument";
import {
  fetchRemoteDocument,
  importReaderFile,
  parseEpubDocument,
  parseHtmlReaderDocument,
} from "../lib/readerImport";

type LocalRuntimePageKey = Extract<AppPage, "neutts" | "qwen3">;
type InlineDesktopModelKey = "qwen3" | "supertonic3";

interface SynthesisAppProps {
  enableDesktopRuntimes: boolean;
  routeBasePath?: string;
  createSupertonic3Worker?: () => Worker;
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
    name: "NeuTTS Nano / Air (Neuphonic)",
    releaseDate: "February 12, 2026",
    params: "Nano ~0.2B / Air ~0.7B",
    highlights: [
      "CPU-friendly speech with instant voice cloning from short references.",
      "Nano variants for English, German, French, and Spanish.",
      "Air Q4 and Q8 add richer English prosody and higher naturalness.",
      "Runs on the Rust bridge with GGUF models and .npy reference codes.",
    ],
    links: [
      { label: "HF Model", href: "https://huggingface.co/neuphonic/neutts-nano" },
      { label: "HF Collection", href: "https://huggingface.co/collections/neuphonic/neutts-nano-multilingual-collection" },
      { label: "HF Air Q4", href: "https://huggingface.co/neuphonic/neutts-air-q4-gguf" },
      { label: "HF Air Q8", href: "https://huggingface.co/neuphonic/neutts-air-q8-gguf" },
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
      "VoiceDesign 1.7B creates a voice from a natural-language description.",
      "Runs on the resident Rust bridge — these models ship as local runtime formats, not browser ONNX.",
    ],
    links: [
      { label: "MLX CustomVoice 0.6B", href: "https://huggingface.co/mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit" },
      { label: "MLX CustomVoice 1.7B", href: "https://huggingface.co/mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-6bit" },
      { label: "MLX Base 0.6B", href: "https://huggingface.co/mlx-community/Qwen3-TTS-12Hz-0.6B-Base-6bit" },
      { label: "MLX VoiceDesign 1.7B", href: "https://huggingface.co/mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-6bit" },
      { label: "HF 0.6B", href: "https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice" },
      { label: "HF 1.7B", href: "https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice" },
      { label: "HF VoiceDesign 1.7B", href: "https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign" },
      { label: "HF Tokenizer", href: "https://huggingface.co/Qwen/Qwen3-TTS-Tokenizer-12Hz" },
      { label: "GitHub", href: "https://github.com/QwenLM/Qwen3-TTS" },
    ],
  },
};

function isLocalRuntimePage(page: AppPage): page is LocalRuntimePageKey {
  return (LOCAL_RUNTIME_PAGE_KEYS as readonly AppPage[]).includes(page);
}

function SynthesisAppContent({ enableDesktopRuntimes, routeBasePath = "", createSupertonic3Worker }: SynthesisAppProps) {
  const isElectronRuntime = Boolean(window.electron?.isElectron);
  const { preferences, updatePreferences, resetPreferences } = useAppPreferences();
  const [appSettingsOpen, setAppSettingsOpen] = useState(false);
  const qwen3Settings = useQwen3Runtime();
  const qwenModeDetail = qwen3Settings.profile.mode === "customVoice"
    ? qwen3Settings.speaker
    : qwen3Settings.profile.mode === "voiceDesign"
      ? "VoiceDesign"
      : "Voice clone";
  const qwen3ProviderDetail = `${qwen3Settings.profile.parameters} ${qwenModeDetail} · ${qwen3Settings.profile.provider === "mlx" ? "Apple MLX" : "LibTorch"}`;
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
  const [readerDesktopModel, setReaderDesktopModel] = useState<InlineDesktopModelKey | null>(null);
  const [supertonic3Voice, setSupertonic3Voice] = useState("M1");
  const [supertonic3Language, setSupertonic3Language] = useState("en");
  const [visitedLocalRuntimePages, setVisitedLocalRuntimePages] = useState<Set<LocalRuntimePageKey>>(
    () => (enableDesktopRuntimes && isLocalRuntimePage(activePage) ? new Set([activePage]) : new Set()),
  );
  const readerLibrary = useReaderLibrary(initialState.text);
  const {
    preferences: readerViewPreferences,
    updatePreferences: updateReaderViewPreferences,
  } = useReaderViewPreferences();
  const activeReaderDocument = readerLibrary.activeDocument;
  const activeReaderDocumentId = activeReaderDocument?.id ?? null;
  const readerSectionsCacheRef = useRef<{
    documentId: string;
    text: string;
    chapters: ReaderDocumentRecord["chapters"];
    sections: ReaderSection[];
  } | null>(null);
  const readerSections = useMemo(() => {
    if (!activeReaderDocument) return [];
    const cached = readerSectionsCacheRef.current;
    if (
      cached?.documentId === activeReaderDocument.id
      && cached.text === activeReaderDocument.text
      && cached.chapters === activeReaderDocument.chapters
    ) return cached.sections;
    const sections = buildReaderSections(activeReaderDocument.text, activeReaderDocument.chapters);
    readerSectionsCacheRef.current = {
      documentId: activeReaderDocument.id,
      text: activeReaderDocument.text,
      chapters: activeReaderDocument.chapters,
      sections,
    };
    return sections;
  }, [activeReaderDocument]);
  const activeReaderSection = useMemo(() => {
    if (!activeReaderDocument) return null;
    return readerSections.find((section) => section.id === activeReaderDocument.progress.sectionId)
      ?? readerSectionAtOffset(readerSections, activeReaderDocument.progress.textOffset);
  }, [activeReaderDocument, readerSections]);
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
  const activeReaderChapter = useMemo(() => {
    if (!activeReaderDocument || !activeReaderSection) return null;
    return activeReaderDocument.chapters.find((chapter) => chapter.id === activeReaderSection.chapterId)
      ?? chapterAtOffset(activeReaderDocument.chapters, activeReaderSection.start);
  }, [activeReaderDocument, activeReaderSection]);
  const activeReaderSectionIndex = activeReaderSection
    ? readerSections.findIndex((section) => section.id === activeReaderSection.id)
    : -1;
  const previousReaderSection = activeReaderSectionIndex > 0
    ? readerSections[activeReaderSectionIndex - 1]
    : null;
  const nextReaderSection = activeReaderSectionIndex >= 0
    ? readerSections[activeReaderSectionIndex + 1] ?? null
    : null;
  const activeReaderSectionText = activeReaderDocument
    ? getReaderSectionText(activeReaderDocument.text, activeReaderSection)
    : "";
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

  const closeAppSettings = useCallback(() => setAppSettingsOpen(false), []);

  useEffect(() => {
    if (activePage === "neutts" && !preferences.showNeuTTS) {
      navigateToPage("studio");
    }
  }, [activePage, navigateToPage, preferences.showNeuTTS]);

  useEffect(() => {
    if (qwen3Settings.available) return;
    setStudioDesktopModel((current) => current === "qwen3" ? null : current);
    setReaderDesktopModel((current) => current === "qwen3" ? null : current);
    if (activePage === "qwen3") navigateToPage("studio");
  }, [activePage, navigateToPage, qwen3Settings.available]);

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
  const isReaderUsingSupertonic3 = isReaderPage && readerDesktopModel === "supertonic3";
  const isStudioUsingSupertonic3 = isStudioPage && studioDesktopModel === "supertonic3";
  const isUsingQwen3Inline = isReaderUsingQwen3 || isStudioUsingQwen3;
  const isUsingSupertonic3Inline = isReaderUsingSupertonic3 || isStudioUsingSupertonic3;
  // The SHA-256 is calculated asynchronously from the selected file once.
  // Avoid re-scanning a potentially 60 MB Base64 string on the render thread.
  const qwenReferenceAudioSignature = qwen3Settings.profile.mode === "voiceClone"
    ? qwen3Settings.referenceAudioSignature
    : "";
  const qwenPlaybackSignature = useMemo(() => JSON.stringify({
    repo: qwen3Settings.profile.repo,
    revision: qwen3Settings.profile.revision,
    mode: qwen3Settings.profile.mode,
    speaker: qwen3Settings.profile.mode === "customVoice" ? qwen3Settings.speaker : null,
    language: qwen3Settings.language,
    instruct: qwen3Settings.profile.mode !== "voiceClone" ? qwen3Settings.instruct : null,
    temperature: qwen3Settings.temperature,
    topK: qwen3Settings.topK,
    maxNewTokens: qwen3Settings.maxNewTokens,
    referenceAudio: qwenReferenceAudioSignature,
    referenceText: qwen3Settings.profile.mode === "voiceClone"
      ? qwen3Settings.referenceText.trim()
      : null,
  }), [
    qwen3Settings.instruct,
    qwen3Settings.language,
    qwen3Settings.maxNewTokens,
    qwen3Settings.profile.mode,
    qwen3Settings.profile.repo,
    qwen3Settings.profile.revision,
    qwen3Settings.referenceText,
    qwen3Settings.speaker,
    qwen3Settings.temperature,
    qwen3Settings.topK,
    qwenReferenceAudioSignature,
  ]);
  const qwen3LocalRuntime = useQwen3LocalRuntime({
    enabled: enableDesktopRuntimes && isElectronRuntime && qwen3Settings.available && isUsingQwen3Inline,
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
    && hasMinimumSynthesisText(synthesisText, MIN_TEXT_LENGTH)
    && currentModelState.ready;

  const creator = useCreatorSettings({
    initialState: initialCreatorState,
    quality,
  });
  // The desktop entry owns this capability by supplying the worker factory.
  // Do not also gate it on the preload bridge: Supertonic 3 runs entirely in
  // the renderer worker, and a delayed/stale preload must not hide the model.
  const supertonic3Available = enableDesktopRuntimes
    && typeof createSupertonic3Worker === "function";
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
    supertonic3Runtime.cancelActiveGeneration();
    resetGeneratedAudio();
    qwen3LocalRuntime.resetGeneratedAudio();
    supertonic3Runtime.resetGeneratedAudio();
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
    supertonic3Runtime,
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
      || qwen3LocalRuntime.isGenerating
      || supertonic3Runtime.isGenerating
      || isRetakingSegment
      || player.segments.length > 0
      || player.totalDuration > 0;
    if (hasActiveAudioState) {
      cancelActiveGeneration(true);
      qwen3LocalRuntime.cancelActiveGeneration();
      supertonic3Runtime.cancelActiveGeneration();
      resetGeneratedAudio();
      qwen3LocalRuntime.resetGeneratedAudio();
      supertonic3Runtime.resetGeneratedAudio();
    }
  }, [
    cancelActiveGeneration,
    isRetakingSegment,
    player.segments.length,
    player.totalDuration,
    qwen3LocalRuntime,
    resetGeneratedAudio,
    supertonic3Runtime,
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

  const handleVoiceChange = useCallback((nextVoice: string) => {
    if (nextVoice === voice) return;
    if (isReaderPage) flushReaderAudioRef.current();
    cancelActiveGeneration();
    resetGeneratedAudio();
    setVoicesByModel((prev) => ({ ...prev, [activeModel]: nextVoice }));
    setExportError(null);
  }, [activeModel, cancelActiveGeneration, isReaderPage, resetGeneratedAudio, voice]);

  const handleSupertonic3VoiceChange = useCallback((nextVoice: string) => {
    if (nextVoice === supertonic3Voice) return;
    if (isReaderPage) flushReaderAudioRef.current();
    supertonic3Runtime.cancelActiveGeneration();
    supertonic3Runtime.resetGeneratedAudio();
    setSupertonic3Voice(nextVoice);
    setExportError(null);
  }, [isReaderPage, supertonic3Runtime, supertonic3Voice]);

  const handleSupertonic3LanguageChange = useCallback((nextLanguage: string) => {
    if (nextLanguage === supertonic3Language) return;
    if (isReaderPage) flushReaderAudioRef.current();
    supertonic3Runtime.cancelActiveGeneration();
    supertonic3Runtime.resetGeneratedAudio();
    setSupertonic3Language(nextLanguage);
    setExportError(null);
  }, [isReaderPage, supertonic3Language, supertonic3Runtime]);

  const handleQualityChange = useCallback((nextQuality: number) => {
    if (nextQuality === quality) return;
    if (isReaderPage) flushReaderAudioRef.current();
    cancelActiveGeneration();
    resetGeneratedAudio();
    setQuality(nextQuality);
    setExportError(null);
  }, [cancelActiveGeneration, isReaderPage, quality, resetGeneratedAudio]);

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
    if (isReaderPage && page !== "reader") flushReaderAudioRef.current();
    if (enableDesktopRuntimes && isLocalRuntimePage(activePage)) {
      rememberLocalRuntimePage(activePage);
    }
    if (enableDesktopRuntimes && isLocalRuntimePage(page)) {
      rememberLocalRuntimePage(page);
    }
    navigateToPage(page);
  }, [activePage, enableDesktopRuntimes, isReaderPage, navigateToPage, rememberLocalRuntimePage]);

  const selectInlineDesktopModel = useCallback((
    page: InlineDesktopModelKey,
    currentDesktopModel: InlineDesktopModelKey | null,
    setDesktopModel: (model: InlineDesktopModelKey) => void,
  ) => {
    if (currentDesktopModel === page) return;
    cancelActiveGeneration();
    qwen3LocalRuntime.cancelActiveGeneration();
    supertonic3Runtime.cancelActiveGeneration();
    resetGeneratedAudio();
    qwen3LocalRuntime.resetGeneratedAudio();
    supertonic3Runtime.resetGeneratedAudio();
    setDesktopModel(page);
    setExportError(null);
  }, [
    cancelActiveGeneration,
    qwen3LocalRuntime,
    resetGeneratedAudio,
    supertonic3Runtime,
  ]);

  const handleStudioDesktopModelSelect = useCallback((page: InlineDesktopModelKey) => {
    selectInlineDesktopModel(page, studioDesktopModel, setStudioDesktopModel);
  }, [selectInlineDesktopModel, studioDesktopModel]);

  const handleReaderDesktopModelSelect = useCallback((page: InlineDesktopModelKey) => {
    flushReaderAudioRef.current();
    selectInlineDesktopModel(page, readerDesktopModel, setReaderDesktopModel);
  }, [readerDesktopModel, selectInlineDesktopModel]);

  const studioDesktopModelOptions = useMemo(() => {
    const options = [];
    if (supertonic3Available) {
      options.push({
        key: "supertonic3",
        label: "Supertonic 3",
        badge: "Electron",
        detail: `99M · ${supertonic3Language.toUpperCase()} · ${supertonic3Voice}`,
        selected: studioDesktopModel === "supertonic3",
        onSelect: () => handleStudioDesktopModelSelect("supertonic3"),
      });
    }
    if (qwen3Settings.available) {
      options.push({
          key: "qwen3",
          label: "Qwen3-TTS",
          badge: "Electron",
          detail: qwen3ProviderDetail,
          selected: studioDesktopModel === "qwen3",
          onSelect: () => handleStudioDesktopModelSelect("qwen3"),
      });
    }
    return options;
  }, [handleStudioDesktopModelSelect, qwen3ProviderDetail, qwen3Settings.available, studioDesktopModel, supertonic3Available, supertonic3Language, supertonic3Voice]);

  const readerDesktopModelOptions = useMemo(() => {
    const options = [];
    if (supertonic3Available) {
      options.push({
        key: "supertonic3",
        label: "Supertonic 3",
        badge: "Electron",
        detail: `99M · ${supertonic3Language.toUpperCase()} · ${supertonic3Voice}`,
        selected: readerDesktopModel === "supertonic3",
        onSelect: () => handleReaderDesktopModelSelect("supertonic3"),
      });
    }
    if (qwen3Settings.available) {
      options.push({
          key: "qwen3",
          label: "Qwen3-TTS",
          badge: "Electron",
          detail: qwen3ProviderDetail,
          selected: readerDesktopModel === "qwen3",
          onSelect: () => handleReaderDesktopModelSelect("qwen3"),
      });
    }
    return options;
  }, [handleReaderDesktopModelSelect, qwen3ProviderDetail, qwen3Settings.available, readerDesktopModel, supertonic3Available, supertonic3Language, supertonic3Voice]);

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
    if (isStudioUsingSupertonic3) {
      supertonic3Runtime.handleGenerate();
      return;
    }
    runBrowserGeneration();
  }, [isStudioUsingQwen3, isStudioUsingSupertonic3, qwen3LocalRuntime, runBrowserGeneration, supertonic3Runtime]);

  const handleStudioStop = useCallback(() => {
    if (isStudioUsingQwen3) {
      qwen3LocalRuntime.handleStop();
      return;
    }
    if (isStudioUsingSupertonic3) {
      supertonic3Runtime.handleStop();
      return;
    }
    handleStop();
  }, [handleStop, isStudioUsingQwen3, isStudioUsingSupertonic3, qwen3LocalRuntime, supertonic3Runtime]);

  const handleStudioRetryLoad = useCallback(() => {
    if (isStudioUsingQwen3) {
      qwen3LocalRuntime.retryLoad();
      return;
    }
    if (isStudioUsingSupertonic3) {
      supertonic3Runtime.retryLoad();
      return;
    }
    handleRetryActiveModelLoad();
  }, [handleRetryActiveModelLoad, isStudioUsingQwen3, isStudioUsingSupertonic3, qwen3LocalRuntime, supertonic3Runtime]);

  const handleReaderGenerate = useCallback(() => {
    setExportError(null);
    if (isReaderUsingQwen3) {
      qwen3LocalRuntime.handleGenerate();
      return;
    }
    if (isReaderUsingSupertonic3) {
      supertonic3Runtime.handleGenerate();
      return;
    }
    runBrowserGeneration();
  }, [isReaderUsingQwen3, isReaderUsingSupertonic3, qwen3LocalRuntime, runBrowserGeneration, supertonic3Runtime]);

  const handleReaderStop = useCallback(() => {
    if (isReaderUsingQwen3) {
      qwen3LocalRuntime.handleStop();
      return;
    }
    if (isReaderUsingSupertonic3) {
      supertonic3Runtime.handleStop();
      return;
    }
    handleStop();
  }, [handleStop, isReaderUsingQwen3, isReaderUsingSupertonic3, qwen3LocalRuntime, supertonic3Runtime]);

  const handleReaderRetryLoad = useCallback(() => {
    if (isReaderUsingQwen3) {
      qwen3LocalRuntime.retryLoad();
      return;
    }
    if (isReaderUsingSupertonic3) {
      supertonic3Runtime.retryLoad();
      return;
    }
    handleRetryActiveModelLoad();
  }, [handleRetryActiveModelLoad, isReaderUsingQwen3, isReaderUsingSupertonic3, qwen3LocalRuntime, supertonic3Runtime]);

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
    && !isUsingQwen3Inline
    && ((webgpuStatus !== null && !webgpuStatus.available)
      || (isUsingSupertonic3Inline ? supertonic3Runtime.modelState.backend === "wasm" : isUsingWasmFallback));
  const webgpuModeNote = showWasmBadge
    ? webgpuStatus?.message ?? null
    : null;
  const showSingleThreadedNote = showWasmBadge && !window.crossOriginIsolated;
  const activeModelSupportMessage = getUnsupportedModelMessage(activeModel, browserSupport);
  const studioModelState = isStudioUsingQwen3
    ? qwen3LocalRuntime.modelState
    : isStudioUsingSupertonic3 ? supertonic3Runtime.modelState : currentModelState;
  const studioCanGenerate = isStudioUsingQwen3
    ? qwen3LocalRuntime.canGenerate
    : isStudioUsingSupertonic3 ? supertonic3Runtime.canGenerate : canGenerate;
  const studioGenerationBusy = isStudioUsingQwen3
    ? qwen3LocalRuntime.isGenerating
    : isStudioUsingSupertonic3 ? supertonic3Runtime.isGenerating : isGenerationBusy;
  const studioGenerationProgress = isStudioUsingQwen3
    ? qwen3LocalRuntime.generationProgress
    : isStudioUsingSupertonic3 ? supertonic3Runtime.generationProgress : tts.generationProgress;
  const studioStats = isStudioUsingQwen3
    ? qwen3LocalRuntime.stats
    : isStudioUsingSupertonic3 ? supertonic3Runtime.stats : tts.stats;
  const studioVisibleError = isStudioUsingQwen3
    ? qwen3LocalRuntime.error
    : isStudioUsingSupertonic3 ? supertonic3Runtime.error : (tts.error ?? retakeError);
  const readerModelState = isReaderUsingQwen3
    ? qwen3LocalRuntime.modelState
    : isReaderUsingSupertonic3 ? supertonic3Runtime.modelState : currentModelState;
  const readerCanGenerate = isReaderUsingQwen3
    ? qwen3LocalRuntime.canGenerate
    : isReaderUsingSupertonic3 ? supertonic3Runtime.canGenerate : canGenerate;
  const readerGenerationBusy = isReaderUsingQwen3
    ? qwen3LocalRuntime.isGenerating
    : isReaderUsingSupertonic3 ? supertonic3Runtime.isGenerating : isGenerationBusy;
  const readerGenerationProgress = isReaderUsingQwen3
    ? qwen3LocalRuntime.generationProgress
    : isReaderUsingSupertonic3 ? supertonic3Runtime.generationProgress : tts.generationProgress;
  const readerStats = isReaderUsingQwen3
    ? qwen3LocalRuntime.stats
    : isReaderUsingSupertonic3 ? supertonic3Runtime.stats : tts.stats;
  const readerVisibleError = isReaderUsingQwen3
    ? qwen3LocalRuntime.error
    : isReaderUsingSupertonic3 ? supertonic3Runtime.error : (tts.error ?? retakeError);

  useEffect(() => {
    const handleAppShortcut = (event: KeyboardEvent) => {
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
        if (isStudioPage && studioCanGenerate && !studioGenerationBusy) {
          event.preventDefault();
          handleGenerate();
        } else if (isReaderPage && readerCanGenerate && !readerGenerationBusy) {
          event.preventDefault();
          handleReaderGenerate();
        }
        return;
      }

      if (primaryModifier && event.key === ".") {
        if (isStudioPage && studioGenerationBusy) {
          event.preventDefault();
          handleStudioStop();
        } else if (isReaderPage && readerGenerationBusy) {
          event.preventDefault();
          handleReaderStop();
        }
        return;
      }

      if (isLocalRuntimePage(activePage) || isEditableShortcutTarget(event.target)) return;

      const canTogglePlayback = player.totalDuration > 0
        && (!isStudioPage || !studioGenerationBusy);
      if (!primaryModifier && !event.altKey && event.code === "Space" && canTogglePlayback) {
        event.preventDefault();
        void player.togglePlay();
        return;
      }

      if (!primaryModifier && event.altKey && player.totalDuration > 0) {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          player.skip(-10);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          player.skip(10);
        }
      }
    };

    document.addEventListener("keydown", handleAppShortcut);
    return () => document.removeEventListener("keydown", handleAppShortcut);
  }, [
    activePage,
    appSettingsOpen,
    handleGenerate,
    handlePageNavigation,
    handleReaderGenerate,
    handleReaderStop,
    handleStudioStop,
    isReaderPage,
    isStudioPage,
    player,
    readerCanGenerate,
    readerGenerationBusy,
    studioCanGenerate,
    studioGenerationBusy,
  ]);

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
  const readerRestorePendingRef = useRef(false);
  const readerRestoreVersionRef = useRef(0);
  const readerAudioSaveVersionRef = useRef(0);
  const activeReaderDocumentRef = useRef(activeReaderDocument);
  activeReaderDocumentRef.current = activeReaderDocument;
  const loadReaderAudio = readerLibrary.loadAudio;
  const saveReaderAudio = readerLibrary.saveAudio;
  const clearReaderAudio = readerLibrary.clearAudio;
  const updateReaderProgress = readerLibrary.updateProgress;
  const restoreReaderAudio = player.restoreAudioCache;
  const getReaderAudioSnapshot = player.getAudioCacheSnapshot;
  const readerAudioActionsRef = useRef({
    cancel: cancelActiveGeneration,
    clear: clearReaderAudio,
    load: loadReaderAudio,
    reset: resetGeneratedAudio,
    restore: restoreReaderAudio,
  });
  readerAudioActionsRef.current = {
    cancel: cancelActiveGeneration,
    clear: clearReaderAudio,
    load: loadReaderAudio,
    reset: resetGeneratedAudio,
    restore: restoreReaderAudio,
  };
  // Signatures are section-local: editing one passage or moving chapter
  // boundaries does not invalidate hours of unrelated generated audio.
  const activeReaderAudioSignature = useMemo(() => (
    activeReaderSection
      ? buildAudioSignature({
          text: activeReaderSectionText,
          model: isReaderUsingQwen3 ? "qwen3" : isReaderUsingSupertonic3 ? "supertonic3" : activeModel,
          voice: isReaderUsingQwen3
            ? qwenPlaybackSignature
            : isReaderUsingSupertonic3 ? `${supertonic3Voice}:${supertonic3Language}` : voice,
          quality,
          tuning: creator.generationSettings,
        })
      : null
  ), [
    activeModel,
    activeReaderSection,
    activeReaderSectionText,
    creator.generationSettings,
    isReaderUsingQwen3,
    isReaderUsingSupertonic3,
    quality,
    qwenPlaybackSignature,
    supertonic3Language,
    supertonic3Voice,
    voice,
  ]);
  const activeReaderAudioSignatureRef = useRef(activeReaderAudioSignature);
  activeReaderAudioSignatureRef.current = activeReaderAudioSignature;
  const desktopReaderControlsRef = useRef({
    cancel: qwen3LocalRuntime.cancelActiveGeneration,
    reset: qwen3LocalRuntime.resetGeneratedAudio,
  });
  desktopReaderControlsRef.current = {
    cancel: () => {
      qwen3LocalRuntime.cancelActiveGeneration();
      supertonic3Runtime.cancelActiveGeneration();
    },
    reset: () => {
      qwen3LocalRuntime.resetGeneratedAudio();
      supertonic3Runtime.resetGeneratedAudio();
    },
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
  const readerGenerateRef = useRef(handleReaderGenerate);
  readerGenerateRef.current = handleReaderGenerate;
  const readerTogglePlayRef = useRef(player.togglePlay);
  readerTogglePlayRef.current = player.togglePlay;

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

    const playback = readerPlaybackSnapshotRef.current;
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
      currentTime: playback.currentTime,
      playbackRate: playback.playbackRate,
      totalDuration: playback.totalDuration,
      updatedAt,
    }).catch((cause) => setImportError(cause instanceof Error ? cause.message : String(cause)));
  }, [
    getReaderAudioSnapshot,
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

    readerAudioActionsRef.current.cancel(true);
    desktopReaderControlsRef.current.cancel();
    readerAudioActionsRef.current.reset();
    desktopReaderControlsRef.current.reset();
    setExportError(null);
    setImportError(null);

    const restore = async () => {
      try {
        const cache = await readerAudioActionsRef.current.load(document.id, section.id);
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
          readerAudioActionsRef.current.restore(cache.chunks, {
            // A saved 0 is meaningful (the user stopped or rewound).
            currentTime: Math.max(0, Math.min(maximumTime, preferredTime)),
            playbackRate: cache.playbackRate,
          });
          setShowPlayer(cache.chunks.length > 0);
          if (continuation?.autoPlay && cache.chunks.length > 0) {
            window.setTimeout(() => readerTogglePlayRef.current(), 0);
          }
        } else {
          if (cache) void readerAudioActionsRef.current.clear(document.id, section.id);
          if (continuation?.autoGenerate) {
            window.setTimeout(() => readerGenerateRef.current(), 0);
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
      if (!cancelled) setImportError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      cancelled = true;
      readerRestorePendingRef.current = false;
    };
  }, [
    activeReaderDocumentId,
    activeReaderSection?.id,
    isReaderPage,
  ]);

  useEffect(() => {
    if (!isReaderPage || !activeReaderDocument || !activeReaderSection) return;
    // Switching Reader documents resets the shared player before IndexedDB
    // audio has loaded. Never persist that temporary zero state over a real
    // resume point, and do not create progress from an empty transport.
    if (readerRestorePendingRef.current || player.segments.length === 0 || player.totalDuration <= 0) return;
    const now = Date.now();
    const atEnd = player.totalDuration > 0 && player.currentTime >= player.totalDuration;
    const isLastSection = activeReaderSectionIndex === readerSections.length - 1;
    const terminalTextOffset = isLastSection
      ? activeReaderDocument.text.length
      : Math.max(activeReaderSection.start, activeReaderSection.end - 1);
    if (atEnd && activeReaderDocument.progress.textOffset >= terminalTextOffset) return;
    if (!atEnd && now - lastReaderProgressUpdateRef.current < 750) return;
    lastReaderProgressUpdateRef.current = now;

    const segment = player.segments.find((entry) => entry.id === player.activeSegmentId);
    let textOffset = activeReaderDocument.progress.textOffset;
    if (segment && typeof segment.textStart === "number" && typeof segment.textEnd === "number") {
      const duration = Math.max(0.001, segment.endSec - segment.startSec);
      const ratio = Math.max(0, Math.min(1, (player.currentTime - segment.startSec) / duration));
      const localOffset = segment.textStart + (segment.textEnd - segment.textStart) * ratio;
      textOffset = activeReaderSection.start + localOffset;
    }
    if (atEnd) textOffset = terminalTextOffset;
    else textOffset = Math.max(activeReaderSection.start, Math.min(terminalTextOffset, textOffset));
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
    activeReaderSection,
    activeReaderSectionIndex,
    readerSections.length,
    updateReaderProgress,
  ]);

  const autoAdvancedSectionRef = useRef<string | null>(null);
  useEffect(() => {
    autoAdvancedSectionRef.current = null;
  }, [activeReaderSection?.id]);

  useEffect(() => {
    if (
      !isReaderPage
      || !readerViewPreferences.autoAdvance
      || !activeReaderSection
      || !nextReaderSection
      || readerRestorePendingRef.current
      || readerGenerationBusy
      || player.isPlaying
      || player.segments.length === 0
      || player.totalDuration <= 0
      || player.currentTime < player.totalDuration - 0.02
      || autoAdvancedSectionRef.current === activeReaderSection.id
    ) return;
    autoAdvancedSectionRef.current = activeReaderSection.id;
    navigateReaderToOffset(nextReaderSection.start, 0, { autoPlay: true, autoGenerate: true });
  }, [
    activeReaderSection,
    isReaderPage,
    navigateReaderToOffset,
    nextReaderSection,
    player.currentTime,
    player.isPlaying,
    player.segments.length,
    player.totalDuration,
    readerGenerationBusy,
    readerViewPreferences.autoAdvance,
  ]);

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
      <div className={`app-page ${isReaderPage ? "w-full px-3 py-3 sm:px-4 sm:py-4 md:px-6 md:py-6" : "w-full px-4 py-6 sm:px-6 sm:py-8 md:px-8 md:py-6 lg:py-10"}`}>

        {/* Header */}
        <header className={isReaderPage ? "mb-4" : "mb-8 lg:mb-10"}>
          <div className={`flex flex-nowrap justify-between gap-2 sm:gap-4 ${isReaderPage ? "items-center" : "items-start"}`}>
            <div className="min-w-0 flex-1">
              <h1
                className={`${isReaderPage ? "text-3xl sm:text-4xl" : "text-[2.5rem] sm:text-6xl"} whitespace-nowrap font-display leading-none font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-br from-text-primary to-accent/70`}
              >
                Open TTS
              </h1>
              {!isReaderPage && (
                <p className="mt-3 text-base font-medium tracking-wide text-text-secondary sm:text-lg">
                  Text to speech, entirely on your device.
                </p>
              )}
            </div>

            <div className="mt-1 flex shrink-0 items-start gap-2">
              {showWasmBadge && (
                <div className="flex flex-col items-end gap-1">
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
              <button
                type="button"
                onClick={() => setAppSettingsOpen(true)}
                aria-label="Open app settings"
                title={`Settings (${isMacPlatform(window.electron?.platform ?? navigator.platform) ? "⌘," : "Ctrl+,"})`}
                className="glass-control no-drag flex h-10 w-10 items-center justify-center rounded-xl text-text-muted hover:text-accent"
              >
                <Settings2 size={18} />
              </button>
            </div>
          </div>

          {/* Page navigation */}
          <nav className={`${isReaderPage ? "mt-4" : "mt-6 lg:mt-8"} grid w-full grid-cols-2 gap-1 rounded-2xl glass p-1 sm:inline-flex sm:w-auto`}>
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
            <DownloadProgress
              kokoroState={kokoroState}
              supertonicState={supertonicState}
              supertonic3State={isStudioUsingSupertonic3 ? supertonic3Runtime.modelState : undefined}
            />

            <div className="mt-6 glass-panel rounded-[24px]">
              <div className="grid grid-cols-1 md:grid-cols-5">
                {/* Left: text input */}
                <div className="flex min-h-[320px] flex-col border-border/40 p-4 sm:min-h-[360px] sm:p-6 md:col-span-3 md:border-r">
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

                  {!isStudioUsingQwen3 && !isStudioUsingSupertonic3 && (
                    <VoiceSelector
                      activeModel={activeModel}
                      voice={voice}
                      onVoiceChange={handleVoiceChange}
                      kokoroVoices={kokoroVoices}
                    />
                  )}

                  <ControlsProvider
                    value={{
                      activeModel: isStudioUsingQwen3
                        ? "kokoro"
                        : isStudioUsingSupertonic3 ? "supertonic" : activeModel,
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

            {!isStudioUsingQwen3 && !isStudioUsingSupertonic3 && (
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
              totalSectionCount={readerSections.length}
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
              desktopVoiceLabel={isReaderUsingQwen3
                ? qwen3Settings.profile.mode === "customVoice"
                  ? qwen3Settings.speaker.replace(/_/g, " ")
                  : qwenModeDetail
                : isReaderUsingSupertonic3 ? supertonic3Voice : undefined}
              desktopModelSettings={isReaderUsingQwen3
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
              isRetaking={isReaderUsingQwen3 || isReaderUsingSupertonic3 ? false : isRetakingSegment}
              onRetakeSegment={handleRetakeSegment}
              canRetakeSegments={!isReaderUsingQwen3 && !isReaderUsingSupertonic3}
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
                active={isActive}
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
      <AppSettingsDialog
        open={appSettingsOpen}
        desktopModelsAvailable={enableDesktopRuntimes && isElectronRuntime}
        preferences={preferences}
        onChange={updatePreferences}
        onReset={resetPreferences}
        onClose={closeAppSettings}
      />
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
