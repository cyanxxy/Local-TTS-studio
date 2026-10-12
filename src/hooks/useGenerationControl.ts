import { useCallback, useEffect, useRef, useState } from "react";
import { concatFloat32Arrays } from "../lib/audio";
import type { GenerationTuningSettings, ModelType } from "../types";
import type { UseAudioPlayerReturn } from "./useAudioPlayer";
import type { UseModelLoaderReturn } from "./useModelLoader";
import type { UseTTSReturn } from "./useTTS";
import { abortWorkerGeneration, observeWorkerGeneration, workerGenerateRequest } from "./workerGeneration";

interface UseGenerationControlOptions {
  activeModel: ModelType;
  canGenerate: boolean;
  generationSettings: GenerationTuningSettings;
  getWorker: UseModelLoaderReturn["getWorker"];
  hardRestartModel: (model: ModelType) => void;
  player: UseAudioPlayerReturn;
  /** The text a retake regenerates a stored segment with; defaults to the segment's own text. */
  retakeText?: (segment: { text: string; textStart?: number; textEnd?: number }) => string;
  setShowPlayer: (showPlayer: boolean) => void;
  text: string;
  tts: Pick<UseTTSReturn, "abort" | "cancel" | "generate" | "isGenerating">;
  voice: string;
}

interface UseGenerationControlReturn {
  isRetakingSegment: boolean;
  isGenerationBusy: boolean;
  retakeError: string | null;
  cancelRetake: (notifyWorker: boolean) => void;
  resetGeneratedAudio: () => void;
  cancelActiveGeneration: (forceCancelTts?: boolean) => void;
  handleGenerate: () => void;
  handleStop: () => void;
  handleRetakeSegment: (segmentId: string) => void;
}

/** The retake in flight: its worker, its model, and how to stop listening to it. */
interface ActiveRetake {
  worker: Worker;
  model: ModelType;
  generationId: string;
  detach: () => void;
}

export function useGenerationControl({
  activeModel,
  canGenerate,
  generationSettings,
  getWorker,
  hardRestartModel,
  player,
  retakeText,
  setShowPlayer,
  text,
  tts,
  voice,
}: UseGenerationControlOptions): UseGenerationControlReturn {
  const [isRetakingSegment, setIsRetakingSegment] = useState(false);
  const [retakeError, setRetakeError] = useState<string | null>(null);
  // The player's functions are stable for its lifetime; the object is not.
  const {
    beginStream,
    endStream,
    replaceSegment,
    reset: resetPlayer,
    segments,
    stopAll,
  } = player;
  const { abort: abortTts, cancel: cancelTts, generate: generateTts, isGenerating: isTtsGenerating } = tts;

  const retakeRef = useRef<ActiveRetake | null>(null);
  const retakeGenerationSeqRef = useRef(0);

  const clearRetakeListener = useCallback(() => {
    retakeRef.current?.detach();
    retakeRef.current = null;
    setIsRetakingSegment(false);
  }, []);

  useEffect(() => {
    return () => clearRetakeListener();
  }, [clearRetakeListener]);

  useEffect(() => {
    if (!isTtsGenerating) {
      endStream();
    }
  }, [endStream, isTtsGenerating]);

  // A worker that does not answer a soft abort is replaced, unless it already was.
  const restartIfStillCurrent = useCallback((model: ModelType, worker: Worker) => {
    if (getWorker(model) === worker) hardRestartModel(model);
  }, [getWorker, hardRestartModel]);

  const cancelRetake = useCallback((notifyWorker: boolean) => {
    const retake = retakeRef.current;
    if (notifyWorker && retake) {
      const { generationId, model, worker } = retake;
      abortWorkerGeneration(worker, generationId, () => restartIfStillCurrent(model, worker));
    }
    clearRetakeListener();
  }, [clearRetakeListener, restartIfStillCurrent]);

  const resetGeneratedAudio = useCallback(() => {
    setRetakeError(null);
    resetPlayer();
    setShowPlayer(false);
  }, [resetPlayer, setShowPlayer]);

  // Stopping keeps the model loaded: the worker aborts the generation and is
  // ready for the next. Only a forced cancel (the model itself is suspect)
  // closes the worker and loads the model again.
  const cancelActiveGeneration = useCallback((forceCancelTts: boolean = false) => {
    cancelRetake(true);
    if (forceCancelTts) {
      cancelTts();
      hardRestartModel(activeModel);
    } else if (isTtsGenerating) {
      abortTts((worker) => restartIfStillCurrent(activeModel, worker));
    }
  }, [abortTts, activeModel, cancelRetake, cancelTts, hardRestartModel, isTtsGenerating, restartIfStillCurrent]);

  const isGenerationBusy = isTtsGenerating || isRetakingSegment;

  const handleGenerate = useCallback(() => {
    if (!canGenerate || isGenerationBusy) return;
    cancelRetake(false);
    setRetakeError(null);
    resetPlayer();
    beginStream();
    setShowPlayer(true);
    generateTts(text, activeModel, voice, generationSettings);
  }, [
    activeModel,
    beginStream,
    canGenerate,
    cancelRetake,
    generateTts,
    generationSettings,
    isGenerationBusy,
    resetPlayer,
    setShowPlayer,
    text,
    voice,
  ]);

  const handleStop = useCallback(() => {
    // Only a running generation needs its worker torn down; forcing it here
    // also reloaded the model every time Stop merely ended playback.
    cancelActiveGeneration();
    stopAll();
  }, [cancelActiveGeneration, stopAll]);

  const handleRetakeSegment = useCallback((segmentId: string) => {
    if (!segmentId || isGenerationBusy) return;

    const segment = segments.find((entry) => entry.id === segmentId);
    const worker = getWorker(activeModel);

    if (!segment || !worker) return;

    clearRetakeListener();
    setRetakeError(null);
    retakeGenerationSeqRef.current += 1;
    const generationId = `retake-${retakeGenerationSeqRef.current}`;

    const chunks: Array<{ audio: Float32Array; samplingRate: number }> = [];
    const retake: ActiveRetake = { worker, model: activeModel, generationId, detach: () => undefined };
    retakeRef.current = retake;
    setIsRetakingSegment(true);
    retake.detach = observeWorkerGeneration(worker, generationId, {
      ...workerGenerateRequest(retakeText ? retakeText(segment) : segment.text, voice, generationSettings),
      finalPauseSec: segment.pauseAfterSec,
    }, {
      onChunk: (chunk) => {
        chunks.push({ audio: chunk.audio, samplingRate: chunk.samplingRate });
      },
      onComplete: () => {
        clearRetakeListener();
        if (chunks.length === 0) return;
        const samplingRate = chunks[0].samplingRate;
        const merged = concatFloat32Arrays(chunks.map((chunk) => chunk.audio));
        replaceSegment(segment.id, {
          audio: merged,
          samplingRate,
          text: segment.text,
          index: segment.index,
          total: segment.total,
          textStart: segment.textStart,
          textEnd: segment.textEnd,
          pauseAfterSec: segment.pauseAfterSec,
          pauseKind: segment.pauseKind,
        });
        setShowPlayer(true);
      },
      onError: (message) => {
        console.error("Retake generation error:", message);
        setRetakeError(message);
        clearRetakeListener();
      },
    }, "Retake worker failed.");
  }, [
    activeModel,
    clearRetakeListener,
    generationSettings,
    isGenerationBusy,
    replaceSegment,
    retakeText,
    segments,
    setShowPlayer,
    getWorker,
    voice,
  ]);

  return {
    isRetakingSegment,
    isGenerationBusy,
    retakeError,
    cancelRetake,
    resetGeneratedAudio,
    cancelActiveGeneration,
    handleGenerate,
    handleStop,
    handleRetakeSegment,
  };
}
