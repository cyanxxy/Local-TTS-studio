import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  LocalTtsCacheInfo,
  LocalTtsAudioChunkEvent,
  LocalTtsGenerateResult,
  LocalTtsModel,
  LocalTtsProgressEvent,
  LocalTtsProbeResult,
} from "../electron";
import { LocalRuntimeModelInputs } from "./localRuntime/LocalRuntimeModelInputs";
import { LocalRuntimeRuntimeSettings } from "./localRuntime/LocalRuntimeRuntimeSettings";
import { LocalRuntimeSidebar } from "./localRuntime/LocalRuntimeSidebar";
import {
  KANI_OPTIONS,
  DEFAULT_KANI_LANGUAGE_TAG,
  DEFAULT_KANI_MAX_NEW_TOKENS,
  NEUTTS_OPTIONS,
  QWEN3_ATTENTION_OPTIONS,
  QWEN3_DEVICE_OPTIONS,
  QWEN3_DTYPE_OPTIONS,
  QWEN3_LANGUAGE_OPTIONS,
  QWEN3_OPTIONS,
  QWEN3_SPEAKER_OPTIONS,
  getQwen3LanguageOptionsForSpeaker,
  qwen3SupportsInstruct,
} from "./localRuntime/modelOptions";
import {
  arrayBufferToBase64,
  float32ChunksToWavUrl,
  getNeuttsReferenceGuidance,
  inspectAudioFile,
  isLikelyWavBuffer,
  type StatusTone,
} from "./localRuntime/utils";

interface LocalRuntimePageProps {
  model: LocalTtsModel;
  name: string;
  releaseDate: string;
  params: string;
  highlights: string[];
  links: Array<{ label: string; href: string }>;
}

type StatusMessage = { tone: StatusTone; text: string } | null;

interface ReceivedAudioChunk {
  audio: ArrayBuffer;
  sampleCount: number;
  silenceAfterSamples: number;
}

function createLocalRequestId(model: LocalTtsModel): string {
  return `${model}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createProbeRequestId(model: LocalTtsModel): string {
  return `${model}-probe-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function clampNumber(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function clampInteger(value: number, fallback: number, min: number, max: number): number {
  return Math.round(clampNumber(value, fallback, min, max));
}

const GENERATION_TIMING_LABELS: Array<[string, string]> = [
  ["modelLoadSec", "load"],
  ["referenceEncodingSec", "reference"],
  ["inferenceSec", "inference"],
  ["outputEncodingSec", "encode"],
];

function formatGenerationStatus(generated: LocalTtsGenerateResult): string {
  const timings = GENERATION_TIMING_LABELS
    .map(([key, label]) => {
      const value = generated.phaseTimingsSec[key];
      return typeof value === "number" ? `${label} ${value.toFixed(2)}s` : null;
    })
    .filter((entry): entry is string => entry !== null);
  const suffix = timings.length > 0 ? ` (${timings.join(", ")})` : "";
  return `Generated ${generated.durationSec.toFixed(2)}s audio in ${generated.elapsedSec.toFixed(2)}s${suffix}.`;
}

export function LocalRuntimePage({
  model,
  name,
  releaseDate,
  params,
  highlights,
  links,
}: LocalRuntimePageProps) {
  const [runtime, setRuntime] = useState<LocalTtsProbeResult | null>(null);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [cacheInfo, setCacheInfo] = useState<LocalTtsCacheInfo | null>(null);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [status, setStatus] = useState<StatusMessage>(null);
  const [pythonOverride, setPythonOverride] = useState("");
  const [text, setText] = useState(
    "This synthesis runs fully local on your machine through a Python runtime bridge.",
  );

  const [neuttsModel, setNeuttsModel] = useState(NEUTTS_OPTIONS[0].value);
  const [referenceText, setReferenceText] = useState("");
  const [referenceAudioName, setReferenceAudioName] = useState("");
  const [referenceAudioBase64, setReferenceAudioBase64] = useState<string | null>(null);
  const [referenceAudioGuidance, setReferenceAudioGuidance] = useState<StatusMessage>(null);

  const [kaniModel, setKaniModel] = useState(KANI_OPTIONS[0].value);
  const [languageTag, setLanguageTag] = useState(DEFAULT_KANI_LANGUAGE_TAG);
  const [temperature, setTemperature] = useState(1.0);
  const [topP, setTopP] = useState(0.95);
  const [repetitionPenalty, setRepetitionPenalty] = useState(1.1);
  const [maxNewTokens, setMaxNewTokens] = useState(DEFAULT_KANI_MAX_NEW_TOKENS);
  const [qwen3Model, setQwen3Model] = useState(QWEN3_OPTIONS[0].value);
  const [qwen3Speaker, setQwen3Speaker] = useState(QWEN3_SPEAKER_OPTIONS[0].value);
  const [qwen3Language, setQwen3Language] = useState(QWEN3_LANGUAGE_OPTIONS[0].value);
  const [qwen3Instruct, setQwen3Instruct] = useState("");
  const [qwen3DeviceMap, setQwen3DeviceMap] = useState(QWEN3_DEVICE_OPTIONS[0].value);
  const [qwen3Dtype, setQwen3Dtype] = useState(QWEN3_DTYPE_OPTIONS[0].value);
  const [qwen3Attention, setQwen3Attention] = useState(QWEN3_ATTENTION_OPTIONS[0].value);
  const [qwen3Temperature, setQwen3Temperature] = useState(0.9);
  const [qwen3TopP, setQwen3TopP] = useState(1.0);
  const [qwen3MaxNewTokens, setQwen3MaxNewTokens] = useState(2048);

  const [generateBusy, setGenerateBusy] = useState(false);
  const [generationProgress, setGenerationProgress] = useState<LocalTtsProgressEvent | null>(null);
  const [result, setResult] = useState<LocalTtsGenerateResult | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  const audioUrlRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pageVersionRef = useRef(0);
  const runtimeVersionRef = useRef(0);
  const generationVersionRef = useRef(0);
  const pythonOverrideRef = useRef("");
  const activeRequestIdRef = useRef<string | null>(null);
  const activeProbeRequestIdRef = useRef<string | null>(null);
  const activeRequestGenerationVersionRef = useRef<number | null>(null);
  const streamedAudioChunksRef = useRef<ReceivedAudioChunk[]>([]);
  const streamedAudioSampleRateRef = useRef<number | null>(null);

  const electronAvailable = !!window.electron?.localTts;
  const qwen3LanguageOptions = useMemo(
    () => getQwen3LanguageOptionsForSpeaker(qwen3Speaker),
    [qwen3Speaker],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
      }
    };
  }, []);

  const isCurrentPageVersion = useCallback((pageVersion: number) => (
    mountedRef.current && pageVersionRef.current === pageVersion
  ), []);

  const setNewAudioUrl = useCallback((nextUrl: string) => {
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
    }
    audioUrlRef.current = nextUrl;
    setAudioUrl(nextUrl);
  }, []);

  const clearGeneratedResult = useCallback(() => {
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
    streamedAudioChunksRef.current = [];
    streamedAudioSampleRateRef.current = null;
    setAudioUrl(null);
    setResult(null);
  }, []);

  const invalidateGeneration = useCallback((options: { runtimeChanged?: boolean } = {}) => {
    generationVersionRef.current += 1;
    const activeRequestId = activeRequestIdRef.current;
    if (generateBusy && activeRequestId && window.electron?.localTts) {
      void window.electron.localTts.cancel({ model, requestId: activeRequestId }).catch(() => undefined);
    }
    clearGeneratedResult();
    setGenerationProgress(null);

    if (options.runtimeChanged) {
      setRuntime(null);
      setStatus({
        tone: "info",
        text: "Runtime settings changed. Re-check the Python runtime before generating again.",
      });
    } else if (generateBusy) {
      setStatus({
        tone: "info",
        text: "Inputs changed. The current generation is now outdated.",
      });
    }
  }, [clearGeneratedResult, generateBusy, model]);

  const cancelActiveGeneration = useCallback(async (nextStatusText: string = "Cancelling generation…") => {
    const requestId = activeRequestIdRef.current;
    if (!requestId || !window.electron?.localTts) return false;

    setStatus({ tone: "info", text: nextStatusText });
    setGenerationProgress({
      requestId,
      model,
      phase: "cancelling",
      message: nextStatusText,
    });

    try {
      await window.electron.localTts.cancel({ model, requestId });
      return true;
    } catch (err) {
      if (!mountedRef.current) return false;
      setStatus({ tone: "error", text: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }, [model]);

  const refreshCacheInfo = useCallback(async (pageVersion: number = pageVersionRef.current) => {
    if (!window.electron?.localTts) return;
    const info = await window.electron.localTts.getCacheInfo({ model });
    if (!isCurrentPageVersion(pageVersion)) return;
    setCacheInfo(info);
  }, [isCurrentPageVersion, model]);

  const runProbe = useCallback(async (
    pageVersion: number = pageVersionRef.current,
    { allowRuntimeSetup = false }: { allowRuntimeSetup?: boolean } = {},
  ) => {
    if (!window.electron?.localTts) return;
    runtimeVersionRef.current += 1;
    const runtimeVersion = runtimeVersionRef.current;
    const requestId = createProbeRequestId(model);

    setRuntimeBusy(true);
    setGenerationProgress(null);
    setStatus({ tone: "info", text: "Checking local runtime…" });
    activeProbeRequestIdRef.current = requestId;
    try {
      const probe = await window.electron.localTts.probe({
        model,
        requestId,
        pythonBinary: pythonOverrideRef.current.trim() || undefined,
        allowRuntimeSetup,
      });
      if (
        !isCurrentPageVersion(pageVersion)
        || runtimeVersionRef.current !== runtimeVersion
        || activeProbeRequestIdRef.current !== requestId
      ) return;
      setRuntime(probe);
      setStatus({
        tone: probe.ready ? "success" : "error",
        text: probe.message,
      });
    } catch (err) {
      if (
        !isCurrentPageVersion(pageVersion)
        || runtimeVersionRef.current !== runtimeVersion
        || activeProbeRequestIdRef.current !== requestId
      ) return;
      setRuntime(null);
      setStatus({
        tone: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (
        isCurrentPageVersion(pageVersion)
        && runtimeVersionRef.current === runtimeVersion
        && activeProbeRequestIdRef.current === requestId
      ) {
        activeProbeRequestIdRef.current = null;
        setRuntimeBusy(false);
      }
    }
  }, [isCurrentPageVersion, model]);

  useEffect(() => {
    pageVersionRef.current += 1;
    runtimeVersionRef.current += 1;
    generationVersionRef.current += 1;
    activeRequestIdRef.current = null;
    activeProbeRequestIdRef.current = null;
    activeRequestGenerationVersionRef.current = null;
    setRuntime(null);
    setRuntimeBusy(false);
    setCacheInfo(null);
    setCacheBusy(false);
    setGenerationProgress(null);
    setStatus(null);
    setGenerateBusy(false);
    pythonOverrideRef.current = "";
    setPythonOverride("");
    clearGeneratedResult();
  }, [clearGeneratedResult, model]);

  useEffect(() => {
    if (!electronAvailable) return;
    const pageVersion = pageVersionRef.current;

    const run = async () => {
      await Promise.allSettled([runProbe(pageVersion), refreshCacheInfo(pageVersion)]);
    };

    void run();
  }, [electronAvailable, model, refreshCacheInfo, runProbe]);

  useEffect(() => {
    if (!electronAvailable || !window.electron?.localTts) return;

    return window.electron.localTts.subscribeProgress((event) => {
      if (!mountedRef.current) return;
      if (event.model !== model) return;
      if (event.requestId === activeProbeRequestIdRef.current) {
        setStatus({
          tone: "info",
          text: event.elapsedSec != null
            ? `${event.message} (${event.elapsedSec.toFixed(1)}s)`
            : event.message,
        });
        return;
      }
      if (event.requestId !== activeRequestIdRef.current) return;
      if (activeRequestGenerationVersionRef.current !== generationVersionRef.current) return;

      setGenerationProgress(event);
      setStatus({
        tone: "info",
        text: event.elapsedSec != null
          ? `${event.message} (${event.elapsedSec.toFixed(1)}s)`
          : event.message,
      });
    });
  }, [electronAvailable, model]);

  useEffect(() => {
    if (!electronAvailable || !window.electron?.localTts) return;

    return window.electron.localTts.subscribeAudioChunk((event: LocalTtsAudioChunkEvent) => {
      if (!mountedRef.current) return;
      if (event.model !== model) return;
      if (event.requestId !== activeRequestIdRef.current) return;
      if (activeRequestGenerationVersionRef.current !== generationVersionRef.current) return;
      if (event.sampleCount <= 0 || event.audio.byteLength !== event.sampleCount * Float32Array.BYTES_PER_ELEMENT) return;

      if (event.index === 0 || streamedAudioSampleRateRef.current !== event.sampleRate) {
        streamedAudioChunksRef.current = [];
        streamedAudioSampleRateRef.current = event.sampleRate;
      }

      streamedAudioChunksRef.current[event.index] = {
        audio: event.audio,
        sampleCount: event.sampleCount,
        silenceAfterSamples: event.silenceAfterSamples,
      };
      const contiguousChunks = streamedAudioChunksRef.current
        .slice(0, event.index + 1)
        .filter((chunk): chunk is ReceivedAudioChunk => !!chunk);
      if (contiguousChunks.length !== event.index + 1) return;

      if (event.index === 0 || event.index + 1 === event.total) {
        setNewAudioUrl(float32ChunksToWavUrl(contiguousChunks, event.sampleRate));
      }
      setStatus({
        tone: "info",
        text: `Received audio chunk ${event.index + 1}/${event.total}.`,
      });
    });
  }, [electronAvailable, model, setNewAudioUrl]);

  useEffect(() => () => {
    if (!window.electron?.localTts) return;
    const requestId = activeRequestIdRef.current;
    if (!requestId) return;
    void window.electron.localTts.cancel({ model, requestId }).catch(() => undefined);
    activeRequestIdRef.current = null;
    activeRequestGenerationVersionRef.current = null;
  }, [model]);

  const canGenerate = useMemo(() => {
    if (text.trim().length < 10) return false;
    if (model === "neutts") {
      return referenceText.trim().length > 0 && !!referenceAudioBase64;
    }
    return true;
  }, [model, referenceAudioBase64, referenceText, text]);

  const handleTextChange = useCallback((nextText: string) => {
    invalidateGeneration();
    setText(nextText);
  }, [invalidateGeneration]);

  const handleNeuttsModelChange = useCallback((nextModel: string) => {
    invalidateGeneration();
    setNeuttsModel(nextModel);
  }, [invalidateGeneration]);

  const handleReferenceTextChange = useCallback((nextReferenceText: string) => {
    invalidateGeneration();
    setReferenceText(nextReferenceText);
  }, [invalidateGeneration]);

  const handleKaniModelChange = useCallback((nextModel: string) => {
    invalidateGeneration();
    setKaniModel(nextModel);
  }, [invalidateGeneration]);

  const handleLanguageTagChange = useCallback((nextLanguageTag: string) => {
    invalidateGeneration();
    setLanguageTag(nextLanguageTag);
  }, [invalidateGeneration]);

  const handleTemperatureChange = useCallback((nextTemperature: number) => {
    invalidateGeneration();
    setTemperature((current) => clampNumber(nextTemperature, current, 0.2, 2));
  }, [invalidateGeneration]);

  const handleTopPChange = useCallback((nextTopP: number) => {
    invalidateGeneration();
    setTopP((current) => clampNumber(nextTopP, current, 0.5, 1));
  }, [invalidateGeneration]);

  const handleRepetitionPenaltyChange = useCallback((nextRepetitionPenalty: number) => {
    invalidateGeneration();
    setRepetitionPenalty((current) => clampNumber(nextRepetitionPenalty, current, 1, 2));
  }, [invalidateGeneration]);

  const handleMaxNewTokensChange = useCallback((nextMaxNewTokens: number) => {
    invalidateGeneration();
    setMaxNewTokens((current) => clampInteger(nextMaxNewTokens, current, 64, 4096));
  }, [invalidateGeneration]);

  const handleQwen3ModelChange = useCallback((nextModel: string) => {
    invalidateGeneration();
    setQwen3Model(nextModel);
  }, [invalidateGeneration]);

  const handleQwen3SpeakerChange = useCallback((nextSpeaker: string) => {
    invalidateGeneration();
    setQwen3Speaker(nextSpeaker);
    setQwen3Language((currentLanguage) => (
      getQwen3LanguageOptionsForSpeaker(nextSpeaker).some((option) => option.value === currentLanguage)
        ? currentLanguage
        : "Auto"
    ));
  }, [invalidateGeneration]);

  const handleQwen3LanguageChange = useCallback((nextLanguage: string) => {
    invalidateGeneration();
    setQwen3Language(nextLanguage);
  }, [invalidateGeneration]);

  const handleQwen3InstructChange = useCallback((nextInstruct: string) => {
    invalidateGeneration();
    setQwen3Instruct(nextInstruct);
  }, [invalidateGeneration]);

  const handleQwen3DeviceMapChange = useCallback((nextDeviceMap: string) => {
    invalidateGeneration();
    setQwen3DeviceMap(nextDeviceMap);
  }, [invalidateGeneration]);

  const handleQwen3DtypeChange = useCallback((nextDtype: string) => {
    invalidateGeneration();
    setQwen3Dtype(nextDtype);
  }, [invalidateGeneration]);

  const handleQwen3AttentionChange = useCallback((nextAttention: string) => {
    invalidateGeneration();
    setQwen3Attention(nextAttention);
  }, [invalidateGeneration]);

  const handleQwen3TemperatureChange = useCallback((nextTemperature: number) => {
    invalidateGeneration();
    setQwen3Temperature((current) => clampNumber(nextTemperature, current, 0.2, 2));
  }, [invalidateGeneration]);

  const handleQwen3TopPChange = useCallback((nextTopP: number) => {
    invalidateGeneration();
    setQwen3TopP((current) => clampNumber(nextTopP, current, 0.5, 1));
  }, [invalidateGeneration]);

  const handleQwen3MaxNewTokensChange = useCallback((nextMaxNewTokens: number) => {
    invalidateGeneration();
    setQwen3MaxNewTokens((current) => clampInteger(nextMaxNewTokens, current, 64, 8192));
  }, [invalidateGeneration]);

  const handlePythonOverrideChange = useCallback((nextPythonOverride: string) => {
    pythonOverrideRef.current = nextPythonOverride;
    runtimeVersionRef.current += 1;
    activeProbeRequestIdRef.current = null;
    setRuntimeBusy(false);
    invalidateGeneration({ runtimeChanged: true });
    setPythonOverride(nextPythonOverride);
  }, [invalidateGeneration]);

  const handleReferenceAudioChange = useCallback(async (file: File | null) => {
    const pageVersion = pageVersionRef.current;
    invalidateGeneration();

    if (!file) {
      if (!isCurrentPageVersion(pageVersion)) return;
      setReferenceAudioName("");
      setReferenceAudioBase64(null);
      setReferenceAudioGuidance(null);
      return;
    }

    try {
      const buffer = await file.arrayBuffer();
      if (!isLikelyWavBuffer(buffer)) {
        throw new Error("NeuTTS references should be uploaded as real .wav files. Convert MP3/M4A clips to WAV before generating.");
      }

      const guidance = getNeuttsReferenceGuidance(await inspectAudioFile(buffer));
      if (!isCurrentPageVersion(pageVersion)) return;
      setReferenceAudioBase64(arrayBufferToBase64(buffer));
      setReferenceAudioName(file.name);
      setReferenceAudioGuidance(guidance);
      setStatus({ tone: "info", text: `Loaded reference audio: ${file.name}. Enter the exact transcript of that clip before generating.` });
    } catch (err) {
      if (!isCurrentPageVersion(pageVersion)) return;
      setReferenceAudioName("");
      setReferenceAudioBase64(null);
      setReferenceAudioGuidance(null);
      setStatus({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    }
  }, [invalidateGeneration, isCurrentPageVersion]);

  const runGeneration = useCallback(async () => {
    if (!window.electron?.localTts) return;
    const pageVersion = pageVersionRef.current;
    const generationVersion = generationVersionRef.current;
    const requestId = createLocalRequestId(model);

    clearGeneratedResult();
    setGenerateBusy(true);
    setGenerationProgress({
      requestId,
      model,
      phase: "queued",
      message: "Starting local generation…",
      elapsedSec: 0,
    });
    setStatus({ tone: "info", text: "Starting local generation…" });
    activeRequestIdRef.current = requestId;
    activeRequestGenerationVersionRef.current = generationVersion;

    try {
      const payload: Record<string, unknown> = { text: text.trim() };

      if (model === "neutts") {
        payload.modelRepo = neuttsModel;
        payload.referenceText = referenceText.trim();
        payload.referenceAudioBase64 = referenceAudioBase64;
      } else if (model === "qwen3") {
        payload.modelRepo = qwen3Model;
        payload.speaker = qwen3Speaker;
        payload.language = qwen3Language;
        // Only send the style instruction when the selected model actually
        // supports it, so the request always matches the UI contract (the field
        // is disabled for unsupported models). This prevents stale text — e.g.
        // typed for one model, left behind after switching — from leaking into a
        // request where the input was greyed out.
        payload.instruct = qwen3SupportsInstruct(qwen3Model)
          ? qwen3Instruct.trim() || undefined
          : undefined;
        payload.deviceMap = qwen3DeviceMap;
        payload.dtype = qwen3Dtype;
        payload.attnImplementation = qwen3Attention;
        payload.temperature = qwen3Temperature;
        payload.topP = qwen3TopP;
        payload.maxNewTokens = qwen3MaxNewTokens;
      } else {
        payload.modelRepo = kaniModel;
        payload.languageTag = languageTag.trim() || undefined;
        payload.temperature = temperature;
        payload.topP = topP;
        payload.repetitionPenalty = repetitionPenalty;
        payload.maxNewTokens = maxNewTokens;
      }

      const generated = await window.electron.localTts.generate({
        model,
        requestId,
        pythonBinary: pythonOverride.trim() || undefined,
        payload,
      });

      if (!isCurrentPageVersion(pageVersion)) return;
      if (activeRequestIdRef.current !== requestId) return;
      if (generationVersionRef.current !== generationVersion) return;
      setResult(generated);
      const expectedChunks = generated.audioChunkCount;
      const sampleRate = streamedAudioSampleRateRef.current;
      const chunks = streamedAudioChunksRef.current.slice(0, expectedChunks);
      const completeChunks = chunks.filter((chunk): chunk is ReceivedAudioChunk => !!chunk);
      if (sampleRate == null || expectedChunks <= 0 || completeChunks.length !== expectedChunks) {
        throw new Error("Generation returned incomplete streamed audio.");
      }
      setNewAudioUrl(float32ChunksToWavUrl(completeChunks, sampleRate));
      setGenerationProgress(null);
      setStatus({
        tone: "success",
        text: formatGenerationStatus(generated),
      });
      void refreshCacheInfo(pageVersion).catch((err: unknown) => {
        console.warn("Failed to refresh local cache info:", err);
      });
    } catch (err) {
      if (!isCurrentPageVersion(pageVersion)) return;
      if (activeRequestIdRef.current !== requestId) return;
      clearGeneratedResult();
      setGenerationProgress(null);
      const message = err instanceof Error ? err.message : String(err);
      setStatus({
        tone: /cancelled/i.test(message) ? "info" : "error",
        text: message,
      });
    } finally {
      if (isCurrentPageVersion(pageVersion) && activeRequestIdRef.current === requestId) {
        activeRequestIdRef.current = null;
        activeRequestGenerationVersionRef.current = null;
        setGenerateBusy(false);
      }
    }
  }, [
    clearGeneratedResult,
    kaniModel,
    isCurrentPageVersion,
    languageTag,
    maxNewTokens,
    model,
    neuttsModel,
    pythonOverride,
    qwen3Attention,
    qwen3DeviceMap,
    qwen3Dtype,
    qwen3Instruct,
    qwen3Language,
    qwen3MaxNewTokens,
    qwen3Model,
    qwen3Speaker,
    qwen3Temperature,
    qwen3TopP,
    referenceAudioBase64,
    referenceText,
    refreshCacheInfo,
    repetitionPenalty,
    setNewAudioUrl,
    temperature,
    text,
    topP,
  ]);

  const handleClearCache = useCallback(async (): Promise<boolean> => {
    if (!window.electron?.localTts) return false;
    const pageVersion = pageVersionRef.current;
    setCacheBusy(true);
    setStatus({ tone: "info", text: "Clearing local model cache…" });

    try {
      await window.electron.localTts.clearCache({ model });
      await refreshCacheInfo(pageVersion);
      if (!isCurrentPageVersion(pageVersion)) return false;
      setStatus({ tone: "success", text: "Local model cache cleared." });
      return true;
    } catch (err) {
      if (!isCurrentPageVersion(pageVersion)) return false;
      setStatus({ tone: "error", text: err instanceof Error ? err.message : String(err) });
      return false;
    } finally {
      if (isCurrentPageVersion(pageVersion)) {
        setCacheBusy(false);
      }
    }
  }, [isCurrentPageVersion, model, refreshCacheInfo]);

  const handleRedownload = useCallback(async () => {
    const pageVersion = pageVersionRef.current;
    const cleared = await handleClearCache();
    if (!cleared) return;
    if (!isCurrentPageVersion(pageVersion)) return;
    if (!canGenerate) {
      setStatus({
        tone: "info",
        text: "Cache cleared. Provide required inputs and generate once to re-download model files.",
      });
      return;
    }
    await runGeneration();
  }, [canGenerate, handleClearCache, isCurrentPageVersion, runGeneration]);

  const busy = runtimeBusy || cacheBusy || generateBusy;
  const runtimeReady = runtime?.ready ?? false;

  return (
    <div className="mt-6 grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-5">
      <section className="flex flex-col gap-4 rounded-[22px] glass-panel p-4 transition-all duration-300 sm:p-6 lg:col-span-3">
        <div>
          <h2 className="text-xl font-display font-semibold text-text-primary">{name}</h2>
          <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-sm text-text-secondary">
            <span>Released: {releaseDate}</span>
            <span className="hidden sm:inline">•</span>
            <span>Parameters: {params}</span>
          </div>
        </div>

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Highlights</h3>
          <ul className="mt-2 space-y-1 text-sm text-text-primary">
            {highlights.map((item) => (
              <li key={item} className="leading-relaxed">{item}</li>
            ))}
          </ul>
        </div>

        <div className="space-y-2">
          <label className="block text-xs font-semibold uppercase tracking-wider text-text-secondary">
            Text
          </label>
          <textarea
            value={text}
            onChange={(event) => handleTextChange(event.target.value)}
            className="w-full min-h-32 px-3 py-2 rounded-xl border border-black/10 bg-surface/55 backdrop-blur-md text-sm text-text-primary focus:ring-1 focus:ring-accent focus:border-accent outline-none transition-all selection:bg-accent/40 selection:text-white"
            placeholder="Type or paste text to synthesize…"
          />
        </div>

        {(model === "neutts" || model === "kani" || model === "qwen3") && (
          <LocalRuntimeRuntimeSettings
            onRecheckRuntime={() => { void runProbe(pageVersionRef.current, { allowRuntimeSetup: true }); }}
            onPythonOverrideChange={handlePythonOverrideChange}
            pythonOverride={pythonOverride}
            runtime={runtime}
            runtimeBusy={runtimeBusy}
            showCompatibility={model === "neutts"}
            showEspeak={model === "neutts"}
          />
        )}

        <LocalRuntimeModelInputs
          model={model}
          neuttsModel={neuttsModel}
          onNeuttsModelChange={handleNeuttsModelChange}
          referenceText={referenceText}
          onReferenceTextChange={handleReferenceTextChange}
          referenceAudioName={referenceAudioName}
          referenceAudioGuidance={referenceAudioGuidance}
          onReferenceAudioChange={handleReferenceAudioChange}
          kaniModel={kaniModel}
          onKaniModelChange={handleKaniModelChange}
          languageTag={languageTag}
          onLanguageTagChange={handleLanguageTagChange}
          temperature={temperature}
          onTemperatureChange={handleTemperatureChange}
          topP={topP}
          onTopPChange={handleTopPChange}
          repetitionPenalty={repetitionPenalty}
          onRepetitionPenaltyChange={handleRepetitionPenaltyChange}
          maxNewTokens={maxNewTokens}
          onMaxNewTokensChange={handleMaxNewTokensChange}
          qwen3Model={qwen3Model}
          onQwen3ModelChange={handleQwen3ModelChange}
          qwen3Speaker={qwen3Speaker}
          onQwen3SpeakerChange={handleQwen3SpeakerChange}
          qwen3Language={qwen3Language}
          qwen3LanguageOptions={qwen3LanguageOptions}
          onQwen3LanguageChange={handleQwen3LanguageChange}
          qwen3Instruct={qwen3Instruct}
          onQwen3InstructChange={handleQwen3InstructChange}
          qwen3DeviceMap={qwen3DeviceMap}
          onQwen3DeviceMapChange={handleQwen3DeviceMapChange}
          qwen3Dtype={qwen3Dtype}
          onQwen3DtypeChange={handleQwen3DtypeChange}
          qwen3Attention={qwen3Attention}
          onQwen3AttentionChange={handleQwen3AttentionChange}
          qwen3Temperature={qwen3Temperature}
          onQwen3TemperatureChange={handleQwen3TemperatureChange}
          qwen3TopP={qwen3TopP}
          onQwen3TopPChange={handleQwen3TopPChange}
          qwen3MaxNewTokens={qwen3MaxNewTokens}
          onQwen3MaxNewTokensChange={handleQwen3MaxNewTokensChange}
        />

        {generateBusy && generationProgress && (
          <div className="flex flex-col gap-2 rounded-xl border border-black/10 bg-surface/55 backdrop-blur-md p-3 text-sm text-text-primary">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
                  {generationProgress.phase.replace(/_/g, " ")}
                </p>
                <p>{generationProgress.message}</p>
              </div>
              <div className="text-xs text-text-muted">
                {generationProgress.elapsedSec != null ? `${generationProgress.elapsedSec.toFixed(1)}s` : "-"}
              </div>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            onClick={runGeneration}
            disabled={!electronAvailable || !runtimeReady || !canGenerate || busy}
            className={`
              w-full rounded-xl px-5 py-2.5 text-lg font-bold transition-all duration-300 sm:w-auto
              ${!electronAvailable || !runtimeReady || !canGenerate || busy
                ? "bg-border/50 text-text-muted cursor-not-allowed backdrop-blur-sm"
                : "glass-accent text-white"
              }
            `}
          >
            {generateBusy ? "Generating…" : "Generate Locally"}
          </button>

          {generateBusy && (
            <button
              type="button"
              onClick={() => { void cancelActiveGeneration(); }}
              className="w-full rounded-xl border border-white/55 bg-white/40 backdrop-blur-md px-5 py-2.5 text-lg font-semibold text-text-primary shadow-glass-sm transition-all duration-200 hover:bg-white/60 hover:-translate-y-0.5 sm:w-auto"
            >
              Cancel
            </button>
          )}
        </div>

        {audioUrl && (
          <div className="border border-black/10 rounded-xl p-3 bg-surface/55 backdrop-blur-md">
            <p className="text-xs font-semibold uppercase tracking-wider text-text-secondary mb-2">Output Audio</p>
            <audio controls src={audioUrl} className="w-full" />
            {result && (
              <p className="text-sm mt-2 text-text-muted">
                {result.modelRepo} • {result.sampleRate} Hz • {result.durationSec.toFixed(2)}s
              </p>
            )}
          </div>
        )}

        {!electronAvailable && (
          <p className="text-xs text-danger">
            This integration runs only in the Electron desktop app because it calls local Python runtimes.
          </p>
        )}
      </section>

      <LocalRuntimeSidebar
        busy={busy}
        cacheInfo={cacheInfo}
        electronAvailable={electronAvailable}
        links={links}
        onClearCache={handleClearCache}
        onRedownload={handleRedownload}
        runtime={runtime}
        runtimeBusy={runtimeBusy}
        runtimeReady={runtimeReady}
        status={status}
      />
    </div>
  );
}
