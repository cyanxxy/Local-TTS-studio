import { useCallback, useMemo, useRef } from "react";
import { MIN_TEXT_LENGTH } from "../constants";
import type { LocalBrowserSupport } from "../lib/browserSupport";
import { hasMinimumSynthesisText } from "../lib/textValidation";
import { resolveKokoroVoice } from "../lib/voices";
import { ENGINES, type BrowserEngineId } from "../models/registry";
import type { EngineRuntime, SynthesisChunk, SynthesisRequest } from "../shared/engineRuntime";
import type { SynthesisQueue } from "../shared/synthesisQueue";
import type { ChunkPauseKind, GenerationStats, GenerationTuningSettings, ModelState } from "../types";
import type { UseAudioPlayerReturn } from "./useAudioPlayer";
import { useGenerationControl } from "./useGenerationControl";
import { useModelCacheControls } from "./useModelCacheControls";
import { useModelLoader, type UseModelLoaderReturn } from "./useModelLoader";
import { useSynthesisQueue, type UseSynthesisQueueReturn } from "./useSynthesisQueue";
import { useTTS } from "./useTTS";
import { streamWorkerGeneration, workerGenerateRequest } from "./workerGeneration";

interface Options {
  /** The browser engine Studio and the Reader share. */
  activeModel: BrowserEngineId;
  /** A visible surface runs the browser engine. */
  active: boolean;
  /** Some surface selects the browser engine, visible or not. */
  retain: boolean;
  browserSupport: LocalBrowserSupport;
  preferredVoices?: Partial<Record<BrowserEngineId, string>>;
  debugProfiling?: boolean;
  /** What the surface generation speaks. */
  text: string;
  /** Each engine's chosen voice; the surface generation speaks with the active one's. */
  savedVoices: { readonly [Id in BrowserEngineId]: string };
  generationSettings: GenerationTuningSettings;
  player: UseAudioPlayerReturn;
  setShowPlayer: (show: boolean) => void;
}

export type BrowserEngineRuntimeMap = { readonly [Id in BrowserEngineId]: EngineRuntime<Id> };

export interface UseBrowserEngineRuntimesReturn {
  runtimes: BrowserEngineRuntimeMap;
  /** Each engine's voice, the saved one mapped onto the voices its model reported. */
  voicesInUse: { readonly [Id in BrowserEngineId]: string };
  states: UseModelLoaderReturn["states"];
  voices: UseModelLoaderReturn["voices"];
  loadModel: UseModelLoaderReturn["loadModel"];
  isRetakingSegment: boolean;
  handleRetakeSegment: (segmentId: string) => void;
  cacheBusy: boolean;
  cacheStatus: ReturnType<typeof useModelCacheControls>["cacheStatus"];
  clearCache: () => Promise<void>;
  redownloadActiveModel: () => Promise<void>;
}

const IDLE_STATS: GenerationStats = {
  firstLatency: null,
  processingTime: 0,
  charsPerSec: 0,
  rtf: 0,
  totalDuration: 0,
  currentDuration: 0,
};

const noop = () => undefined;

/**
 * Kokoro and Supertonic 2 as engine runtimes. The two share one surface
 * generation path (the worker pool, `useTTS` and `useGenerationControl`), which
 * drives whichever is `activeModel`; the other engine's surface fields are idle
 * and its controls do nothing. Either engine can `synthesize` at any time: a
 * request loads its engine's worker on demand and holds it while it runs.
 */
export function useBrowserEngineRuntimes({
  activeModel,
  active,
  retain,
  browserSupport,
  preferredVoices,
  debugProfiling,
  text,
  savedVoices,
  generationSettings,
  player,
  setShowPlayer,
}: Options): UseBrowserEngineRuntimesReturn {
  const loader = useModelLoader(activeModel, {
    active,
    retain,
    preferredVoices,
    debugProfiling,
    supportedModels: browserSupport.supportedModels,
  });
  const { acquireWorker, getWorker, hardRestartModel, loadModel, reloadModel, states, voices } = loader;

  const { endStream, scheduleChunk } = player;
  const onAudioChunk = useCallback((chunk: {
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
    void scheduleChunk({
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
  }, [scheduleChunk]);
  const onComplete = useCallback(() => endStream({ completed: true }), [endStream]);
  const tts = useTTS({ getWorker, onAudioChunk, onComplete });

  const savedKokoroVoice = savedVoices.kokoro;
  const kokoroVoices = voices.kokoro;
  const kokoroVoice = useMemo(() => {
    if (kokoroVoices.length === 0) return savedKokoroVoice;
    return resolveKokoroVoice(savedKokoroVoice, kokoroVoices) ?? savedKokoroVoice;
  }, [kokoroVoices, savedKokoroVoice]);
  const supertonicVoice = savedVoices.supertonic;
  const voicesInUse = useMemo(
    () => ({ kokoro: kokoroVoice, supertonic: supertonicVoice }),
    [kokoroVoice, supertonicVoice],
  );
  const voice = voicesInUse[activeModel];

  const activeState = states[activeModel];
  const activeSupported = browserSupport.supportedModels.includes(activeModel);
  const readyToGenerate = browserSupport.isSupported
    && activeSupported
    && hasMinimumSynthesisText(text, MIN_TEXT_LENGTH)
    && activeState.ready;

  // The wrappers below also keep the surface generation out of a running
  // synthesize request's way.
  const generation = useGenerationControl({
    activeModel,
    canGenerate: readyToGenerate,
    generationSettings,
    hardRestartModel,
    getWorker,
    player,
    setShowPlayer,
    text,
    tts,
    voice,
  });
  const {
    cancelActiveGeneration,
    handleGenerate: runGeneration,
    handleRetakeSegment: runRetake,
    handleStop,
    isGenerationBusy,
    isRetakingSegment,
    resetGeneratedAudio,
    retakeError,
  } = generation;

  // Only the active engine's queue ever meets the surface generation.
  const kokoroQueue = useSynthesisQueue(activeModel === "kokoro" && isGenerationBusy);
  const supertonicQueue = useSynthesisQueue(activeModel === "supertonic" && isGenerationBusy);
  const queues: { readonly [Id in BrowserEngineId]: UseSynthesisQueueReturn } = {
    kokoro: kokoroQueue,
    supertonic: supertonicQueue,
  };
  const activeQueue = queues[activeModel];

  const cache = useModelCacheControls({
    activeModel,
    cancelActiveGeneration,
    resetGeneratedAudio,
    reloadModel,
  });
  const { retryActiveModelLoad } = cache;

  const canGenerate = readyToGenerate && !activeQueue.busy && !isGenerationBusy;
  const { holdForeground } = activeQueue;
  const handleGenerate = useCallback(() => {
    if (!canGenerate) return;
    holdForeground();
    runGeneration();
  }, [canGenerate, holdForeground, runGeneration]);
  const activeQueueBusy = activeQueue.busy;
  const handleRetakeSegment = useCallback((segmentId: string) => {
    if (isGenerationBusy || activeQueueBusy) return;
    holdForeground();
    runRetake(segmentId);
  }, [activeQueueBusy, holdForeground, isGenerationBusy, runRetake]);

  // Unforced: only a running browser generation restarts its worker.
  const cancelSurfaceGeneration = useCallback(() => cancelActiveGeneration(), [cancelActiveGeneration]);
  const synthesisSeqRef = useRef(0);
  const synthesizeWith = useCallback(<Id extends BrowserEngineId>(
    model: Id,
    queue: SynthesisQueue<SynthesisChunk>,
    request: SynthesisRequest<Id>,
  ) => queue.enqueue((signal) => (async function* () {
    const held = await acquireWorker(model, signal);
    try {
      synthesisSeqRef.current += 1;
      const { label } = ENGINES[model];
      const settings: { voice: string; language?: string } = request.settings;
      yield* streamWorkerGeneration({
        worker: held.worker,
        generationId: `${model}-synthesize-${synthesisSeqRef.current}`,
        request: workerGenerateRequest(
          request.text,
          settings.voice,
          settings.language === undefined ? request.tuning : { ...request.tuning, language: settings.language },
        ),
        signal,
        lifetime: held.lifetime,
        stop: () => {
          // Released first so the restart only respawns a worker something needs.
          held.release();
          hardRestartModel(model);
        },
        failureMessage: `${label} worker failed.`,
        stoppedMessage: `${label} stopped before the request finished.`,
      });
    } finally {
      held.release();
    }
  })(), request.signal), [acquireWorker, hardRestartModel]);

  const kokoroQueueInstance = kokoroQueue.queue;
  const supertonicQueueInstance = supertonicQueue.queue;
  const synthesizeKokoro = useCallback(
    (request: SynthesisRequest<"kokoro">) => synthesizeWith("kokoro", kokoroQueueInstance, request),
    [kokoroQueueInstance, synthesizeWith],
  );
  const synthesizeSupertonic = useCallback(
    (request: SynthesisRequest<"supertonic">) => synthesizeWith("supertonic", supertonicQueueInstance, request),
    [supertonicQueueInstance, synthesizeWith],
  );

  const kokoroState = states.kokoro;
  const supertonicState = states.supertonic;
  const surfaceError = tts.error ?? retakeError;
  const runtimes = useMemo<BrowserEngineRuntimeMap>(() => {
    const surface = {
      canGenerate,
      isGenerating: isGenerationBusy,
      generationProgress: tts.generationProgress,
      stats: tts.stats,
      error: surfaceError,
      handleGenerate,
      handleStop,
      retryLoad: retryActiveModelLoad,
      cancelActiveGeneration: cancelSurfaceGeneration,
      resetGeneratedAudio,
    };
    const idle = {
      canGenerate: false,
      isGenerating: false,
      generationProgress: 0,
      stats: IDLE_STATS,
      error: null,
      handleGenerate: noop,
      handleStop: noop,
      retryLoad: noop,
      cancelActiveGeneration: noop,
      resetGeneratedAudio: noop,
    };
    const fields = (model: BrowserEngineId, modelState: ModelState) => ({
      ...(model === activeModel ? surface : idle),
      modelState,
    });
    return {
      kokoro: { id: "kokoro", ...fields("kokoro", kokoroState), synthesize: synthesizeKokoro },
      supertonic: { id: "supertonic", ...fields("supertonic", supertonicState), synthesize: synthesizeSupertonic },
    };
  }, [
    activeModel,
    canGenerate,
    cancelSurfaceGeneration,
    handleGenerate,
    handleStop,
    isGenerationBusy,
    kokoroState,
    resetGeneratedAudio,
    retryActiveModelLoad,
    supertonicState,
    surfaceError,
    synthesizeKokoro,
    synthesizeSupertonic,
    tts.generationProgress,
    tts.stats,
  ]);

  return {
    runtimes,
    voicesInUse,
    states,
    voices,
    loadModel,
    isRetakingSegment,
    handleRetakeSegment,
    cacheBusy: cache.cacheBusy,
    cacheStatus: cache.cacheStatus,
    clearCache: cache.clearCache,
    redownloadActiveModel: cache.redownloadActiveModel,
  };
}
