import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MIN_TEXT_LENGTH } from "../constants";
import type { LocalBrowserSupport } from "../lib/browserSupport";
import { ensureChatterboxReference } from "../lib/chatterboxClips";
import { CHATTERBOX_DEFAULT_REFERENCE_ID } from "../lib/chatterboxProtocol";
import { hasMinimumSynthesisText } from "../lib/textValidation";
import { resolveKokoroVoice } from "../lib/voices";
import { BROWSER_ENGINE_IDS, browserEngineWorkerFields, ENGINES, type BrowserEngineId } from "../models/registry";
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
  /** GENERATE fields only the active engine's worker reads, from its settings (see `workerFields`). */
  engineFields?: Readonly<Record<string, unknown>>;
  player: UseAudioPlayerReturn;
  /** See `UseGenerationControlOptions.retakeText`. */
  retakeText?: (segment: { text: string; textStart?: number; textEnd?: number }) => string;
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
 * The browser engines (Kokoro, Supertonic 2, Kitten, Paradee, Piper) as engine
 * runtimes. They share one surface generation path (the worker pool, `useTTS`
 * and `useGenerationControl`), which drives whichever is `activeModel`; every
 * other engine's surface fields are idle and its controls do nothing. Any
 * engine can `synthesize` at any time: a request loads its engine's worker on
 * demand and holds it while it runs.
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
  engineFields,
  player,
  retakeText,
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
  // Only Kokoro's catalogue depends on what its model reported; every other
  // engine's saved voice was validated against its own fixed catalogue.
  const voicesInUse = useMemo(
    () => ({ ...savedVoices, kokoro: kokoroVoice }),
    [kokoroVoice, savedVoices],
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
    retakeText,
    setShowPlayer,
    text,
    tts,
    voice,
    engineFields,
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
  const kittenQueue = useSynthesisQueue(activeModel === "kitten" && isGenerationBusy);
  const paradeeQueue = useSynthesisQueue(activeModel === "paradee" && isGenerationBusy);
  const piperQueue = useSynthesisQueue(activeModel === "piper" && isGenerationBusy);
  const chatterboxQueue = useSynthesisQueue(activeModel === "chatterbox" && isGenerationBusy);
  const queues: { readonly [Id in BrowserEngineId]: UseSynthesisQueueReturn } = {
    kokoro: kokoroQueue,
    supertonic: supertonicQueue,
    kitten: kittenQueue,
    paradee: paradeeQueue,
    piper: piperQueue,
    chatterbox: chatterboxQueue,
  };
  const activeQueue = queues[activeModel];

  const cache = useModelCacheControls({
    activeModel,
    cancelActiveGeneration,
    resetGeneratedAudio,
    reloadModel,
  });
  const { retryActiveModelLoad } = cache;

  // A cloned Chatterbox voice must reach the worker before it can speak with it.
  const referenceId = activeModel === "chatterbox" && typeof engineFields?.referenceId === "string"
    && engineFields.referenceId !== CHATTERBOX_DEFAULT_REFERENCE_ID
    ? engineFields.referenceId
    : null;
  const chatterboxState = states.chatterbox;
  const [syncedReference, setSyncedReference] = useState<{ id: string; state: ModelState } | null>(null);
  const [referenceFailure, setReferenceFailure] = useState<{ id: string; message: string } | null>(null);
  useEffect(() => {
    const worker = referenceId === null || !chatterboxState.ready ? null : getWorker("chatterbox");
    if (referenceId === null || !worker) return;
    let current = true;
    ensureChatterboxReference(worker, referenceId).then(
      () => {
        if (!current) return;
        setSyncedReference({ id: referenceId, state: chatterboxState });
        // A later attempt (a restarted worker, the clip chosen again) worked.
        setReferenceFailure((failure) => (failure?.id === referenceId ? null : failure));
      },
      (error: unknown) => {
        if (current) setReferenceFailure({ id: referenceId, message: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [chatterboxState, getWorker, referenceId]);
  // Ready only for this worker: a replacement worker is a new model state.
  const referenceReady = referenceId === null
    || (syncedReference?.id === referenceId && syncedReference.state === chatterboxState);
  const referenceError = referenceId !== null && referenceFailure?.id === referenceId ? referenceFailure.message : null;

  const canGenerate = readyToGenerate && referenceReady && !activeQueue.busy && !isGenerationBusy;
  const { holdForeground } = activeQueue;
  const handleGenerate = useCallback(() => {
    if (!canGenerate) return;
    holdForeground();
    runGeneration();
  }, [canGenerate, holdForeground, runGeneration]);
  // A retake asked for while a synthesize request still holds the worker (a
  // Reader look-ahead it has just preempted, which is winding down) waits for
  // that request to finish instead of being dropped. Requests queued behind
  // it are held from the moment of asking, and run after the retake.
  const runRetakeRef = useRef(runRetake);
  useEffect(() => {
    runRetakeRef.current = runRetake;
  }, [runRetake]);
  const waitingRetakeRef = useRef<(() => void) | null>(null);
  const dropWaitingRetake = useCallback(() => {
    waitingRetakeRef.current?.();
    waitingRetakeRef.current = null;
  }, []);
  useEffect(() => dropWaitingRetake, [dropWaitingRetake]);
  const activeQueueInstance = activeQueue.queue;
  const handleRetakeSegment = useCallback((segmentId: string) => {
    if (isGenerationBusy) return;
    dropWaitingRetake();
    holdForeground();
    if (!activeQueueInstance.busy) {
      runRetake(segmentId);
      return;
    }
    const unsubscribe = activeQueueInstance.subscribe(() => {
      if (activeQueueInstance.busy) return;
      dropWaitingRetake();
      // Held again before the queue starts its next request; the retake's
      // own busy state keeps it held once that has rendered.
      holdForeground();
      runRetakeRef.current(segmentId);
    });
    waitingRetakeRef.current = unsubscribe;
  }, [activeQueueInstance, dropWaitingRetake, holdForeground, isGenerationBusy, runRetake]);

  // Unforced: only a running browser generation restarts its worker. Stopping
  // also drops a retake still waiting for the worker.
  const cancelSurfaceGeneration = useCallback(() => {
    dropWaitingRetake();
    cancelActiveGeneration();
  }, [cancelActiveGeneration, dropWaitingRetake]);
  const stopSurfaceGeneration = useCallback(() => {
    dropWaitingRetake();
    handleStop();
  }, [dropWaitingRetake, handleStop]);
  const synthesisSeqRef = useRef(0);
  const synthesizeWith = useCallback(<Id extends BrowserEngineId>(
    model: Id,
    queue: SynthesisQueue<SynthesisChunk>,
    request: SynthesisRequest<Id>,
  ) => queue.enqueue((signal) => (async function* () {
    const held = await acquireWorker(model, signal);
    try {
      const fields: Readonly<Record<string, unknown>> = {
        ...browserEngineWorkerFields(model, request.settings),
        ...(request.seed !== undefined && ENGINES[model].capabilities.seed ? { seed: request.seed } : {}),
      };
      if (model === "chatterbox" && typeof fields.referenceId === "string") {
        await ensureChatterboxReference(held.worker, fields.referenceId);
      }
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
          fields,
        ),
        signal,
        lifetime: held.lifetime,
        // The hold is released as the request unwinds, so the restart only
        // respawns a worker something needs, and only one still current.
        onUnresponsive: () => {
          if (getWorker(model) === held.worker) hardRestartModel(model);
        },
        failureMessage: `${label} worker failed.`,
        stoppedMessage: `${label} stopped before the request finished.`,
      });
    } finally {
      held.release();
    }
  })(), request.signal), [acquireWorker, getWorker, hardRestartModel]);

  const kokoroQueueInstance = kokoroQueue.queue;
  const supertonicQueueInstance = supertonicQueue.queue;
  const kittenQueueInstance = kittenQueue.queue;
  const paradeeQueueInstance = paradeeQueue.queue;
  const piperQueueInstance = piperQueue.queue;
  const chatterboxQueueInstance = chatterboxQueue.queue;
  const synthesizers = useMemo(() => {
    const queueInstances: { readonly [Id in BrowserEngineId]: SynthesisQueue<SynthesisChunk> } = {
      kokoro: kokoroQueueInstance,
      supertonic: supertonicQueueInstance,
      kitten: kittenQueueInstance,
      paradee: paradeeQueueInstance,
      piper: piperQueueInstance,
      chatterbox: chatterboxQueueInstance,
    };
    return Object.fromEntries(BROWSER_ENGINE_IDS.map((model) => [
      model,
      (request: SynthesisRequest<BrowserEngineId>) => synthesizeWith(
        model,
        queueInstances[model],
        // The request carries the settings of the engine it is made on.
        request as SynthesisRequest<typeof model>,
      ),
    ])) as { readonly [Id in BrowserEngineId]: EngineRuntime<Id>["synthesize"] };
  }, [
    chatterboxQueueInstance,
    kittenQueueInstance,
    kokoroQueueInstance,
    paradeeQueueInstance,
    piperQueueInstance,
    supertonicQueueInstance,
    synthesizeWith,
  ]);

  const surfaceError = tts.error ?? retakeError ?? referenceError;
  const runtimes = useMemo<BrowserEngineRuntimeMap>(() => {
    const surface = {
      canGenerate,
      isGenerating: isGenerationBusy,
      generationProgress: tts.generationProgress,
      stats: tts.stats,
      error: surfaceError,
      handleGenerate,
      handleStop: stopSurfaceGeneration,
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
    // Each entry pairs an engine's id with its own state and synthesize, which
    // the mapped type cannot see through a loop over the ids.
    return Object.fromEntries(BROWSER_ENGINE_IDS.map((model) => [model, {
      id: model,
      ...(model === activeModel ? surface : idle),
      modelState: states[model],
      synthesize: synthesizers[model],
    }])) as unknown as BrowserEngineRuntimeMap;
  }, [
    activeModel,
    canGenerate,
    cancelSurfaceGeneration,
    handleGenerate,
    isGenerationBusy,
    resetGeneratedAudio,
    retryActiveModelLoad,
    states,
    stopSurfaceGeneration,
    surfaceError,
    synthesizers,
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
