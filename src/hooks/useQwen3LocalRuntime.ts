import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  LocalTtsAudioChunkEvent,
  LocalTtsGenerateResult,
  LocalTtsProgressEvent,
  LocalTtsProbeResult,
} from "../electron";
import { MIN_TEXT_LENGTH } from "../constants";
import { useQwen3Runtime } from "../contexts/Qwen3RuntimeContext";
import { scheduleNextUiFrame } from "../lib/uiScheduling";
import type { GenerationStats, ModelState } from "../types";
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

function requestId(kind: "probe" | "generate"): string {
  return `${LOCAL_MODEL}-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function playbackSamples(chunk: ReceivedAudioChunk): Float32Array {
  const samples = new Float32Array(chunk.audio, 0, chunk.sampleCount);
  const output = new Float32Array(samples.length + Math.max(0, chunk.silenceAfterSamples));
  for (let index = 0; index < samples.length; index += 1) {
    output[index] = Number.isFinite(samples[index]) ? samples[index] : 0;
  }
  return output;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useQwen3LocalRuntime({
  enabled,
  text,
  player,
  setShowPlayer,
}: UseQwen3LocalRuntimeOptions): UseQwen3LocalRuntimeReturn {
  const settings = useQwen3Runtime();
  const refreshSetup = settings.refreshSetup;
  const [runtime, setRuntime] = useState<LocalTtsProbeResult | null>(null);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [generateBusy, setGenerateBusy] = useState(false);
  const [progress, setProgress] = useState<LocalTtsProgressEvent | null>(null);
  const [result, setResult] = useState<LocalTtsGenerateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const runtimeVersionRef = useRef(0);
  const generationVersionRef = useRef(0);
  const activeRequestRef = useRef<string | null>(null);
  const activeRequestVersionRef = useRef<number | null>(null);
  const activeProbeRef = useRef<string | null>(null);
  const chunksRef = useRef<ReceivedAudioChunk[]>([]);
  const sampleRateRef = useRef<number | null>(null);
  const scheduledCountRef = useRef(0);
  const pendingProgressRef = useRef<LocalTtsProgressEvent | null>(null);
  const cancelProgressFlushRef = useRef<(() => void) | null>(null);
  const warmedKeyRef = useRef<string | null>(null);
  const bridge = window.electron?.localTts;
  const electronAvailable = enabled && !!bridge;
  const beginStream = player.beginStream;
  const endStream = player.endStream;
  const resetPlayer = player.reset;
  const scheduleChunk = player.scheduleChunk;
  const stopAll = player.stopAll;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const clearGeneratedResult = useCallback(() => {
    chunksRef.current = [];
    sampleRateRef.current = null;
    scheduledCountRef.current = 0;
    resetPlayer();
    setResult(null);
    setProgress(null);
  }, [resetPlayer]);

  const cancelActiveGeneration = useCallback(() => {
    const active = activeRequestRef.current;
    if (!active || !bridge) return;
    stopAll();
    void bridge.cancel({ model: LOCAL_MODEL, requestId: active }).catch(() => undefined);
  }, [bridge, stopAll]);

  const resetGeneratedAudio = useCallback(() => {
    generationVersionRef.current += 1;
    cancelActiveGeneration();
    activeRequestRef.current = null;
    activeRequestVersionRef.current = null;
    clearGeneratedResult();
    setShowPlayer(false);
    setError(null);
    setGenerateBusy(false);
  }, [cancelActiveGeneration, clearGeneratedResult, setShowPlayer]);

  const runProbe = useCallback(async () => {
    if (!enabled || !bridge) return;
    const version = ++runtimeVersionRef.current;
    const id = requestId("probe");
    activeProbeRef.current = id;
    setRuntimeBusy(true);
    setError(null);
    try {
      const next = await bridge.probe({ model: LOCAL_MODEL, requestId: id });
      if (!mountedRef.current || runtimeVersionRef.current !== version || activeProbeRef.current !== id) return;
      setRuntime(next);
      if (!next.ready) setError(next.message);
    } catch (nextError) {
      if (!mountedRef.current || runtimeVersionRef.current !== version || activeProbeRef.current !== id) return;
      setRuntime(null);
      setError(message(nextError));
    } finally {
      if (mountedRef.current && runtimeVersionRef.current === version && activeProbeRef.current === id) {
        activeProbeRef.current = null;
        setRuntimeBusy(false);
      }
    }
  }, [bridge, enabled]);

  const retryLoad = useCallback(() => {
    if (!enabled) return;
    void Promise.allSettled([runProbe(), refreshSetup()]);
  }, [enabled, refreshSetup, runProbe]);

  useEffect(() => {
    if (enabled) {
      retryLoad();
      return;
    }
    runtimeVersionRef.current += 1;
    generationVersionRef.current += 1;
    cancelProgressFlushRef.current?.();
    pendingProgressRef.current = null;
    cancelActiveGeneration();
    activeRequestRef.current = null;
    activeRequestVersionRef.current = null;
    activeProbeRef.current = null;
    setRuntimeBusy(false);
    setGenerateBusy(false);
    setProgress(null);
  }, [cancelActiveGeneration, enabled, retryLoad]);

  useEffect(() => {
    if (!electronAvailable || generateBusy || !bridge?.warm) return;
    const path = settings.modelPath.trim();
    if (!path || settings.readiness === "missing") return;
    const key = `${settings.profile.repo}:${path}`;
    if (warmedKeyRef.current === key) return;
    warmedKeyRef.current = key;
    void bridge.warm({
      model: LOCAL_MODEL,
      mode: settings.profile.mode,
      modelPath: path,
    }).catch(() => undefined);
  }, [bridge, electronAvailable, generateBusy, settings.modelPath, settings.profile, settings.readiness]);

  useEffect(() => {
    if (!electronAvailable || !bridge) return;
    return bridge.subscribeProgress((event) => {
      if (!mountedRef.current || event.model !== LOCAL_MODEL || event.requestId !== activeRequestRef.current) return;
      if (activeRequestVersionRef.current !== generationVersionRef.current) return;
      pendingProgressRef.current = event;
      cancelProgressFlushRef.current?.();
      cancelProgressFlushRef.current = scheduleNextUiFrame(() => {
        if (pendingProgressRef.current) setProgress(pendingProgressRef.current);
        pendingProgressRef.current = null;
      });
    });
  }, [bridge, electronAvailable]);

  useEffect(() => {
    if (!electronAvailable || !bridge) return;
    return bridge.subscribeAudioChunk((event: LocalTtsAudioChunkEvent) => {
      if (!mountedRef.current || event.model !== LOCAL_MODEL || event.requestId !== activeRequestRef.current) return;
      if (activeRequestVersionRef.current !== generationVersionRef.current) return;
      if (event.sampleCount <= 0 || event.audio.byteLength !== event.sampleCount * Float32Array.BYTES_PER_ELEMENT) return;
      if (event.index === 0 || sampleRateRef.current !== event.sampleRate) {
        chunksRef.current = [];
        sampleRateRef.current = event.sampleRate;
        scheduledCountRef.current = 0;
      }
      chunksRef.current[event.index] = {
        audio: event.audio,
        sampleCount: event.sampleCount,
        silenceAfterSamples: event.silenceAfterSamples,
      };
      const contiguous = chunksRef.current.slice(0, event.index + 1).filter((chunk): chunk is ReceivedAudioChunk => !!chunk);
      if (contiguous.length !== event.index + 1) return;
      while (scheduledCountRef.current < contiguous.length) {
        const index = scheduledCountRef.current++;
        const chunk = contiguous[index];
        void scheduleChunk({
          audio: playbackSamples(chunk),
          samplingRate: event.sampleRate,
          text: `Qwen3 section ${index + 1}`,
          index: index + 1,
          total: event.total > 0 ? event.total : contiguous.length,
          pauseAfterSec: chunk.silenceAfterSamples / event.sampleRate,
        }).catch((nextError: unknown) => {
          if (mountedRef.current) setError(message(nextError));
        });
      }
    });
  }, [bridge, electronAvailable, scheduleChunk]);

  useEffect(() => () => {
    cancelProgressFlushRef.current?.();
    cancelActiveGeneration();
  }, [cancelActiveGeneration]);

  const settingsReady = settings.modelPath.trim().length > 0
    && settings.readiness !== "missing"
    && (settings.profile.mode !== "voiceClone"
      || (!!settings.referenceAudioBase64 && settings.referenceText.trim().length > 0));
  const ready = electronAvailable && (runtime?.ready ?? false) && settingsReady;
  const combinedError = error
    ?? settings.error
    ?? (enabled && runtime?.ready && !settingsReady && !settings.setupBusy
      ? "Select or download a valid Qwen3 model directory before generating."
      : null);
  const modelState = useMemo<ModelState>(() => ({
    ready,
    loading: enabled && (runtimeBusy || settings.setupBusy),
    downloadProgress: ready ? 100 : runtimeBusy || settings.setupBusy ? 25 : 0,
    error: combinedError,
    backend: null,
  }), [combinedError, enabled, ready, runtimeBusy, settings.setupBusy]);
  const canGenerate = ready && !generateBusy && text.trim().length >= MIN_TEXT_LENGTH;

  const stats = useMemo<GenerationStats>(() => {
    const processingTime = result?.elapsedSec ?? 0;
    return {
      firstLatency: null,
      processingTime,
      charsPerSec: processingTime > 0 ? text.trim().length / processingTime : 0,
      rtf: result && result.durationSec > 0 ? result.elapsedSec / result.durationSec : 0,
      totalDuration: player.totalDuration || result?.durationSec || 0,
      currentDuration: player.currentTime,
    };
  }, [player.currentTime, player.totalDuration, result, text]);

  const handleGenerate = useCallback(() => {
    if (!canGenerate || !bridge) return;
    const version = generationVersionRef.current;
    const id = requestId("generate");
    clearGeneratedResult();
    setShowPlayer(true);
    beginStream();
    setGenerateBusy(true);
    setError(null);
    setProgress({
      requestId: id,
      model: LOCAL_MODEL,
      phase: "queued",
      message: `Starting Qwen3 ${settings.profile.label} with ${settings.profile.provider}.`,
      elapsedSec: 0,
    });
    activeRequestRef.current = id;
    activeRequestVersionRef.current = version;
    const payload: Record<string, unknown> = {
      text: text.trim(),
      mode: settings.profile.mode,
      modelRepo: settings.profile.repo,
      modelPath: settings.modelPath.trim(),
      language: settings.language,
      temperature: settings.temperature,
      topK: settings.topK,
      maxNewTokens: settings.maxNewTokens,
    };
    if (settings.profile.mode === "customVoice") {
      payload.speaker = settings.speaker;
      payload.instruct = settings.instruct;
    } else {
      payload.referenceAudioBase64 = settings.referenceAudioBase64;
      payload.referenceText = settings.referenceText.trim();
    }
    void bridge.generate({ model: LOCAL_MODEL, requestId: id, payload }).then((generated) => {
      if (!mountedRef.current || activeRequestRef.current !== id || generationVersionRef.current !== version) return;
      if (chunksRef.current.filter(Boolean).length !== generated.audioChunkCount) {
        throw new Error("Generation returned incomplete streamed audio.");
      }
      setResult(generated);
      endStream();
      setProgress(null);
    }).catch((nextError: unknown) => {
      if (!mountedRef.current || activeRequestRef.current !== id) return;
      endStream();
      clearGeneratedResult();
      const text = message(nextError);
      setError(/cancelled/i.test(text) ? null : text);
    }).finally(() => {
      if (!mountedRef.current || activeRequestRef.current !== id) return;
      activeRequestRef.current = null;
      activeRequestVersionRef.current = null;
      setGenerateBusy(false);
    });
  }, [beginStream, bridge, canGenerate, clearGeneratedResult, endStream, setShowPlayer, settings, text]);

  const handleStop = useCallback(() => {
    cancelActiveGeneration();
    stopAll();
  }, [cancelActiveGeneration, stopAll]);

  return {
    modelState,
    canGenerate,
    isGenerating: generateBusy,
    generationProgress: progress ? 0 : 0,
    stats,
    error: combinedError,
    handleGenerate,
    handleStop,
    retryLoad,
    resetGeneratedAudio,
    cancelActiveGeneration,
  };
}
