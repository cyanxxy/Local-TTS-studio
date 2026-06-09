import { useState, useCallback, useRef, useEffect } from "react";
import type {
  ChunkPauseKind,
  GenerationStats,
  GenerationTuningSettings,
  ModelType,
  WorkerInMessage,
  WorkerOutMessage,
} from "../types";
import { scheduleNextUiFrame, type CancelScheduledUiFlush } from "../lib/uiScheduling";

interface UseTTSOptions {
  kokoroWorker: React.RefObject<Worker | null>;
  supertonicWorker: React.RefObject<Worker | null>;
  onAudioChunk: (chunk: {
    audio: Float32Array;
    samplingRate: number;
    text: string;
    index: number;
    total: number;
    textStart?: number;
    textEnd?: number;
    pauseAfterSec?: number;
    pauseKind?: ChunkPauseKind;
  }) => void;
  onComplete: () => void;
}

export interface UseTTSReturn {
  isGenerating: boolean;
  error: string | null;
  stats: GenerationStats;
  generationProgress: number;
  generate: (text: string, model: ModelType, voice: string, settings: GenerationTuningSettings) => void;
  cancel: () => void;
}

const INITIAL_STATS: GenerationStats = {
  firstLatency: null,
  processingTime: 0,
  charsPerSec: 0,
  rtf: 0,
  totalDuration: 0,
  currentDuration: 0,
};

function workerEventMessage(event: Event, fallback: string): string {
  if (event instanceof ErrorEvent && event.message) return event.message;
  if (event.type === "messageerror") return `${fallback} The worker sent an unreadable message.`;
  return fallback;
}

/**
 * Unified TTS hook. Model-agnostic — delegates to the right worker
 * based on the active model. Tracks generation stats.
 */
export function useTTS({
  kokoroWorker,
  supertonicWorker,
  onAudioChunk,
  onComplete,
}: UseTTSOptions): UseTTSReturn {
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<GenerationStats>(INITIAL_STATS);
  const [generationProgress, setGenerationProgress] = useState(0);

  const startTimeRef = useRef(0);
  const processedCharsRef = useRef(0);
  const inputCharsRef = useRef(1);
  const generatedAudioSecsRef = useRef(0);
  const activeWorkerRef = useRef<Worker | null>(null);
  const listenerWorkerRef = useRef<Worker | null>(null);
  const listenerRef = useRef<((e: MessageEvent<WorkerOutMessage>) => void) | null>(null);
  const errorListenerRef = useRef<((event: Event) => void) | null>(null);
  const messageErrorListenerRef = useRef<((event: Event) => void) | null>(null);
  const generationSeqRef = useRef(0);
  const firstLatencyRef = useRef<number | null>(null);
  const pendingStatsRef = useRef<GenerationStats | null>(null);
  const pendingProgressRef = useRef<number | null>(null);
  const uiFlushCancelRef = useRef<CancelScheduledUiFlush | null>(null);

  const flushGenerationUi = useCallback(() => {
    uiFlushCancelRef.current = null;

    if (pendingStatsRef.current) {
      setStats(pendingStatsRef.current);
      pendingStatsRef.current = null;
    }

    if (pendingProgressRef.current !== null) {
      setGenerationProgress(pendingProgressRef.current);
      pendingProgressRef.current = null;
    }
  }, []);

  const queueGenerationUiFlush = useCallback(() => {
    if (uiFlushCancelRef.current) return;
    uiFlushCancelRef.current = scheduleNextUiFrame(flushGenerationUi);
  }, [flushGenerationUi]);

  const discardGenerationUiFlush = useCallback(() => {
    if (uiFlushCancelRef.current) {
      uiFlushCancelRef.current();
      uiFlushCancelRef.current = null;
    }
    pendingStatsRef.current = null;
    pendingProgressRef.current = null;
  }, []);

  const flushGenerationUiNow = useCallback(() => {
    if (uiFlushCancelRef.current) {
      uiFlushCancelRef.current();
      uiFlushCancelRef.current = null;
    }
    flushGenerationUi();
  }, [flushGenerationUi]);

  const cleanup = useCallback(() => {
    discardGenerationUiFlush();
    if (listenerWorkerRef.current && listenerRef.current) {
      listenerWorkerRef.current.removeEventListener("message", listenerRef.current as EventListener);
    }
    if (listenerWorkerRef.current && errorListenerRef.current) {
      listenerWorkerRef.current.removeEventListener("error", errorListenerRef.current as EventListener);
    }
    if (listenerWorkerRef.current && messageErrorListenerRef.current) {
      listenerWorkerRef.current.removeEventListener("messageerror", messageErrorListenerRef.current as EventListener);
    }
    listenerRef.current = null;
    errorListenerRef.current = null;
    messageErrorListenerRef.current = null;
    listenerWorkerRef.current = null;
    activeWorkerRef.current = null;
  }, [discardGenerationUiFlush]);

  useEffect(() => cleanup, [cleanup]);

  const generate = useCallback(
    (text: string, model: ModelType, voice: string, settings: GenerationTuningSettings) => {
      const worker = model === "kokoro" ? kokoroWorker.current : supertonicWorker.current;
      if (!worker) return;

      // Cleanup previous listener
      cleanup();

      setIsGenerating(true);
      setError(null);
      setStats(INITIAL_STATS);
      setGenerationProgress(0);
      startTimeRef.current = performance.now();
      processedCharsRef.current = 0;
      inputCharsRef.current = Math.max(1, text.trim().length);
      generatedAudioSecsRef.current = 0;
      firstLatencyRef.current = null;
      activeWorkerRef.current = worker;
      generationSeqRef.current += 1;
      const generationId = `browser-${generationSeqRef.current}`;

      const handleMessage = (e: MessageEvent<WorkerOutMessage>) => {
        const msg = e.data;
        if ("generationId" in msg && msg.generationId !== undefined && msg.generationId !== generationId) {
          return;
        }

        switch (msg.type) {
          case "AUDIO_CHUNK": {
            const now = performance.now();
            const elapsedSec = (now - startTimeRef.current) / 1000;
            const chunkDuration = msg.audio.length / msg.samplingRate;

            generatedAudioSecsRef.current += chunkDuration;
            processedCharsRef.current += msg.text.length;
            firstLatencyRef.current ??= elapsedSec;

            pendingStatsRef.current = {
              firstLatency: firstLatencyRef.current,
              processingTime: elapsedSec,
              charsPerSec: elapsedSec > 0 ? processedCharsRef.current / elapsedSec : 0,
              rtf: generatedAudioSecsRef.current > 0 ? elapsedSec / generatedAudioSecsRef.current : 0,
              totalDuration: generatedAudioSecsRef.current,
              currentDuration: generatedAudioSecsRef.current,
            };

            if (msg.total > 0) {
              const byChunks = (msg.index / msg.total) * 100;
              const byChars = Math.min(100, (processedCharsRef.current / inputCharsRef.current) * 100);
              pendingProgressRef.current = Math.min(100, Math.max(byChunks, byChars));
            } else {
              pendingProgressRef.current = Math.min(100, (processedCharsRef.current / inputCharsRef.current) * 100);
            }
            queueGenerationUiFlush();

            onAudioChunk(msg);
            break;
          }
          case "GENERATION_COMPLETE":
            flushGenerationUiNow();
            setGenerationProgress(100);
            setIsGenerating(false);
            cleanup();
            onComplete();
            break;
          case "ERROR":
            console.error("Worker error:", msg.message);
            setError(msg.message);
            setIsGenerating(false);
            cleanup();
            break;
        }
      };

      const failGeneration = (message: string) => {
        console.error("Worker error:", message);
        setError(message);
        setIsGenerating(false);
        cleanup();
      };
      const handleWorkerError = (event: Event) => {
        failGeneration(workerEventMessage(event, "TTS worker failed."));
      };
      const handleWorkerMessageError = (event: Event) => {
        failGeneration(workerEventMessage(event, "TTS worker failed."));
      };

      listenerRef.current = handleMessage;
      errorListenerRef.current = handleWorkerError;
      messageErrorListenerRef.current = handleWorkerMessageError;
      worker.addEventListener("message", handleMessage as EventListener);
      worker.addEventListener("error", handleWorkerError as EventListener);
      worker.addEventListener("messageerror", handleWorkerMessageError as EventListener);
      listenerWorkerRef.current = worker;

      const message: WorkerInMessage = {
        type: "GENERATE",
        generationId,
        text,
        voice,
        speed: settings.speed,
        quality: settings.quality,
        pauseOverridesSec: settings.pauseOverridesSec,
        sentenceSpeedVariance: settings.sentenceSpeedVariance,
        pronunciationRules: settings.pronunciationRules,
        emphasisStrength: settings.emphasisStrength,
      };
      try {
        worker.postMessage(message);
      } catch (error) {
        failGeneration(error instanceof Error ? error.message : String(error));
      }
    },
    [kokoroWorker, supertonicWorker, onAudioChunk, onComplete, cleanup, flushGenerationUiNow, queueGenerationUiFlush],
  );

  const cancel = useCallback(() => {
    if (activeWorkerRef.current) {
      activeWorkerRef.current.postMessage({ type: "CANCEL" } satisfies WorkerInMessage);
    }
    setIsGenerating(false);
    cleanup();
  }, [cleanup]);

  return {
    isGenerating,
    error,
    stats,
    generationProgress,
    generate,
    cancel,
  };
}
