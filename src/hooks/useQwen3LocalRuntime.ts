import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  LocalTtsAudioChunkEvent,
  LocalTtsGenerateResult,
  LocalTtsProgressEvent,
  LocalTtsProbeResult,
  LocalTtsQwen3MlxSetup,
} from "../electron";
import { MIN_TEXT_LENGTH } from "../constants";
import type { GenerationStats, ModelState } from "../types";
import { scheduleNextUiFrame } from "../lib/uiScheduling";
import {
  QWEN3_ATTENTION_OPTIONS,
  QWEN3_DEFAULT_MAX_NEW_TOKENS,
  QWEN3_DEVICE_OPTIONS,
  QWEN3_DTYPE_OPTIONS,
  QWEN3_LANGUAGE_OPTIONS,
  QWEN3_SPEAKER_OPTIONS,
  getDefaultQwen3Model,
  qwen3UsesMlx,
  qwen3UsesMlxCustomVoice,
} from "../components/localRuntime/modelOptions";
import type { UseAudioPlayerReturn } from "./useAudioPlayer";

interface UseQwen3LocalRuntimeOptions {
  enabled: boolean;
  text: string;
  player: UseAudioPlayerReturn;
  setShowPlayer: (showPlayer: boolean) => void;
}

interface ReceivedAudioChunk {
  audio: ArrayBuffer;
  sampleCount: number;
  silenceAfterSamples: number;
}

interface UseQwen3LocalRuntimeReturn {
  modelState: ModelState;
  canGenerate: boolean;
  isGenerating: boolean;
  generationProgress: number;
  stats: GenerationStats;
  error: string | null;
  handleGenerate: () => void;
  handleStop: () => void;
  retryLoad: () => void;
  resetGeneratedAudio: () => void;
  cancelActiveGeneration: () => void;
}

const LOCAL_MODEL = "qwen3";

const DEFAULT_QWEN3_SPEAKER = QWEN3_SPEAKER_OPTIONS[0].value;
const DEFAULT_QWEN3_LANGUAGE = QWEN3_LANGUAGE_OPTIONS[0].value;
const DEFAULT_QWEN3_DEVICE = QWEN3_DEVICE_OPTIONS[0].value;
const DEFAULT_QWEN3_DTYPE = QWEN3_DTYPE_OPTIONS[0].value;
const DEFAULT_QWEN3_ATTENTION = QWEN3_ATTENTION_OPTIONS[0].value;
const DEFAULT_QWEN3_TEMPERATURE = 0.9;
const DEFAULT_QWEN3_TOP_K = 50;
const DEFAULT_QWEN3_TOP_P = 1.0;

function createLocalRequestId(): string {
  return `${LOCAL_MODEL}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createProbeRequestId(): string {
  return `${LOCAL_MODEL}-probe-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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

function formatGenerationError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useQwen3LocalRuntime({
  enabled,
  text,
  player,
  setShowPlayer,
}: UseQwen3LocalRuntimeOptions): UseQwen3LocalRuntimeReturn {
  const [runtime, setRuntime] = useState<LocalTtsProbeResult | null>(null);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [qwen3MlxSetup, setQwen3MlxSetup] = useState<LocalTtsQwen3MlxSetup | null>(null);
  const [qwen3MlxSetupBusy, setQwen3MlxSetupBusy] = useState(false);
  const [qwen3Model, setQwen3Model] = useState(() => getDefaultQwen3Model(window.electron?.platform));
  const [qwen3BaseModelPath, setQwen3BaseModelPath] = useState("");
  const [generateBusy, setGenerateBusy] = useState(false);
  const [generationProgress, setGenerationProgress] = useState<LocalTtsProgressEvent | null>(null);
  const [result, setResult] = useState<LocalTtsGenerateResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
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
  const warmedKeyRef = useRef<string | null>(null);

  const electronAvailable = enabled && !!window.electron?.localTts;
  const qwen3MlxCustomVoice = qwen3UsesMlxCustomVoice(qwen3Model);
  const qwen3Mlx = qwen3UsesMlx(qwen3Model);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const clearGeneratedResult = useCallback(() => {
    streamedAudioChunksRef.current = [];
    streamedAudioSampleRateRef.current = null;
    scheduledAudioChunkCountRef.current = 0;
    player.reset();
    setResult(null);
    setGenerationProgress(null);
  }, [player]);

  const resetGeneratedAudio = useCallback(() => {
    generationVersionRef.current += 1;
    const activeRequestId = activeRequestIdRef.current;
    if (generateBusy && activeRequestId && window.electron?.localTts) {
      void window.electron.localTts.cancel({ model: LOCAL_MODEL, requestId: activeRequestId }).catch(() => undefined);
    }
    activeRequestIdRef.current = null;
    activeRequestGenerationVersionRef.current = null;
    clearGeneratedResult();
    setShowPlayer(false);
    setError(null);
    setGenerateBusy(false);
  }, [clearGeneratedResult, generateBusy, setShowPlayer]);

  const cancelActiveGeneration = useCallback(() => {
    const requestId = activeRequestIdRef.current;
    if (!requestId || !window.electron?.localTts) return;
    player.stopAll();
    void window.electron.localTts.cancel({ model: LOCAL_MODEL, requestId }).catch(() => undefined);
  }, [player]);

  const refreshQwen3MlxSetup = useCallback(async (runtimeVersion: number = runtimeVersionRef.current) => {
    if (!enabled || !window.electron?.localTts?.getQwen3MlxSetup) return;
    setQwen3MlxSetupBusy(true);
    try {
      const setup = await window.electron.localTts.getQwen3MlxSetup();
      if (!mountedRef.current || runtimeVersionRef.current !== runtimeVersion) return;
      setQwen3MlxSetup(setup);
      setQwen3Model((current) => (
        current === "auto" && window.electron?.platform === "darwin"
          ? setup.recommendedModelRepo
          : current
      ));
      setQwen3BaseModelPath((current) => (
        current.trim().length === 0 && setup.modelDirLooksReady
          ? setup.recommendedModelDir
          : current
      ));
    } catch (err) {
      if (!mountedRef.current || runtimeVersionRef.current !== runtimeVersion) return;
      setError(formatGenerationError(err));
    } finally {
      if (mountedRef.current && runtimeVersionRef.current === runtimeVersion) {
        setQwen3MlxSetupBusy(false);
      }
    }
  }, [enabled]);

  const runProbe = useCallback(async (runtimeVersion: number = runtimeVersionRef.current) => {
    if (!enabled || !window.electron?.localTts) return;
    const requestId = createProbeRequestId();
    activeProbeRequestIdRef.current = requestId;
    setRuntimeBusy(true);
    setError(null);
    try {
      const probe = await window.electron.localTts.probe({
        model: LOCAL_MODEL,
        requestId,
      });
      if (
        !mountedRef.current
        || runtimeVersionRef.current !== runtimeVersion
        || activeProbeRequestIdRef.current !== requestId
      ) return;
      setRuntime(probe);
      if (!probe.ready) {
        setError(probe.message);
      }
    } catch (err) {
      if (
        !mountedRef.current
        || runtimeVersionRef.current !== runtimeVersion
        || activeProbeRequestIdRef.current !== requestId
      ) return;
      setRuntime(null);
      setError(formatGenerationError(err));
    } finally {
      if (
        mountedRef.current
        && runtimeVersionRef.current === runtimeVersion
        && activeProbeRequestIdRef.current === requestId
      ) {
        activeProbeRequestIdRef.current = null;
        setRuntimeBusy(false);
      }
    }
  }, [enabled]);

  const retryLoad = useCallback(() => {
    if (!enabled) return;
    runtimeVersionRef.current += 1;
    const runtimeVersion = runtimeVersionRef.current;
    void Promise.allSettled([
      runProbe(runtimeVersion),
      refreshQwen3MlxSetup(runtimeVersion),
    ]);
  }, [enabled, refreshQwen3MlxSetup, runProbe]);

  useEffect(() => {
    if (!enabled) {
      runtimeVersionRef.current += 1;
      generationVersionRef.current += 1;
      generationProgressFlushCancelRef.current?.();
      generationProgressFlushCancelRef.current = null;
      pendingGenerationProgressRef.current = null;
      const activeRequestId = activeRequestIdRef.current;
      if (activeRequestId && window.electron?.localTts) {
        void window.electron.localTts.cancel({ model: LOCAL_MODEL, requestId: activeRequestId }).catch(() => undefined);
      }
      activeRequestIdRef.current = null;
      activeRequestGenerationVersionRef.current = null;
      activeProbeRequestIdRef.current = null;
      streamedAudioChunksRef.current = [];
      streamedAudioSampleRateRef.current = null;
      scheduledAudioChunkCountRef.current = 0;
      setRuntimeBusy(false);
      setQwen3MlxSetupBusy(false);
      setGenerateBusy(false);
      setGenerationProgress(null);
      return;
    }
    retryLoad();
  }, [enabled, retryLoad]);

  useEffect(() => {
    if (!electronAvailable || generateBusy) return;
    const baseModelPath = qwen3BaseModelPath.trim();
    if (qwen3MlxCustomVoice) {
      if (!(qwen3MlxSetup?.apiServerAvailable ?? false)) return;
      if (!baseModelPath) return;
    }
    const warmKey = `${qwen3Model}:${baseModelPath}`;
    if (warmedKeyRef.current === warmKey) return;
    warmedKeyRef.current = warmKey;
    // Candle repos warm too: the bridge only pre-loads already-downloaded
    // weights, so this never kicks off a download.
    void window.electron?.localTts?.warm?.({
      model: LOCAL_MODEL,
      modelRepo: qwen3Model,
      ...(qwen3MlxCustomVoice && baseModelPath ? { baseModelPath } : {}),
    }).catch(() => undefined);
  }, [electronAvailable, generateBusy, qwen3BaseModelPath, qwen3MlxCustomVoice, qwen3MlxSetup, qwen3Model]);

  useEffect(() => {
    if (!electronAvailable || !window.electron?.localTts) return;

    const flushGenerationProgress = () => {
      const event = pendingGenerationProgressRef.current;
      if (!event) return;
      pendingGenerationProgressRef.current = null;
      setGenerationProgress(event);
    };

    return window.electron.localTts.subscribeProgress((event) => {
      if (!mountedRef.current) return;
      if (event.model !== LOCAL_MODEL) return;
      if (event.requestId === activeProbeRequestIdRef.current) return;
      if (event.requestId !== activeRequestIdRef.current) return;
      if (activeRequestGenerationVersionRef.current !== generationVersionRef.current) return;

      pendingGenerationProgressRef.current = event;
      generationProgressFlushCancelRef.current?.();
      generationProgressFlushCancelRef.current = scheduleNextUiFrame(flushGenerationProgress);
    });
  }, [electronAvailable]);

  useEffect(() => {
    if (!electronAvailable || !window.electron?.localTts) return;

    return window.electron.localTts.subscribeAudioChunk((event: LocalTtsAudioChunkEvent) => {
      if (!mountedRef.current) return;
      if (event.model !== LOCAL_MODEL) return;
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
        void player.scheduleChunk({
          audio: buildPlaybackSamples(chunk),
          samplingRate: sampleRate,
          text: `Qwen3 section ${chunkIndex + 1}`,
          index: chunkIndex + 1,
          total: displayTotal,
          pauseAfterSec: chunk.silenceAfterSamples / sampleRate,
        }).catch((err: unknown) => {
          if (!mountedRef.current) return;
          setError(formatGenerationError(err));
        });
      }
    });
  }, [electronAvailable, player]);

  useEffect(() => () => {
    generationProgressFlushCancelRef.current?.();
    const requestId = activeRequestIdRef.current;
    if (!requestId || !window.electron?.localTts) return;
    void window.electron.localTts.cancel({ model: LOCAL_MODEL, requestId }).catch(() => undefined);
    activeRequestIdRef.current = null;
    activeRequestGenerationVersionRef.current = null;
  }, []);

  const qwen3Ready = useMemo(() => {
    if (!electronAvailable || !(runtime?.ready ?? false)) return false;
    if (qwen3MlxCustomVoice) {
      return qwen3BaseModelPath.trim().length > 0
        && ((qwen3MlxSetup?.apiServerAvailable ?? false) || (qwen3MlxSetup?.ttsAvailable ?? false));
    }
    return true;
  }, [electronAvailable, qwen3BaseModelPath, qwen3MlxCustomVoice, qwen3MlxSetup, runtime]);

  const modelState = useMemo<ModelState>(() => {
    const loading = enabled && (runtimeBusy || qwen3MlxSetupBusy);
    const setupError = enabled && electronAvailable && runtime?.ready && qwen3MlxCustomVoice && !qwen3Ready && !loading
      ? "Qwen3 MLX model files are not ready. Open Qwen3-TTS settings to download or choose the model directory."
      : null;
    return {
      ready: qwen3Ready,
      loading,
      downloadProgress: qwen3Ready ? 100 : loading ? 25 : 0,
      error: error ?? setupError,
      backend: null,
    };
  }, [electronAvailable, enabled, error, qwen3MlxCustomVoice, qwen3Ready, qwen3MlxSetupBusy, runtime, runtimeBusy]);

  const canGenerate = enabled
    && qwen3Ready
    && !generateBusy
    && text.trim().length >= MIN_TEXT_LENGTH;

  const stats = useMemo<GenerationStats>(() => {
    const processingTime = result?.elapsedSec ?? 0;
    const duration = player.totalDuration || result?.durationSec || 0;
    return {
      firstLatency: null,
      processingTime,
      charsPerSec: processingTime > 0 ? text.trim().length / processingTime : 0,
      rtf: result && result.durationSec > 0 ? result.elapsedSec / result.durationSec : 0,
      totalDuration: duration,
      currentDuration: player.currentTime,
    };
  }, [player.currentTime, player.totalDuration, result, text]);

  const handleGenerate = useCallback(() => {
    if (!canGenerate || !window.electron?.localTts) return;

    const generationVersion = generationVersionRef.current;
    const requestId = createLocalRequestId();
    const baseModelPath = qwen3BaseModelPath.trim();

    clearGeneratedResult();
    setShowPlayer(true);
    player.beginStream();
    setGenerateBusy(true);
    setError(null);
    setGenerationProgress({
      requestId,
      model: LOCAL_MODEL,
      phase: "queued",
      message: qwen3MlxCustomVoice ? "Starting Qwen3 CustomVoice MLX." : "Starting Qwen3 CustomVoice.",
      elapsedSec: 0,
    });
    activeRequestIdRef.current = requestId;
    activeRequestGenerationVersionRef.current = generationVersion;

    const payload: Record<string, unknown> = {
      text: text.trim(),
      modelRepo: qwen3Model,
      mode: "customVoice",
      speaker: DEFAULT_QWEN3_SPEAKER,
      language: DEFAULT_QWEN3_LANGUAGE,
      deviceMap: DEFAULT_QWEN3_DEVICE,
      dtype: DEFAULT_QWEN3_DTYPE,
      attnImplementation: DEFAULT_QWEN3_ATTENTION,
      temperature: DEFAULT_QWEN3_TEMPERATURE,
      topK: DEFAULT_QWEN3_TOP_K,
      topP: DEFAULT_QWEN3_TOP_P,
      maxNewTokens: QWEN3_DEFAULT_MAX_NEW_TOKENS,
    };
    if (qwen3Mlx && baseModelPath) {
      payload.baseModelPath = baseModelPath;
    }

    void window.electron.localTts.generate({
      model: LOCAL_MODEL,
      requestId,
      payload,
    }).then((generated) => {
      if (!mountedRef.current) return;
      if (activeRequestIdRef.current !== requestId) return;
      if (generationVersionRef.current !== generationVersion) return;
      setResult(generated);
      const expectedChunks = generated.audioChunkCount;
      if (expectedChunks > 0) {
        const completeChunks = streamedAudioChunksRef.current
          .slice(0, expectedChunks)
          .filter((chunk): chunk is ReceivedAudioChunk => !!chunk);
        if (completeChunks.length !== expectedChunks) {
          throw new Error("Generation returned incomplete streamed audio.");
        }
      }
      player.endStream();
      setGenerationProgress(null);
      setError(null);
    }).catch((err: unknown) => {
      if (!mountedRef.current) return;
      if (activeRequestIdRef.current !== requestId) return;
      player.endStream();
      clearGeneratedResult();
      setGenerationProgress(null);
      const message = formatGenerationError(err);
      setError(/cancelled/i.test(message) ? null : message);
    }).finally(() => {
      if (!mountedRef.current || activeRequestIdRef.current !== requestId) return;
      activeRequestIdRef.current = null;
      activeRequestGenerationVersionRef.current = null;
      setGenerateBusy(false);
    });
  }, [
    canGenerate,
    clearGeneratedResult,
    player,
    qwen3BaseModelPath,
    qwen3Mlx,
    qwen3MlxCustomVoice,
    qwen3Model,
    setShowPlayer,
    text,
  ]);

  const handleStop = useCallback(() => {
    cancelActiveGeneration();
    player.stopAll();
  }, [cancelActiveGeneration, player]);

  return {
    modelState,
    canGenerate,
    isGenerating: generateBusy,
    generationProgress: generationProgress ? 0 : 0,
    stats,
    error: modelState.error,
    handleGenerate,
    handleStop,
    retryLoad,
    resetGeneratedAudio,
    cancelActiveGeneration,
  };
}
