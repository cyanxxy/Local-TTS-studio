import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  LocalTtsCacheInfo,
  LocalTtsAudioChunkEvent,
  LocalTtsGenerateResult,
  LocalTtsModel,
  LocalTtsProgressEvent,
  LocalTtsProbeResult,
  LocalTtsQwen3MlxDownloadProgress,
  LocalTtsQwen3MlxSetup,
} from "../electron";
import type { GenerationStats } from "../types";
import { useAudioPlayer } from "../hooks/useAudioPlayer";
import { scheduleNextUiFrame } from "../lib/uiScheduling";
import { AudioPlayer } from "./AudioPlayer";
import { LocalRuntimeModelInputs } from "./localRuntime/LocalRuntimeModelInputs";
import { LocalRuntimeRuntimeSettings } from "./localRuntime/LocalRuntimeRuntimeSettings";
import { LocalRuntimeSidebar } from "./localRuntime/LocalRuntimeSidebar";
import {
  NEUTTS_OPTIONS,
  QWEN3_ATTENTION_OPTIONS,
  QWEN3_DEFAULT_MAX_NEW_TOKENS,
  QWEN3_DEVICE_OPTIONS,
  QWEN3_DTYPE_OPTIONS,
  QWEN3_LANGUAGE_OPTIONS,
  QWEN3_SPEAKER_OPTIONS,
  getDefaultQwen3Model,
  getQwen3LanguageOptionsForSpeaker,
  qwen3SupportsInstruct,
  qwen3UsesMlx,
  qwen3UsesMlxCustomVoice,
  qwen3UsesVoiceClone,
} from "./localRuntime/modelOptions";
import {
  arrayBufferToBase64,
  float32ChunksToWavUrl,
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

function buildPlaybackSamples(chunk: ReceivedAudioChunk): Float32Array {
  const samples = new Float32Array(chunk.audio, 0, chunk.sampleCount);
  const silenceAfterSamples = Math.max(0, chunk.silenceAfterSamples);
  const output = new Float32Array(samples.length + silenceAfterSamples);
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index];
    output[index] = Number.isFinite(value) ? value : 0;
  }
  return output;
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
  ["firstAudioSec", "first audio"],
  ["inferenceSec", "inference"],
  ["outputEncodingSec", "encode"],
  ["transportEncodingSec", "transport"],
];

function formatGenerationStatus(generated: LocalTtsGenerateResult): string {
  const timings = GENERATION_TIMING_LABELS
    .map(([key, label]) => {
      const value = generated.phaseTimingsSec[key];
      return typeof value === "number" ? `${label} ${value.toFixed(2)}s` : null;
    })
    .filter((entry): entry is string => entry !== null);
  const suffix = timings.length > 0 ? ` (${timings.join(", ")})` : "";
  const device = generated.device ? ` on ${generated.device}` : "";
  const warning = generated.warnings?.[0] ? ` ${generated.warnings[0]}` : "";
  return `Generated ${generated.durationSec.toFixed(2)}s audio${device} in ${generated.elapsedSec.toFixed(2)}s${suffix}.${warning}`;
}

function formatStartingGenerationStatus({
  model,
  qwen3MlxCustomVoice,
  qwen3VoiceClone,
  qwen3DeviceMap,
  qwen3Dtype,
  qwen3Attention,
  qwen3MaxNewTokens,
}: {
  model: LocalTtsModel;
  qwen3MlxCustomVoice: boolean;
  qwen3VoiceClone: boolean;
  qwen3DeviceMap: string;
  qwen3Dtype: string;
  qwen3Attention: string;
  qwen3MaxNewTokens: number;
}): string {
  if (model !== "qwen3") return "Starting local generation...";
  if (qwen3MlxCustomVoice) return "Starting Qwen3 CustomVoice MLX on mlx.";
  const backend = qwen3VoiceClone
    ? "Qwen3 Base MLX voice clone"
    : "Qwen3 CustomVoice";
  const device = qwen3VoiceClone
    ? "mlx"
    : qwen3DeviceMap === "auto"
      ? "auto device"
      : qwen3DeviceMap;
  return `Starting ${backend} on ${device} (${qwen3Dtype}, ${qwen3Attention}, max ${qwen3MaxNewTokens}).`;
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
  const [text, setText] = useState(
    "Everything you hear is generated right here on this machine.",
  );

  const [neuttsModel, setNeuttsModel] = useState(NEUTTS_OPTIONS[0].value);
  const [referenceText, setReferenceText] = useState("");
  const [referenceAudioName, setReferenceAudioName] = useState("");
  const [referenceCodesBase64, setReferenceCodesBase64] = useState<string | null>(null);
  const [referenceWavBase64, setReferenceWavBase64] = useState<string | null>(null);
  const [referenceAudioGuidance, setReferenceAudioGuidance] = useState<StatusMessage>(null);

  const [qwen3Model, setQwen3Model] = useState(() => getDefaultQwen3Model(window.electron?.platform));
  const [qwen3BaseModelPath, setQwen3BaseModelPath] = useState("");
  const [qwen3MlxSetup, setQwen3MlxSetup] = useState<LocalTtsQwen3MlxSetup | null>(null);
  const [qwen3MlxSetupBusy, setQwen3MlxSetupBusy] = useState(false);
  const [qwen3MlxDownloadBusy, setQwen3MlxDownloadBusy] = useState(false);
  const [qwen3MlxDownloadProgress, setQwen3MlxDownloadProgress] = useState<LocalTtsQwen3MlxDownloadProgress | null>(null);
  const [qwen3ReferenceAudioName, setQwen3ReferenceAudioName] = useState("");
  const [qwen3ReferenceAudioBase64, setQwen3ReferenceAudioBase64] = useState<string | null>(null);
  const [qwen3ReferenceAudioGuidance, setQwen3ReferenceAudioGuidance] = useState<StatusMessage>(null);
  const [qwen3ReferenceText, setQwen3ReferenceText] = useState("");
  const [qwen3Speaker, setQwen3Speaker] = useState(QWEN3_SPEAKER_OPTIONS[0].value);
  const [qwen3Language, setQwen3Language] = useState(QWEN3_LANGUAGE_OPTIONS[0].value);
  const [qwen3Instruct, setQwen3Instruct] = useState("");
  const [qwen3DeviceMap, setQwen3DeviceMap] = useState(QWEN3_DEVICE_OPTIONS[0].value);
  const [qwen3Dtype, setQwen3Dtype] = useState(QWEN3_DTYPE_OPTIONS[0].value);
  const [qwen3Attention, setQwen3Attention] = useState(QWEN3_ATTENTION_OPTIONS[0].value);
  const [qwen3Temperature, setQwen3Temperature] = useState(0.9);
  const [qwen3TopK, setQwen3TopK] = useState(50);
  const [qwen3TopP, setQwen3TopP] = useState(1.0);
  const [qwen3MaxNewTokens, setQwen3MaxNewTokens] = useState(QWEN3_DEFAULT_MAX_NEW_TOKENS);

  const [generateBusy, setGenerateBusy] = useState(false);
  const [generationProgress, setGenerationProgress] = useState<LocalTtsProgressEvent | null>(null);
  const [result, setResult] = useState<LocalTtsGenerateResult | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  const audioUrlRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pageVersionRef = useRef(0);
  const runtimeVersionRef = useRef(0);
  const generationVersionRef = useRef(0);
  const activeRequestIdRef = useRef<string | null>(null);
  const activeProbeRequestIdRef = useRef<string | null>(null);
  const activeRequestGenerationVersionRef = useRef<number | null>(null);
  const streamedAudioChunksRef = useRef<ReceivedAudioChunk[]>([]);
  const streamedAudioSampleRateRef = useRef<number | null>(null);
  const scheduledAudioChunkCountRef = useRef(0);
  const pendingGenerationProgressRef = useRef<LocalTtsProgressEvent | null>(null);
  const generationProgressFlushCancelRef = useRef<(() => void) | null>(null);
  const audioPlayer = useAudioPlayer();
  const {
    beginStream: beginAudioStream,
    download: downloadAudio,
    endStream: endAudioStream,
    reset: resetAudioPlayer,
    scheduleChunk: scheduleAudioChunk,
    stopAll: stopAudioPlayer,
  } = audioPlayer;

  const electronAvailable = !!window.electron?.localTts;
  const qwen3LanguageOptions = useMemo(
    () => getQwen3LanguageOptionsForSpeaker(qwen3Speaker),
    [qwen3Speaker],
  );
  const qwen3VoiceClone = qwen3UsesVoiceClone(qwen3Model);
  const qwen3MlxCustomVoice = qwen3UsesMlxCustomVoice(qwen3Model);
  const qwen3Mlx = qwen3UsesMlx(qwen3Model);

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
    scheduledAudioChunkCountRef.current = 0;
    resetAudioPlayer();
    setAudioUrl(null);
    setResult(null);
  }, [resetAudioPlayer]);

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
        text: "Runtime settings changed. Re-check the Rust runtime before generating again.",
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

    stopAudioPlayer();
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
  }, [model, stopAudioPlayer]);

  const refreshCacheInfo = useCallback(async (pageVersion: number = pageVersionRef.current) => {
    if (!window.electron?.localTts) return;
    const info = await window.electron.localTts.getCacheInfo({ model });
    if (!isCurrentPageVersion(pageVersion)) return;
    setCacheInfo(info);
  }, [isCurrentPageVersion, model]);

  const refreshQwen3MlxSetup = useCallback(async (pageVersion: number = pageVersionRef.current) => {
    if (model !== "qwen3" || !window.electron?.localTts?.getQwen3MlxSetup) return;
    setQwen3MlxSetupBusy(true);
    try {
      const setup = await window.electron.localTts.getQwen3MlxSetup();
      if (!isCurrentPageVersion(pageVersion)) return;
      setQwen3MlxSetup(setup);
      setQwen3BaseModelPath((current) => (
        current.trim().length === 0 && qwen3UsesMlx(qwen3Model) && setup.modelDirLooksReady
          && qwen3Model === setup.recommendedModelRepo
          ? setup.recommendedModelDir
          : current
      ));
    } catch (err) {
      if (!isCurrentPageVersion(pageVersion)) return;
      setStatus({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      if (isCurrentPageVersion(pageVersion)) {
        setQwen3MlxSetupBusy(false);
      }
    }
  }, [isCurrentPageVersion, model, qwen3Model]);

  const runProbe = useCallback(async (pageVersion: number = pageVersionRef.current) => {
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
    setQwen3MlxSetup(null);
    setQwen3MlxSetupBusy(false);
    setQwen3MlxDownloadBusy(false);
    setQwen3MlxDownloadProgress(null);
    setGenerationProgress(null);
    setStatus(null);
    setGenerateBusy(false);
    clearGeneratedResult();
  }, [clearGeneratedResult, model]);

  useEffect(() => {
    if (!electronAvailable) return;
    const pageVersion = pageVersionRef.current;

    const run = async () => {
      await Promise.allSettled([
        runProbe(pageVersion),
        refreshCacheInfo(pageVersion),
        refreshQwen3MlxSetup(pageVersion),
      ]);
    };

    void run();
  }, [electronAvailable, model, refreshCacheInfo, refreshQwen3MlxSetup, runProbe]);

  // Pre-warm the resident Qwen3 MLX api_server as soon as the fast path is
  // usable (binary found + model directory chosen), so the first generation
  // skips the model load. Best-effort: failures are ignored and the bridge
  // worker is reused by the next generation either way.
  const warmedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (model !== "qwen3" || !electronAvailable) return;
    if (!qwen3MlxCustomVoice || generateBusy) return;
    if (!(qwen3MlxSetup?.apiServerAvailable ?? false)) return;
    const baseModelPath = qwen3BaseModelPath.trim();
    if (!baseModelPath) return;
    const warmKey = `${qwen3Model}:${baseModelPath}`;
    if (warmedKeyRef.current === warmKey) return;
    warmedKeyRef.current = warmKey;
    void window.electron?.localTts?.warm?.({ model, baseModelPath }).catch(() => undefined);
  }, [electronAvailable, generateBusy, model, qwen3BaseModelPath, qwen3MlxCustomVoice, qwen3MlxSetup, qwen3Model]);

  useEffect(() => {
    if (!electronAvailable || !window.electron?.localTts) return;

    return window.electron.localTts.subscribeQwen3MlxDownloadProgress?.((event) => {
      if (!mountedRef.current) return;
      if (model !== "qwen3") return;
      setQwen3MlxDownloadProgress(event);
      const downloadedMb = (event.downloadedBytes / (1024 * 1024)).toFixed(1);
      const totalMb = event.totalBytes ? `/${(event.totalBytes / (1024 * 1024)).toFixed(1)} MB` : " MB";
      setStatus({
        tone: "info",
        text: `Downloading ${event.fileName} (${event.fileIndex}/${event.totalFiles}) ${downloadedMb}${totalMb}.`,
      });
    });
  }, [electronAvailable, model]);

  useEffect(() => {
    if (!electronAvailable || !window.electron?.localTts) return;

    const flushGenerationProgress = () => {
      const event = pendingGenerationProgressRef.current;
      if (!event) return;
      pendingGenerationProgressRef.current = null;
      setGenerationProgress(event);
      setStatus({
        tone: "info",
        text: event.elapsedSec != null
          ? `${event.message} (${event.elapsedSec.toFixed(1)}s)`
          : event.message,
      });
    };

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

      pendingGenerationProgressRef.current = event;
      generationProgressFlushCancelRef.current?.();
      generationProgressFlushCancelRef.current = scheduleNextUiFrame(flushGenerationProgress);
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

      const sampleRate = streamedAudioSampleRateRef.current ?? event.sampleRate;
      const displayTotal = event.total > 0 ? event.total : event.index + 1;
      while (scheduledAudioChunkCountRef.current < contiguousChunks.length) {
        const chunkIndex = scheduledAudioChunkCountRef.current;
        const chunk = contiguousChunks[chunkIndex];
        scheduledAudioChunkCountRef.current += 1;
        void scheduleAudioChunk({
          audio: buildPlaybackSamples(chunk),
          samplingRate: sampleRate,
          text: `${name} chunk ${chunkIndex + 1}`,
          index: chunkIndex + 1,
          total: displayTotal,
          pauseAfterSec: chunk.silenceAfterSamples / sampleRate,
        }).catch((err: unknown) => {
          if (!mountedRef.current) return;
          setStatus({ tone: "error", text: err instanceof Error ? err.message : String(err) });
        });
      }

      if (event.total > 0 && event.index + 1 === event.total) {
        setNewAudioUrl(float32ChunksToWavUrl(contiguousChunks, event.sampleRate));
      }
      setStatus({
        tone: "info",
        text: event.total > 0
          ? `Received audio chunk ${event.index + 1}/${event.total}.`
          : `Received streaming audio chunk ${event.index + 1}.`,
      });
    });
  }, [electronAvailable, model, name, scheduleAudioChunk, setNewAudioUrl]);

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
      return referenceText.trim().length > 0 && (!!referenceCodesBase64 || !!referenceWavBase64);
    }
    if (model === "qwen3" && qwen3VoiceClone) {
      return qwen3BaseModelPath.trim().length > 0
        && qwen3ReferenceText.trim().length > 0
        && !!qwen3ReferenceAudioBase64
        && (qwen3MlxSetup?.workerAvailable ?? false);
    }
    if (model === "qwen3" && qwen3MlxCustomVoice) {
      return qwen3BaseModelPath.trim().length > 0
        && ((qwen3MlxSetup?.apiServerAvailable ?? false) || (qwen3MlxSetup?.ttsAvailable ?? false));
    }
    return true;
  }, [
    model,
    qwen3BaseModelPath,
    qwen3MlxCustomVoice,
    qwen3MlxSetup,
    qwen3ReferenceAudioBase64,
    qwen3ReferenceText,
    qwen3VoiceClone,
    referenceCodesBase64,
    referenceWavBase64,
    referenceText,
    text,
  ]);

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

  const handleQwen3ModelChange = useCallback((nextModel: string) => {
    invalidateGeneration();
    const previousWasMlx = qwen3UsesMlx(qwen3Model);
    const nextIsMlx = qwen3UsesMlx(nextModel);
    if (
      previousWasMlx
      && nextIsMlx
      && qwen3MlxSetup?.recommendedModelDir
      && qwen3BaseModelPath.trim() === qwen3MlxSetup.recommendedModelDir
    ) {
      setQwen3BaseModelPath("");
    }
    setQwen3Model(nextModel);
  }, [invalidateGeneration, qwen3BaseModelPath, qwen3MlxSetup, qwen3Model]);

  const handleQwen3BaseModelPathChange = useCallback((nextPath: string) => {
    invalidateGeneration();
    setQwen3BaseModelPath(nextPath);
  }, [invalidateGeneration]);

  const handleQwen3ChooseBaseModelPath = useCallback(async () => {
    if (!window.electron?.localTts?.chooseQwen3MlxModelDir) return;
    try {
      const result = await window.electron.localTts.chooseQwen3MlxModelDir();
      if (!result.path) return;
      invalidateGeneration();
      setQwen3BaseModelPath(result.path);
      setStatus({ tone: "success", text: "Qwen3 MLX model directory selected." });
    } catch (err) {
      setStatus({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    }
  }, [invalidateGeneration]);

  const handleQwen3DownloadMlxModel = useCallback(async () => {
    if (!window.electron?.localTts?.downloadQwen3MlxModel) return;
    const pageVersion = pageVersionRef.current;
    invalidateGeneration();
    setQwen3MlxDownloadBusy(true);
    setQwen3MlxDownloadProgress(null);
    setStatus({ tone: "info", text: `Downloading ${qwen3Model} into the app model cache…` });
    try {
      const result = await window.electron.localTts.downloadQwen3MlxModel({ modelRepo: qwen3Model });
      if (!isCurrentPageVersion(pageVersion)) return;
      setQwen3BaseModelPath(result.modelDir);
      await refreshQwen3MlxSetup(pageVersion);
      if (!isCurrentPageVersion(pageVersion)) return;
      setStatus({
        tone: result.modelDirLooksReady ? "success" : "error",
        text: result.modelDirLooksReady
          ? `Downloaded ${result.modelRepo} to ${result.modelDir}.`
          : `Downloaded ${result.modelRepo}, but the model directory is still missing required files.`,
      });
    } catch (err) {
      if (!isCurrentPageVersion(pageVersion)) return;
      setStatus({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      if (isCurrentPageVersion(pageVersion)) {
        setQwen3MlxDownloadBusy(false);
      }
    }
  }, [invalidateGeneration, isCurrentPageVersion, qwen3Model, refreshQwen3MlxSetup]);

  const handleQwen3ReferenceTextChange = useCallback((nextReferenceText: string) => {
    invalidateGeneration();
    setQwen3ReferenceText(nextReferenceText);
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

  const handleQwen3TopKChange = useCallback((nextTopK: number) => {
    invalidateGeneration();
    setQwen3TopK((current) => clampInteger(nextTopK, current, 0, 1000));
  }, [invalidateGeneration]);

  const handleQwen3TopPChange = useCallback((nextTopP: number) => {
    invalidateGeneration();
    setQwen3TopP((current) => clampNumber(nextTopP, current, 0.5, 1));
  }, [invalidateGeneration]);

  const handleQwen3MaxNewTokensChange = useCallback((nextMaxNewTokens: number) => {
    invalidateGeneration();
    setQwen3MaxNewTokens((current) => clampInteger(nextMaxNewTokens, current, 64, 8192));
  }, [invalidateGeneration]);

  const handleReferenceAudioChange = useCallback(async (file: File | null) => {
    const pageVersion = pageVersionRef.current;
    invalidateGeneration();

    if (!file) {
      if (!isCurrentPageVersion(pageVersion)) return;
      setReferenceAudioName("");
      setReferenceCodesBase64(null);
      setReferenceWavBase64(null);
      setReferenceAudioGuidance(null);
      return;
    }

    try {
      const buffer = await file.arrayBuffer();
      const lowerName = file.name.toLowerCase();
      if (!lowerName.endsWith(".npy") && !lowerName.endsWith(".wav")) {
        throw new Error("NeuTTS references must be a WAV clip or pre-encoded .npy code file.");
      }

      if (!isCurrentPageVersion(pageVersion)) return;
      if (lowerName.endsWith(".npy")) {
        setReferenceCodesBase64(arrayBufferToBase64(buffer));
        setReferenceWavBase64(null);
        setReferenceAudioGuidance({ tone: "success", text: "Reference code file loaded." });
        setStatus({ tone: "info", text: `Loaded reference codes: ${file.name}. Enter the matching transcript before generating.` });
      } else {
        setReferenceWavBase64(arrayBufferToBase64(buffer));
        setReferenceCodesBase64(null);
        setReferenceAudioGuidance({ tone: "success", text: "Reference WAV loaded." });
        setStatus({ tone: "info", text: `Loaded reference WAV: ${file.name}. Enter the matching transcript before generating.` });
      }
      setReferenceAudioName(file.name);
    } catch (err) {
      if (!isCurrentPageVersion(pageVersion)) return;
      setReferenceAudioName("");
      setReferenceCodesBase64(null);
      setReferenceWavBase64(null);
      setReferenceAudioGuidance(null);
      setStatus({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    }
  }, [invalidateGeneration, isCurrentPageVersion]);

  const handleQwen3ReferenceAudioChange = useCallback(async (file: File | null) => {
    const pageVersion = pageVersionRef.current;
    invalidateGeneration();

    if (!file) {
      if (!isCurrentPageVersion(pageVersion)) return;
      setQwen3ReferenceAudioName("");
      setQwen3ReferenceAudioBase64(null);
      setQwen3ReferenceAudioGuidance(null);
      return;
    }

    try {
      if (!file.name.toLowerCase().endsWith(".wav")) {
        throw new Error("Qwen3 Base voice cloning requires a WAV reference file.");
      }
      const buffer = await file.arrayBuffer();
      if (!isCurrentPageVersion(pageVersion)) return;
      setQwen3ReferenceAudioBase64(arrayBufferToBase64(buffer));
      setQwen3ReferenceAudioName(file.name);
      setQwen3ReferenceAudioGuidance({ tone: "success", text: "Reference WAV loaded." });
      setStatus({ tone: "info", text: `Loaded Qwen3 reference WAV: ${file.name}. Enter its exact transcript before generating.` });
    } catch (err) {
      if (!isCurrentPageVersion(pageVersion)) return;
      setQwen3ReferenceAudioName("");
      setQwen3ReferenceAudioBase64(null);
      setQwen3ReferenceAudioGuidance(null);
      setStatus({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    }
  }, [invalidateGeneration, isCurrentPageVersion]);

  const runGeneration = useCallback(async () => {
    if (!window.electron?.localTts) return;
    const pageVersion = pageVersionRef.current;
    const generationVersion = generationVersionRef.current;
    const requestId = createLocalRequestId(model);

    clearGeneratedResult();
    beginAudioStream();
    setGenerateBusy(true);
    const startingStatus = formatStartingGenerationStatus({
      model,
      qwen3MlxCustomVoice,
      qwen3VoiceClone,
      qwen3DeviceMap,
      qwen3Dtype,
      qwen3Attention,
      qwen3MaxNewTokens,
    });
    setGenerationProgress({
      requestId,
      model,
      phase: "queued",
      message: startingStatus,
      elapsedSec: 0,
    });
    setStatus({ tone: "info", text: startingStatus });
    activeRequestIdRef.current = requestId;
    activeRequestGenerationVersionRef.current = generationVersion;

    try {
      const payload: Record<string, unknown> = { text: text.trim() };

      if (model === "neutts") {
        payload.modelRepo = neuttsModel;
        payload.referenceText = referenceText.trim();
        if (referenceCodesBase64) {
          payload.referenceCodesBase64 = referenceCodesBase64;
        } else if (referenceWavBase64) {
          payload.referenceAudioBase64 = referenceWavBase64;
        }
      } else if (model === "qwen3") {
        payload.modelRepo = qwen3Model;
        payload.mode = qwen3VoiceClone ? "voiceClone" : "customVoice";
        if (qwen3Mlx) {
          payload.baseModelPath = qwen3BaseModelPath.trim();
        }
        if (qwen3VoiceClone) {
          payload.referenceAudioBase64 = qwen3ReferenceAudioBase64;
          payload.referenceAudioName = qwen3ReferenceAudioName;
          payload.referenceText = qwen3ReferenceText.trim();
        }
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
        payload.topK = qwen3TopK;
        payload.topP = qwen3TopP;
        payload.maxNewTokens = qwen3MaxNewTokens;
      }

      const generated = await window.electron.localTts.generate({
        model,
        requestId,
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
      endAudioStream();
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
      endAudioStream();
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
    beginAudioStream,
    endAudioStream,
    isCurrentPageVersion,
    model,
    neuttsModel,
    qwen3Attention,
    qwen3BaseModelPath,
    qwen3DeviceMap,
    qwen3Dtype,
    qwen3Instruct,
    qwen3Language,
    qwen3MaxNewTokens,
    qwen3Mlx,
    qwen3MlxCustomVoice,
    qwen3Model,
    qwen3ReferenceAudioBase64,
    qwen3ReferenceAudioName,
    qwen3ReferenceText,
    qwen3Speaker,
    qwen3Temperature,
    qwen3TopK,
    qwen3TopP,
    qwen3VoiceClone,
    referenceCodesBase64,
    referenceWavBase64,
    referenceText,
    refreshCacheInfo,
    setNewAudioUrl,
    text,
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

  const busy = runtimeBusy || cacheBusy || qwen3MlxSetupBusy || qwen3MlxDownloadBusy || generateBusy;
  const runtimeReady = runtime?.ready ?? false;
  const activeSegmentNumber = useMemo(() => {
    if (!audioPlayer.activeSegmentId) return null;
    const index = audioPlayer.segments.findIndex((segment) => segment.id === audioPlayer.activeSegmentId);
    return index >= 0 ? index + 1 : null;
  }, [audioPlayer.activeSegmentId, audioPlayer.segments]);
  const playerStats = useMemo<GenerationStats>(() => {
    const processingTime = result?.elapsedSec ?? 0;
    const duration = audioPlayer.totalDuration || result?.durationSec || 0;
    return {
      firstLatency: null,
      processingTime,
      charsPerSec: processingTime > 0 ? text.trim().length / processingTime : 0,
      rtf: result && result.durationSec > 0 ? result.elapsedSec / result.durationSec : 0,
      totalDuration: duration,
      currentDuration: audioPlayer.currentTime,
    };
  }, [audioPlayer.currentTime, audioPlayer.totalDuration, result, text]);
  const handleDownloadAudio = useCallback(() => {
    const url = audioUrlRef.current;
    if (url) {
      const link = document.createElement("a");
      link.href = url;
      link.download = `open-tts-${model}.wav`;
      link.click();
      return;
    }
    void downloadAudio().catch((err: unknown) => {
      setStatus({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    });
  }, [downloadAudio, model]);

  return (
    <div className="mt-6 grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-5">
      <section className="flex flex-col gap-4 rounded-[22px] glass-panel p-4 transition-all duration-300 sm:p-6 lg:col-span-3">
        <div>
          <h2 className="text-xl font-display font-semibold text-text-primary">{name}</h2>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span className="rounded-full border border-white/50 bg-white/40 px-2.5 py-1 font-mono text-2xs text-text-muted shadow-glass-sm backdrop-blur-sm">
              {releaseDate}
            </span>
            <span className="rounded-full border border-white/50 bg-white/40 px-2.5 py-1 font-mono text-2xs text-text-muted shadow-glass-sm backdrop-blur-sm">
              {params}
            </span>
          </div>
          <ul className="mt-3 space-y-1 text-sm text-text-secondary">
            {highlights.map((item) => (
              <li key={item} className="flex gap-2 leading-relaxed">
                <span aria-hidden className="mt-[0.55em] h-1 w-1 shrink-0 rounded-full bg-accent/60" />
                {item}
              </li>
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

        {(model === "neutts" || model === "qwen3") && (
          <LocalRuntimeRuntimeSettings
            onRecheckRuntime={() => { void runProbe(pageVersionRef.current); }}
            runtime={runtime}
            runtimeBusy={runtimeBusy}
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
          qwen3Model={qwen3Model}
          onQwen3ModelChange={handleQwen3ModelChange}
          qwen3BaseModelPath={qwen3BaseModelPath}
          onQwen3BaseModelPathChange={handleQwen3BaseModelPathChange}
          qwen3MlxSetup={qwen3MlxSetup}
          qwen3MlxSetupBusy={qwen3MlxSetupBusy}
          qwen3MlxDownloadBusy={qwen3MlxDownloadBusy}
          qwen3MlxDownloadProgress={qwen3MlxDownloadProgress}
          onQwen3RefreshMlxSetup={() => { void refreshQwen3MlxSetup(pageVersionRef.current); }}
          onQwen3DownloadMlxModel={() => { void handleQwen3DownloadMlxModel(); }}
          onQwen3ChooseBaseModelPath={() => { void handleQwen3ChooseBaseModelPath(); }}
          qwen3ReferenceAudioName={qwen3ReferenceAudioName}
          qwen3ReferenceAudioGuidance={qwen3ReferenceAudioGuidance}
          onQwen3ReferenceAudioChange={handleQwen3ReferenceAudioChange}
          qwen3ReferenceText={qwen3ReferenceText}
          onQwen3ReferenceTextChange={handleQwen3ReferenceTextChange}
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
          qwen3TopK={qwen3TopK}
          onQwen3TopKChange={handleQwen3TopKChange}
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
              w-full rounded-2xl px-6 py-2.5 text-sm font-semibold tracking-wide transition-all duration-300 sm:w-auto
              ${!electronAvailable || !runtimeReady || !canGenerate || busy
                ? "bg-border/50 text-text-muted cursor-not-allowed backdrop-blur-sm"
                : "glass-accent text-white"
              }
            `}
          >
            {generateBusy ? "Generating…" : "Generate"}
          </button>

          {generateBusy && (
            <button
              type="button"
              onClick={() => { void cancelActiveGeneration(); }}
              className="w-full rounded-2xl border border-white/55 bg-white/40 backdrop-blur-md px-5 py-2.5 text-sm font-semibold text-text-primary shadow-glass-sm transition-all duration-200 hover:bg-white/60 hover:-translate-y-0.5 sm:w-auto"
            >
              Cancel
            </button>
          )}
        </div>

        {(audioUrl || audioPlayer.totalDuration > 0) && (
          <div className="border border-black/10 rounded-xl p-3 bg-surface/55 backdrop-blur-md">
            <p className="text-xs font-semibold uppercase tracking-widest text-text-secondary mb-2">Output</p>
            <AudioPlayer
              embedded
              isPlaying={audioPlayer.isPlaying}
              currentTime={audioPlayer.currentTime}
              totalDuration={audioPlayer.totalDuration}
              segmentCount={audioPlayer.segments.length}
              activeSegmentNumber={activeSegmentNumber}
              stats={playerStats}
              isGenerating={generateBusy}
              onTogglePlay={audioPlayer.togglePlay}
              onSeek={audioPlayer.seek}
              onSkipBackward={() => audioPlayer.skip(-10)}
              onSkipForward={() => audioPlayer.skip(10)}
              onDownload={handleDownloadAudio}
              onStop={generateBusy ? () => { void cancelActiveGeneration(); } : stopAudioPlayer}
            />
            {result && (
              <p className="text-sm mt-2 text-text-muted">
                {result.modelRepo} • {result.sampleRate} Hz • {result.durationSec.toFixed(2)}s
              </p>
            )}
            {audioPlayer.error && (
              <p className="text-sm mt-2 text-danger">{audioPlayer.error}</p>
            )}
          </div>
        )}

        {!electronAvailable && (
          <p className="text-xs text-danger">
            Available only in the desktop app — this model runs through local runtimes.
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
