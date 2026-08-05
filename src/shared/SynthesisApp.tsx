import { lazy, Suspense, useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Settings2 } from "lucide-react";
import type { ChunkPauseKind, GenerationStats, ModelState, ModelType } from "../types";
import { AUDIO8_VOICES, MIN_TEXT_LENGTH } from "../constants";
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
import { useReaderViewPreferences } from "../hooks/useReaderViewPreferences";
import { TextInput } from "../components/TextInput";
import { ModelToggle, type ModelToggleDesktopOption } from "../components/ModelToggle";
import { VoiceSelector } from "../components/VoiceSelector";
import { Controls } from "../components/Controls";
import { ControlsProvider } from "../components/ControlsContext";
import { AudioPlayer } from "../components/AudioPlayer";
import { DownloadProgress } from "../components/DownloadProgress";
import { SettingsPanel } from "../components/SettingsPanel";
import { CreatorToolsPanel } from "../components/CreatorToolsPanel";
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
import { isReaderLibraryShutdownError } from "../lib/readerLibrary";

type LocalRuntimePageKey = Extract<AppPage, "neutts" | "qwen3">;
type InlineModelKey = "audio8" | "qwen3" | "supertonic3";

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

const LOCAL_RUNTIME_PAGE_KEYS = ["neutts", "qwen3"] as const satisfies readonly LocalRuntimePageKey[];

// Document import pulls in Readability and a zip reader — roughly a tenth of the
// entry chunk — but is only ever reached from a user-initiated import, which is
// already asynchronous. Load it on demand instead of at startup.
const loadReaderImport = () => import("../lib/readerImport");

/** How often the Reader samples playback position to persist reading progress. */
const READER_PROGRESS_SAMPLE_MS = 750;

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

/**
 * `badge` and `detail` are optional on `ModelToggleDesktopOption`, but this
 * builder always supplies both — and it has to, because `AdvancedReaderPage`
 * redeclares the same option shape privately with both fields required. Stating
 * the guarantee here is what lets one list feed the toggle and the Reader.
 */
type DesktopModelOption = ModelToggleDesktopOption
  & Required<Pick<ModelToggleDesktopOption, "badge" | "detail">>;

interface DesktopModelOptionsInput {
  audio8Available: boolean;
  audio8Voice: string;
  supertonic3Available: boolean;
  supertonic3Language: string;
  supertonic3Voice: string;
  qwen3Available: boolean;
  qwen3ProviderDetail: string;
  selected: InlineModelKey | null;
  onSelect: (model: InlineModelKey) => void;
}

/**
 * Studio and the Reader offer the identical desktop model list; they differ
 * only in which entry is selected and where the selection is recorded.
 */
function buildDesktopModelOptions({
  audio8Available,
  audio8Voice,
  supertonic3Available,
  supertonic3Language,
  supertonic3Voice,
  qwen3Available,
  qwen3ProviderDetail,
  selected,
  onSelect,
}: DesktopModelOptionsInput): DesktopModelOption[] {
  const options: DesktopModelOption[] = [];
  if (audio8Available) {
    const selectedVoice = AUDIO8_VOICES.find((item) => item.id === audio8Voice);
    options.push({
      key: "audio8",
      label: "Audio8 TTS",
      badge: "Local",
      detail: `0.6B · ONNX INT4 · ${selectedVoice?.name ?? audio8Voice}`,
      selected: selected === "audio8",
      onSelect: () => onSelect("audio8"),
    });
  }
  if (supertonic3Available) {
    options.push({
      key: "supertonic3",
      label: "Supertonic 3",
      badge: "Electron",
      detail: `99M · ${supertonic3Language.toUpperCase()} · ${supertonic3Voice}`,
      selected: selected === "supertonic3",
      onSelect: () => onSelect("supertonic3"),
    });
  }
  if (qwen3Available) {
    options.push({
      key: "qwen3",
      label: "Qwen3-TTS",
      badge: "Electron",
      detail: qwen3ProviderDetail,
      selected: selected === "qwen3",
      onSelect: () => onSelect("qwen3"),
    });
  }
  return options;
}

/**
 * The fields every surface reads off whichever runtime is currently driving it.
 * The browser path is assembled from several hooks rather than one object, so
 * it is adapted into this shape instead of the shape being bent to fit it.
 */
interface SurfaceRuntime {
  modelState: ModelState;
  canGenerate: boolean;
  isGenerating: boolean;
  generationProgress: number;
  stats: GenerationStats;
  error: string | null;
  handleGenerate: () => void;
  handleStop: () => void;
  retryLoad: () => void;
}

function SynthesisAppContent({ enableDesktopRuntimes, routeBasePath = "", createSupertonic3Worker }: SynthesisAppProps) {
  const isElectronRuntime = Boolean(window.electron?.isElectron);
  // Every desktop-only runtime needs both halves: the entry point that opts in
  // and a live preload bridge. Studio previously gated Audio8 on the bridge
  // alone, so the two surfaces could disagree about which models exist.
  const desktopRuntimesAvailable = enableDesktopRuntimes && isElectronRuntime;
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

  /* ── Page tab indicator ───────────────────────────────────── */
  // Tab widths follow their labels and the row reflows between grid and inline
  // layouts, so the travelling pill is measured rather than computed from an
  // index. `animate` stays false until the first measurement lands, otherwise
  // the pill would slide in from the left edge on the very first paint.
  const pageTabsRef = useRef<HTMLElement>(null);
  const [pageTabIndicator, setPageTabIndicator] = useState({ left: 0, width: 0, animate: false });

  useLayoutEffect(() => {
    const nav = pageTabsRef.current;
    if (!nav) return;
    const measure = () => {
      const active = nav.querySelector<HTMLElement>("[data-page-tab][aria-current='page']");
      if (!active) return;
      setPageTabIndicator((previous) => {
        const left = active.offsetLeft;
        const width = active.offsetWidth;
        if (previous.left === left && previous.width === width) return previous;
        return { left, width, animate: previous.width > 0 };
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    for (const tab of nav.querySelectorAll("[data-page-tab]")) observer.observe(tab);
    return () => observer.disconnect();
  }, [activePage, availableTabs, isReaderPage]);

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
  const [studioDesktopModel, setStudioDesktopModel] = useState<InlineModelKey | null>(null);
  const [readerDesktopModel, setReaderDesktopModel] = useState<InlineModelKey | null>(null);
  const [supertonic3Voice, setSupertonic3Voice] = useState("M1");
  const [supertonic3Language, setSupertonic3Language] = useState("en");
  const [audio8Voice, setAudio8Voice] = useState<string>(initialState.audio8Voice);
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

  const isReaderUsingQwen3 = isReaderPage && readerDesktopModel === "qwen3";
  const isStudioUsingQwen3 = isStudioPage && studioDesktopModel === "qwen3";
  const isReaderUsingSupertonic3 = isReaderPage && readerDesktopModel === "supertonic3";
  const isStudioUsingSupertonic3 = isStudioPage && studioDesktopModel === "supertonic3";
  const isReaderUsingAudio8 = isReaderPage && readerDesktopModel === "audio8";
  const isStudioUsingAudio8 = isStudioPage && studioDesktopModel === "audio8";
  const isUsingQwen3Inline = isReaderUsingQwen3 || isStudioUsingQwen3;
  const isUsingSupertonic3Inline = isReaderUsingSupertonic3 || isStudioUsingSupertonic3;
  const isUsingAudio8Inline = isReaderUsingAudio8 || isStudioUsingAudio8;

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
    preferredSupertonicVoice: voicesByModel.supertonic,
    debugProfiling,
    supportedModels: browserSupport.supportedModels,
  });

  const player = useAudioPlayer();
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
  const audio8Runtime = useAudio8Runtime({
    active: isUsingAudio8Inline,
    text: synthesisText,
    voice: audio8Voice,
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

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const persisted: PersistedAppState = {
        model: activeModel,
        text,
        voicesByModel,
        quality,
        audio8Voice,
      };
      persistAppState(persisted);
    }, 200);

    return () => window.clearTimeout(timeoutId);
  }, [activeModel, audio8Voice, quality, text, voicesByModel]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      persistCreatorState(creator.persistedState);
    }, 200);

    return () => window.clearTimeout(timeoutId);
  }, [creator.persistedState]);

  const selectBrowserModel = useCallback((
    model: ModelType,
    currentDesktopModel: InlineModelKey | null,
    clearDesktopModel: () => void,
  ) => {
    if (!isModelSupportedInBrowser(model, browserSupport)) return;
    if (model === activeModel && currentDesktopModel === null) return;
    cancelActiveGeneration();
    audio8Runtime.cancelActiveGeneration();
    qwen3LocalRuntime.cancelActiveGeneration();
    supertonic3Runtime.cancelActiveGeneration();
    resetGeneratedAudio();
    audio8Runtime.resetGeneratedAudio();
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
    audio8Runtime,
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
      || audio8Runtime.isGenerating
      || qwen3LocalRuntime.isGenerating
      || supertonic3Runtime.isGenerating
      || isRetakingSegment
      || player.segments.length > 0
      || player.totalDuration > 0;
    if (hasActiveAudioState) {
      cancelActiveGeneration(true);
      audio8Runtime.cancelActiveGeneration();
      qwen3LocalRuntime.cancelActiveGeneration();
      supertonic3Runtime.cancelActiveGeneration();
      resetGeneratedAudio();
      audio8Runtime.resetGeneratedAudio();
      qwen3LocalRuntime.resetGeneratedAudio();
      supertonic3Runtime.resetGeneratedAudio();
    }
  }, [
    cancelActiveGeneration,
    audio8Runtime,
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

  const handleAudio8VoiceChange = useCallback((nextVoice: string) => {
    if (nextVoice === audio8Voice) return;
    if (isReaderPage) flushReaderAudioRef.current();
    audio8Runtime.cancelActiveGeneration();
    audio8Runtime.resetGeneratedAudio();
    setAudio8Voice(nextVoice);
    setExportError(null);
  }, [audio8Runtime, audio8Voice, isReaderPage]);

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

  const handlePageNavigation = useCallback((page: AppPage) => {
    if (isReaderPage && page !== "reader") flushReaderAudioRef.current();
    navigateToPage(page);
  }, [isReaderPage, navigateToPage]);

  const selectInlineDesktopModel = useCallback((
    page: InlineModelKey,
    currentDesktopModel: InlineModelKey | null,
    setDesktopModel: (model: InlineModelKey) => void,
  ) => {
    if (currentDesktopModel === page) return;
    cancelActiveGeneration();
    audio8Runtime.cancelActiveGeneration();
    qwen3LocalRuntime.cancelActiveGeneration();
    supertonic3Runtime.cancelActiveGeneration();
    resetGeneratedAudio();
    audio8Runtime.resetGeneratedAudio();
    qwen3LocalRuntime.resetGeneratedAudio();
    supertonic3Runtime.resetGeneratedAudio();
    setDesktopModel(page);
    setExportError(null);
  }, [
    audio8Runtime,
    cancelActiveGeneration,
    qwen3LocalRuntime,
    resetGeneratedAudio,
    supertonic3Runtime,
  ]);

  const handleStudioDesktopModelSelect = useCallback((page: InlineModelKey) => {
    selectInlineDesktopModel(page, studioDesktopModel, setStudioDesktopModel);
  }, [selectInlineDesktopModel, studioDesktopModel]);

  const handleReaderDesktopModelSelect = useCallback((page: InlineModelKey) => {
    flushReaderAudioRef.current();
    selectInlineDesktopModel(page, readerDesktopModel, setReaderDesktopModel);
  }, [readerDesktopModel, selectInlineDesktopModel]);

  const sharedDesktopModelOptions = useMemo(() => ({
    audio8Available: desktopRuntimesAvailable,
    audio8Voice,
    supertonic3Available,
    supertonic3Language,
    supertonic3Voice,
    qwen3Available: qwen3Settings.available,
    qwen3ProviderDetail,
  }), [audio8Voice, desktopRuntimesAvailable, qwen3ProviderDetail, qwen3Settings.available, supertonic3Available, supertonic3Language, supertonic3Voice]);

  const studioDesktopModelOptions = useMemo(() => buildDesktopModelOptions({
    ...sharedDesktopModelOptions,
    selected: studioDesktopModel,
    onSelect: handleStudioDesktopModelSelect,
  }), [handleStudioDesktopModelSelect, sharedDesktopModelOptions, studioDesktopModel]);

  const readerDesktopModelOptions = useMemo(() => buildDesktopModelOptions({
    ...sharedDesktopModelOptions,
    selected: readerDesktopModel,
    onSelect: handleReaderDesktopModelSelect,
  }), [handleReaderDesktopModelSelect, readerDesktopModel, sharedDesktopModelOptions]);

  const mountedLocalRuntimePages = useMemo(() => {
    if (!enableDesktopRuntimes || !isLocalRuntimePage(activePage)) return [];
    // Local runtime pages own model/audio buffers and an active native request.
    // Unmounting the inactive page releases those resources immediately instead
    // of retaining every runtime visited during the session.
    return [activePage];
  }, [activePage, enableDesktopRuntimes]);

  const isUsingWasmFallback = currentModelState.ready && currentModelState.backend === "wasm";

  const handleJumpToSegment = useCallback((segmentId: string) => {
    if (!segmentId) return;
    player.jumpToSegment(segmentId);
    setShowPlayer(true);
  }, [player]);

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
      speedDisabled={isUsingAudio8Inline}
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

      if (isLocalRuntimePage(activePage) || isEditableShortcutTarget(event.target)) return;

      const canTogglePlayback = player.totalDuration > 0
        && (!isStudioPage || !studioRuntime.isGenerating);
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
    readerRuntime.canGenerate,
    readerRuntime.isGenerating,
    studioRuntime.canGenerate,
    studioRuntime.isGenerating,
  ]);

  const visibleModelError = isReaderPage
    ? readerRuntime.modelState.error
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
          model: isReaderUsingAudio8
            ? "audio8"
            : isReaderUsingQwen3 ? "qwen3" : isReaderUsingSupertonic3 ? "supertonic3" : activeModel,
          voice: isReaderUsingAudio8
            ? audio8Voice
            : isReaderUsingQwen3
              ? qwenPlaybackSignature
              : isReaderUsingSupertonic3 ? `${supertonic3Voice}:${supertonic3Language}` : voice,
          quality,
          tuning: isReaderUsingAudio8
            ? { ...creator.generationSettings, speed: 1 }
            : creator.generationSettings,
        })
      : null
  ), [
    activeModel,
    activeReaderSection,
    activeReaderSectionText,
    audio8Voice,
    creator.generationSettings,
    isReaderUsingAudio8,
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
      audio8Runtime.cancelActiveGeneration();
      qwen3LocalRuntime.cancelActiveGeneration();
      supertonic3Runtime.cancelActiveGeneration();
    },
    reset: () => {
      audio8Runtime.resetGeneratedAudio();
      qwen3LocalRuntime.resetGeneratedAudio();
      supertonic3Runtime.resetGeneratedAudio();
    },
  };
  // Read at call time rather than snapshotted per render: the playback position
  // is not React state, so a render-time snapshot would go stale immediately.
  const getCurrentTime = player.getCurrentTime;
  const readerPlaybackSnapshotRef = useRef({
    playbackRate: player.playbackRate,
    totalDuration: player.totalDuration,
  });
  readerPlaybackSnapshotRef.current = {
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
      currentTime: getCurrentTime(),
      playbackRate: playback.playbackRate,
      totalDuration: playback.totalDuration,
      updatedAt,
    }).catch(reportReaderError);
  }, [
    getCurrentTime,
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
    reportReaderError,
  ]);

  const recordReaderProgress = useCallback(() => {
    if (!isReaderPage || !activeReaderDocument || !activeReaderSection) return;
    // Switching Reader documents resets the shared player before IndexedDB
    // audio has loaded. Never persist that temporary zero state over a real
    // resume point, and do not create progress from an empty transport.
    if (readerRestorePendingRef.current || player.segments.length === 0 || player.totalDuration <= 0) return;
    const currentTime = getCurrentTime();
    const now = Date.now();
    const atEnd = player.totalDuration > 0 && currentTime >= player.totalDuration;
    const isLastSection = activeReaderSectionIndex === readerSections.length - 1;
    const terminalTextOffset = isLastSection
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
                  {isStudioUsingAudio8
                    ? "Audio8 ONNX INT4 synthesis runs locally after its one-time model download."
                    : "Text to speech, entirely on your device."}
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

          {/* Page navigation. One pill travels between the tabs instead of
              blinking out of one and into the next. */}
          <nav
            ref={pageTabsRef}
            className={`${isReaderPage ? "mt-4" : "mt-6 lg:mt-8"} relative grid w-full grid-cols-2 gap-1 rounded-2xl glass p-1 sm:inline-flex sm:w-auto`}
          >
            <span
              aria-hidden
              className={`pointer-events-none absolute inset-y-1 left-0 rounded-xl bg-panel shadow-glass-sm ${
                pageTabIndicator.animate
                  ? "transition-[transform,width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
                  : ""
              } ${pageTabIndicator.width > 0 ? "opacity-100" : "opacity-0"}`}
              style={{
                transform: `translateX(${pageTabIndicator.left}px)`,
                width: pageTabIndicator.width,
              }}
            />
            {availableTabs.map((tab) => (
              <a
                key={tab.key}
                href={getPagePath(tab.key, routeBasePath)}
                data-page-tab={tab.key}
                aria-current={activePage === tab.key ? "page" : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  handlePageNavigation(tab.key);
                }}
                className={`relative z-10 rounded-xl px-5 py-2 text-center text-base font-semibold transition-colors duration-200 active:scale-[0.98] ${
                  activePage === tab.key
                    ? "text-text-primary"
                    : "text-text-muted hover:text-text-secondary"
                }`}
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

        {/* Studio and Reader swap in place. Keying the wrapper on the page
            replays the fade; the animation is opacity-only so the Reader's
            fixed player dock keeps the viewport as its containing block. */}
        <div key={activePage} className="animate-page-swap">
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
                      // `Controls` reads this for one decision only: whether to
                      // render the Supertonic quality slider. The desktop
                      // runtimes have no `ModelType` of their own, so they map
                      // onto whichever browser model wants the same control —
                      // Supertonic 3 exposes quality, Audio8 and Qwen3 do not.
                      activeModel: isStudioUsingQwen3 || isStudioUsingAudio8
                        ? "kokoro"
                        : isStudioUsingSupertonic3
                          ? "supertonic"
                          : activeModel,
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
              estimatedWordTrackingStable={!isReaderUsingQwen3 || !readerRuntime.isGenerating}
              desktopVoiceLabel={isReaderUsingAudio8
                ? AUDIO8_VOICES.find((item) => item.id === audio8Voice)?.name ?? audio8Voice
                : isReaderUsingQwen3
                ? qwen3Settings.profile.mode === "customVoice"
                  ? qwen3Settings.speaker.replace(/_/g, " ")
                  : qwenModeDetail
                : isReaderUsingSupertonic3 ? supertonic3Voice : undefined}
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
              onTogglePlay={player.togglePlay}
              onSeek={player.seek}
              onSkipBackward={() => player.skip(-10)}
              onSkipForward={() => player.skip(10)}
              onDownload={handleDownloadAudio}
              isRetaking={isReaderUsingAudio8 || isReaderUsingQwen3 || isReaderUsingSupertonic3 ? false : isRetakingSegment}
              onRetakeSegment={handleRetakeSegment}
              canRetakeSegments={!isReaderUsingAudio8 && !isReaderUsingQwen3 && !isReaderUsingSupertonic3}
              onJumpToSegment={handleJumpToSegment}
            />
            </Suspense>
          ) : browserSupportPanel
        ) : null}
        </div>

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

        {/* Footer */}
        {!isReaderPage && (
          <footer className="mt-16 border-t border-border/40 pt-5">
            {isStudioPage && localInferenceSupported && !browserSupport.message ? (
              <div className="flex items-center flex-wrap gap-1.5">
                {/* The badges name the runtimes this build ships, not the one
                    that happens to be selected, so Audio8 is listed on the
                    same terms as Kokoro and Supertonic wherever it exists. */}
                {["Kokoro", "Supertonic", "WebGPU · CPU", ...(desktopRuntimesAvailable ? ["Audio8 · Native CPU"] : [])].map((label) => (
                  <span
                    key={label}
                    className="px-2.5 py-1 rounded-full border border-white/50 bg-white/40 backdrop-blur-sm font-mono text-xs text-text-muted/70"
                  >
                    {label}
                  </span>
                ))}
                <span className="flex items-center gap-1.5 rounded-full border border-success/25 bg-success/[0.07] px-2.5 py-1 font-mono text-xs text-success/80 backdrop-blur-sm">
                  <span
                    className="h-1 w-1 animate-pulse rounded-full bg-success opacity-80"
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
