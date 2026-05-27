import { useCallback, useEffect, useRef, useState } from "react";
import { concatFloat32Arrays } from "../lib/audio";
import type {
  GenerationTuningSettings,
  ModelType,
  WorkerInMessage,
  WorkerOutMessage,
} from "../types";
import type { UseAudioPlayerReturn } from "./useAudioPlayer";
import type { UseTTSReturn } from "./useTTS";

interface UseGenerationControlOptions {
  activeModel: ModelType;
  canGenerate: boolean;
  generationSettings: GenerationTuningSettings;
  kokoroWorker: React.RefObject<Worker | null>;
  supertonicWorker: React.RefObject<Worker | null>;
  player: UseAudioPlayerReturn;
  setShowPlayer: (showPlayer: boolean) => void;
  text: string;
  tts: Pick<UseTTSReturn, "cancel" | "generate" | "isGenerating">;
  voice: string;
}

interface UseGenerationControlReturn {
  isRetakingSegment: boolean;
  isGenerationBusy: boolean;
  cancelRetake: (notifyWorker: boolean) => void;
  resetGeneratedAudio: () => void;
  cancelActiveGeneration: (forceCancelTts?: boolean) => void;
  handleGenerate: () => void;
  handleStop: () => void;
  handleRetakeSegment: (segmentId: string) => void;
}

export function useGenerationControl({
  activeModel,
  canGenerate,
  generationSettings,
  kokoroWorker,
  supertonicWorker,
  player,
  setShowPlayer,
  text,
  tts,
  voice,
}: UseGenerationControlOptions): UseGenerationControlReturn {
  const [isRetakingSegment, setIsRetakingSegment] = useState(false);

  const retakeWorkerRef = useRef<Worker | null>(null);
  const retakeListenerRef = useRef<((event: MessageEvent<WorkerOutMessage>) => void) | null>(null);
  const retakeGenerationSeqRef = useRef(0);

  const clearRetakeListener = useCallback(() => {
    if (retakeWorkerRef.current && retakeListenerRef.current) {
      retakeWorkerRef.current.removeEventListener("message", retakeListenerRef.current as EventListener);
    }
    retakeWorkerRef.current = null;
    retakeListenerRef.current = null;
    setIsRetakingSegment(false);
  }, []);

  useEffect(() => {
    return () => clearRetakeListener();
  }, [clearRetakeListener]);

  const cancelRetake = useCallback((notifyWorker: boolean) => {
    if (notifyWorker && retakeWorkerRef.current) {
      retakeWorkerRef.current.postMessage({ type: "CANCEL" } satisfies WorkerInMessage);
    }
    clearRetakeListener();
  }, [clearRetakeListener]);

  const resetGeneratedAudio = useCallback(() => {
    player.reset();
    setShowPlayer(false);
  }, [player, setShowPlayer]);

  const cancelActiveGeneration = useCallback((forceCancelTts: boolean = false) => {
    cancelRetake(true);
    if (forceCancelTts || tts.isGenerating) {
      tts.cancel();
    }
  }, [cancelRetake, tts]);

  const isGenerationBusy = tts.isGenerating || isRetakingSegment;

  const handleGenerate = useCallback(() => {
    if (!canGenerate || isGenerationBusy) return;
    cancelRetake(false);
    player.reset();
    setShowPlayer(true);
    tts.generate(text, activeModel, voice, generationSettings);
  }, [
    activeModel,
    canGenerate,
    cancelRetake,
    generationSettings,
    isGenerationBusy,
    player,
    setShowPlayer,
    text,
    tts,
    voice,
  ]);

  const handleStop = useCallback(() => {
    cancelActiveGeneration(true);
    player.stopAll();
  }, [cancelActiveGeneration, player]);

  const handleRetakeSegment = useCallback((segmentId: string) => {
    if (!segmentId || isGenerationBusy) return;

    const segment = player.segments.find((entry) => entry.id === segmentId);
    const worker = activeModel === "kokoro" ? kokoroWorker.current : supertonicWorker.current;

    if (!segment || !worker) return;

    clearRetakeListener();
    retakeWorkerRef.current = worker;
    retakeGenerationSeqRef.current += 1;
    const generationId = `retake-${retakeGenerationSeqRef.current}`;

    const chunks: Array<{ audio: Float32Array; samplingRate: number }> = [];
    const handleMessage = (event: MessageEvent<WorkerOutMessage>) => {
      const msg = event.data;
      if ("generationId" in msg && msg.generationId !== undefined && msg.generationId !== generationId) {
        return;
      }
      switch (msg.type) {
        case "AUDIO_CHUNK":
          chunks.push({ audio: msg.audio, samplingRate: msg.samplingRate });
          break;
        case "GENERATION_COMPLETE": {
          clearRetakeListener();
          if (chunks.length === 0) return;
          const samplingRate = chunks[0].samplingRate;
          const merged = concatFloat32Arrays(chunks.map((chunk) => chunk.audio));
          player.replaceSegment(segment.id, {
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
          break;
        }
        case "ERROR":
          console.error("Retake generation error:", msg.message);
          clearRetakeListener();
          break;
      }
    };

    retakeListenerRef.current = handleMessage;
    worker.addEventListener("message", handleMessage as EventListener);
    setIsRetakingSegment(true);
    worker.postMessage({
      type: "GENERATE",
      generationId,
      text: segment.text,
      voice,
      speed: generationSettings.speed,
      quality: generationSettings.quality,
      finalPauseSec: segment.pauseAfterSec,
      pauseOverridesSec: generationSettings.pauseOverridesSec,
      sentenceSpeedVariance: generationSettings.sentenceSpeedVariance,
      pronunciationRules: generationSettings.pronunciationRules,
      emphasisStrength: generationSettings.emphasisStrength,
    } satisfies WorkerInMessage);
  }, [
    activeModel,
    clearRetakeListener,
    generationSettings,
    isGenerationBusy,
    kokoroWorker,
    player,
    setShowPlayer,
    supertonicWorker,
    voice,
  ]);

  return {
    isRetakingSegment,
    isGenerationBusy,
    cancelRetake,
    resetGeneratedAudio,
    cancelActiveGeneration,
    handleGenerate,
    handleStop,
    handleRetakeSegment,
  };
}
