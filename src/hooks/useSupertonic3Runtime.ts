import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MIN_TEXT_LENGTH } from "../constants";
import type { GenerationTuningSettings, ModelState, WorkerOutMessage } from "../types";
import type { UseAudioPlayerReturn } from "./useAudioPlayer";
import { useTTS } from "./useTTS";

interface Options {
  available: boolean;
  active: boolean;
  createWorker?: () => Worker;
  text: string;
  voice: string;
  language: string;
  generationSettings: GenerationTuningSettings;
  player: UseAudioPlayerReturn;
  setShowPlayer: (show: boolean) => void;
}

const INITIAL_STATE: ModelState = {
  ready: false,
  loading: false,
  downloadProgress: 0,
  error: null,
  backend: null,
};

const SUPERTONIC3_IDLE_EVICT_MS = 15_000;

export function useSupertonic3Runtime({
  available,
  active,
  createWorker,
  text,
  voice,
  language,
  generationSettings,
  player,
  setShowPlayer,
}: Options) {
  const [modelState, setModelState] = useState<ModelState>(INITIAL_STATE);
  const [workerRevision, setWorkerRevision] = useState(0);
  const [workerReady, setWorkerReady] = useState(false);
  const [workerResident, setWorkerResident] = useState(available && active);
  const workerRef = useRef<Worker | null>(null);
  const loadRequestedRef = useRef(false);
  const workerCrashedRef = useRef(false);
  const streamStartedRef = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;

  // Depend on the player's stable functions, not on the object, which changes
  // identity with every player state update while audio streams.
  const { beginStream, endStream, reset: resetPlayer, scheduleChunk, stopAll } = player;
  const onAudioChunk = useCallback((chunk: Parameters<UseAudioPlayerReturn["scheduleChunk"]>[0]) => {
    void scheduleChunk(chunk);
  }, [scheduleChunk]);
  const onComplete = useCallback(() => endStream({ completed: true }), [endStream]);
  const getWorker = useCallback(() => workerRef.current, []);
  const tts = useTTS({ getWorker, onAudioChunk, onComplete });
  const cancelTts = tts.cancel;
  const generateTts = tts.generate;

  const hardCancelGeneration = useCallback((recreate: boolean) => {
    cancelTts();
    const worker = workerRef.current;
    workerRef.current = null;
    worker?.terminate();
    loadRequestedRef.current = false;
    workerCrashedRef.current = false;
    streamStartedRef.current = false;
    setWorkerReady(false);
    setModelState(INITIAL_STATE);
    if (recreate && available && createWorker) {
      setWorkerResident(true);
      setWorkerRevision((revision) => revision + 1);
    } else {
      setWorkerResident(false);
    }
  }, [available, cancelTts, createWorker]);

  const loadModel = useCallback((forceReload = false) => {
    if (!available || !workerRef.current || loadRequestedRef.current) return;
    loadRequestedRef.current = true;
    setModelState((previous) => ({
      ...previous,
      ready: forceReload ? false : previous.ready,
      loading: true,
      downloadProgress: 0,
      error: null,
      backend: forceReload ? null : previous.backend,
    }));
    try {
      workerRef.current.postMessage({ type: "LOAD", forceReload });
    } catch (error) {
      loadRequestedRef.current = false;
      workerCrashedRef.current = true;
      setWorkerReady(false);
      setModelState((previous) => ({
        ...previous,
        ready: false,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
        backend: null,
      }));
    }
  }, [available]);

  useEffect(() => {
    if (!available || !createWorker || !workerResident) {
      setWorkerReady(false);
      return;
    }
    let worker: Worker;
    try {
      worker = createWorker();
    } catch (error) {
      setModelState((previous) => ({
        ...previous,
        ready: false,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
        backend: null,
      }));
      setWorkerReady(false);
      return;
    }
    workerRef.current = worker;
    workerCrashedRef.current = false;
    setWorkerReady(true);
    const handleMessage = (event: MessageEvent<WorkerOutMessage>) => {
      const message = event.data;
      if (message.type === "LOAD_PROGRESS") {
        setModelState((previous) => ({ ...previous, loading: true, downloadProgress: message.percent, error: null }));
      } else if (message.type === "READY") {
        loadRequestedRef.current = false;
        setModelState({ ready: true, loading: false, downloadProgress: 100, error: null, backend: message.backend ?? null });
      } else if (message.type === "CANCELLED") {
        loadRequestedRef.current = false;
        setWorkerReady(false);
        setModelState(INITIAL_STATE);
        if (activeRef.current) {
          setWorkerResident(true);
          setWorkerRevision((revision) => revision + 1);
        } else {
          setWorkerResident(false);
        }
      } else if (message.type === "ERROR" && message.scope !== "generate") {
        loadRequestedRef.current = false;
        setModelState((previous) => ({ ...previous, ready: false, loading: false, error: message.message, backend: null }));
      }
    };
    const handleError = (event: ErrorEvent) => {
      loadRequestedRef.current = false;
      workerCrashedRef.current = true;
      setWorkerReady(false);
      setModelState((previous) => ({ ...previous, ready: false, loading: false, error: event.message || "Supertonic 3 worker failed.", backend: null }));
    };
    worker.addEventListener("message", handleMessage as EventListener);
    worker.addEventListener("error", handleError);
    return () => {
      worker.removeEventListener("message", handleMessage as EventListener);
      worker.removeEventListener("error", handleError);
      if (workerRef.current === worker) {
        workerRef.current = null;
        worker.terminate();
      }
      workerCrashedRef.current = false;
      loadRequestedRef.current = false;
    };
  }, [available, createWorker, workerResident, workerRevision]);

  useEffect(() => {
    if (!available || !createWorker) {
      setWorkerResident(false);
      setWorkerReady(false);
      setModelState(INITIAL_STATE);
      return;
    }
    if (active) {
      setWorkerResident(true);
      return;
    }
    if (tts.isGenerating) {
      hardCancelGeneration(false);
      return;
    }
    const timeoutId = window.setTimeout(() => {
      loadRequestedRef.current = false;
      workerCrashedRef.current = false;
      setWorkerReady(false);
      setModelState(INITIAL_STATE);
      setWorkerResident(false);
    }, SUPERTONIC3_IDLE_EVICT_MS);
    return () => window.clearTimeout(timeoutId);
  }, [active, available, createWorker, hardCancelGeneration, tts.isGenerating]);

  useEffect(() => {
    if (active && workerReady && !modelState.ready && !modelState.loading && !modelState.error) loadModel();
  }, [active, loadModel, modelState.error, modelState.loading, modelState.ready, workerReady]);

  useEffect(() => {
    if (!active) {
      if (!tts.isGenerating) streamStartedRef.current = false;
      return;
    }
    if (!tts.isGenerating && streamStartedRef.current) {
      streamStartedRef.current = false;
      endStream();
    }
  }, [active, endStream, tts.isGenerating]);

  const canGenerate = modelState.ready
    && !tts.isGenerating
    && text.trim().length >= MIN_TEXT_LENGTH;
  const handleGenerate = useCallback(() => {
    if (!canGenerate) return;
    resetPlayer();
    beginStream();
    streamStartedRef.current = true;
    setShowPlayer(true);
    generateTts(text, "supertonic3", voice, { ...generationSettings, language });
  }, [beginStream, canGenerate, generateTts, generationSettings, language, resetPlayer, setShowPlayer, text, voice]);
  const handleStop = useCallback(() => {
    hardCancelGeneration(true);
    stopAll();
  }, [hardCancelGeneration, stopAll]);
  const cancelActiveGeneration = useCallback(() => {
    if (tts.isGenerating) {
      hardCancelGeneration(activeRef.current);
    }
  }, [hardCancelGeneration, tts.isGenerating]);
  const resetGeneratedAudio = useCallback(() => {
    streamStartedRef.current = false;
    cancelActiveGeneration();
    resetPlayer();
    setShowPlayer(false);
  }, [cancelActiveGeneration, resetPlayer, setShowPlayer]);
  const retryLoad = useCallback(() => {
    if (!available || !createWorker) return;
    if (!workerRef.current || workerCrashedRef.current) {
      loadRequestedRef.current = false;
      setModelState((previous) => ({ ...previous, ready: false, loading: false, error: null, backend: null }));
      setWorkerRevision((revision) => revision + 1);
      return;
    }
    loadModel(false);
  }, [available, createWorker, loadModel]);

  return useMemo(() => ({
    modelState,
    canGenerate,
    isGenerating: tts.isGenerating,
    generationProgress: tts.generationProgress,
    stats: tts.stats,
    error: tts.error,
    handleGenerate,
    handleStop,
    cancelActiveGeneration,
    resetGeneratedAudio,
    retryLoad,
  }), [
    cancelActiveGeneration,
    canGenerate,
    handleGenerate,
    handleStop,
    modelState,
    resetGeneratedAudio,
    retryLoad,
    tts.error,
    tts.generationProgress,
    tts.isGenerating,
    tts.stats,
  ]);
}
