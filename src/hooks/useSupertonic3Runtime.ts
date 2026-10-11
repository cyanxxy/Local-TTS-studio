import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MIN_TEXT_LENGTH } from "../constants";
import type { EngineRuntime, SynthesisRequest } from "../shared/engineRuntime";
import type { GenerationTuningSettings, ModelState, WorkerOutMessage } from "../types";
import type { UseAudioPlayerReturn } from "./useAudioPlayer";
import { useSynthesisQueue } from "./useSynthesisQueue";
import { useTTS } from "./useTTS";
import { streamWorkerGeneration, workerGenerateRequest } from "./workerGeneration";

interface Options {
  available: boolean;
  /** The visible surface runs Supertonic 3: its worker starts and its model loads. */
  active: boolean;
  /**
   * Some surface still selects Supertonic 3, so a loaded worker stays resident
   * while no visible surface runs it instead of being evicted when idle.
   */
  retain?: boolean;
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
const UNAVAILABLE = "Supertonic 3 is not available in this build.";

/** A loaded worker held for one synthesize request. */
interface WorkerHold {
  worker: Worker;
  lifetime: AbortSignal;
  release: () => void;
}

export function useSupertonic3Runtime({
  available,
  active,
  retain = false,
  createWorker,
  text,
  voice,
  language,
  generationSettings,
  player,
  setShowPlayer,
}: Options): EngineRuntime<"supertonic3"> {
  const supported = available && typeof createWorker === "function";
  const [modelState, setModelState] = useState<ModelState>(INITIAL_STATE);
  const [workerRevision, setWorkerRevision] = useState(0);
  const [workerResident, setWorkerResident] = useState(supported && active);
  // Outstanding synthesize holds; a held worker is started, loaded and kept.
  const [holds, setHolds] = useState(0);
  const inUse = active || holds > 0;
  // Whatever needs the model brings its worker back in this same commit.
  if (supported && inUse && !workerResident) setWorkerResident(true);
  const workerRef = useRef<Worker | null>(null);
  // Aborts when the current worker is terminated or replaced.
  const workerLifetimeRef = useRef<AbortController | null>(null);
  // The current worker reported its model loaded.
  const workerLoadedRef = useRef(false);
  // The last load failure, until the next load or worker starts.
  const loadFailureRef = useRef<string | null>(null);
  // Wakes pending holds whenever the worker or its load changes.
  const holdListenersRef = useRef(new Set<() => void>());
  const loadRequestedRef = useRef(false);
  const workerCrashedRef = useRef(false);
  const streamStartedRef = useRef(false);
  const synthesisSeqRef = useRef(0);
  const activeRef = useRef(active);
  const inUseRef = useRef(inUse);

  // Declared first so every effect below reads this commit's values.
  useEffect(() => {
    activeRef.current = active;
    inUseRef.current = inUse;
  }, [active, inUse]);

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
  const { queue, busy: synthesisBusy, holdForeground } = useSynthesisQueue(tts.isGenerating);

  const notifyHolds = useCallback(() => {
    for (const listener of [...holdListenersRef.current]) listener();
  }, []);

  const failLoad = useCallback((message: string) => {
    loadRequestedRef.current = false;
    loadFailureRef.current = message;
    setModelState((previous) => ({ ...previous, ready: false, loading: false, error: message, backend: null }));
    notifyHolds();
  }, [notifyHolds]);

  /** Forgets the current worker, which has been or is about to be terminated. */
  const releaseWorker = useCallback(() => {
    workerRef.current = null;
    workerLoadedRef.current = false;
    workerLifetimeRef.current?.abort();
    workerLifetimeRef.current = null;
    notifyHolds();
  }, [notifyHolds]);

  const hardCancelGeneration = useCallback((recreate: boolean) => {
    cancelTts();
    const worker = workerRef.current;
    releaseWorker();
    worker?.terminate();
    loadRequestedRef.current = false;
    workerCrashedRef.current = false;
    streamStartedRef.current = false;
    setModelState(INITIAL_STATE);
    if (recreate && supported) {
      setWorkerResident(true);
      setWorkerRevision((revision) => revision + 1);
    } else {
      setWorkerResident(false);
    }
  }, [cancelTts, releaseWorker, supported]);

  /**
   * Posts LOAD to the current worker. The worker reports its progress at once,
   * so the loading state follows from its messages. Returns the failure when
   * the worker refuses the message (it crashed), for the caller to report.
   */
  const postLoad = useCallback((forceReload: boolean): string | null => {
    const worker = workerRef.current;
    if (!worker || loadRequestedRef.current) return null;
    loadRequestedRef.current = true;
    loadFailureRef.current = null;
    try {
      worker.postMessage({ type: "LOAD", forceReload });
      return null;
    } catch (error) {
      workerCrashedRef.current = true;
      return error instanceof Error ? error.message : String(error);
    }
  }, []);

  const loadModel = useCallback((forceReload = false) => {
    if (!supported || !workerRef.current || loadRequestedRef.current) return;
    setModelState((previous) => ({
      ...previous,
      ready: forceReload ? false : previous.ready,
      loading: true,
      downloadProgress: 0,
      error: null,
      backend: forceReload ? null : previous.backend,
    }));
    const failure = postLoad(forceReload);
    if (failure !== null) failLoad(failure);
  }, [failLoad, postLoad, supported]);

  useEffect(() => {
    if (!supported || !workerResident) return;
    let disposed = false;
    let worker: Worker;
    try {
      worker = createWorker!();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      queueMicrotask(() => {
        if (!disposed) failLoad(message);
      });
      return () => {
        disposed = true;
      };
    }
    workerRef.current = worker;
    workerLoadedRef.current = false;
    workerLifetimeRef.current = new AbortController();
    loadFailureRef.current = null;
    workerCrashedRef.current = false;
    const handleMessage = (event: MessageEvent<WorkerOutMessage>) => {
      const message = event.data;
      if (message.type === "LOAD_PROGRESS") {
        setModelState((previous) => ({ ...previous, loading: true, downloadProgress: message.percent, error: null }));
      } else if (message.type === "READY") {
        loadRequestedRef.current = false;
        workerLoadedRef.current = true;
        setModelState({ ready: true, loading: false, downloadProgress: 100, error: null, backend: message.backend ?? null });
        notifyHolds();
      } else if (message.type === "CANCELLED") {
        loadRequestedRef.current = false;
        setModelState(INITIAL_STATE);
        if (workerRef.current === worker) releaseWorker();
        if (activeRef.current) {
          setWorkerResident(true);
          setWorkerRevision((revision) => revision + 1);
        } else {
          setWorkerResident(false);
        }
      } else if (message.type === "ERROR" && message.scope !== "generate") {
        failLoad(message.message);
      }
    };
    const handleError = (event: ErrorEvent) => {
      workerCrashedRef.current = true;
      failLoad(event.message || "Supertonic 3 worker failed.");
    };
    worker.addEventListener("message", handleMessage as EventListener);
    worker.addEventListener("error", handleError);
    // A worker starts because something needs its model, so it loads at once.
    if (inUseRef.current) {
      const failure = postLoad(false);
      if (failure !== null) {
        queueMicrotask(() => {
          if (!disposed) failLoad(failure);
        });
      }
    }
    notifyHolds();
    return () => {
      disposed = true;
      worker.removeEventListener("message", handleMessage as EventListener);
      worker.removeEventListener("error", handleError);
      if (workerRef.current === worker) {
        releaseWorker();
        worker.terminate();
      }
      workerCrashedRef.current = false;
      loadRequestedRef.current = false;
    };
  }, [createWorker, failLoad, notifyHolds, postLoad, releaseWorker, supported, workerResident, workerRevision]);

  // A worker nothing needs is evicted after a grace period. A generation it
  // is still running belongs to the surface that started it; the caller stops
  // that when the surface goes away.
  useEffect(() => {
    if (!supported || inUse || retain || tts.isGenerating) return;
    const timeoutId = window.setTimeout(() => {
      loadRequestedRef.current = false;
      workerCrashedRef.current = false;
      setModelState(INITIAL_STATE);
      setWorkerResident(false);
    }, SUPERTONIC3_IDLE_EVICT_MS);
    return () => window.clearTimeout(timeoutId);
  }, [inUse, retain, supported, tts.isGenerating]);

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

  const visibleModelState = supported ? modelState : INITIAL_STATE;
  const canGenerate = visibleModelState.ready
    && !tts.isGenerating
    && !synthesisBusy
    && text.trim().length >= MIN_TEXT_LENGTH;
  const handleGenerate = useCallback(() => {
    if (!canGenerate) return;
    holdForeground();
    resetPlayer();
    beginStream();
    streamStartedRef.current = true;
    setShowPlayer(true);
    generateTts(text, "supertonic3", voice, { ...generationSettings, language });
  }, [
    beginStream,
    canGenerate,
    generateTts,
    generationSettings,
    holdForeground,
    language,
    resetPlayer,
    setShowPlayer,
    text,
    voice,
  ]);
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
    if (!supported) return;
    loadFailureRef.current = null;
    if (!workerRef.current || workerCrashedRef.current) {
      loadRequestedRef.current = false;
      setModelState((previous) => ({ ...previous, ready: false, loading: false, error: null, backend: null }));
      setWorkerResident(true);
      setWorkerRevision((revision) => revision + 1);
      return;
    }
    loadModel(false);
  }, [loadModel, supported]);

  /**
   * Resolves with the worker once its model has loaded, starting both when
   * needed; the worker stays resident until `release`. A failure from before
   * the call gets one fresh attempt, and one after it rejects.
   */
  const holdWorker = useCallback((signal: AbortSignal) => new Promise<WorkerHold>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    if (!supported) {
      reject(new Error(UNAVAILABLE));
      return;
    }
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      setHolds((count) => Math.max(0, count - 1));
    };
    let retried = false;
    const settle = () => {
      holdListenersRef.current.delete(check);
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (error: unknown) => {
      settle();
      release();
      reject(error);
    };
    function onAbort() {
      fail(signal.reason);
    }
    function check() {
      const worker = workerRef.current;
      const lifetime = workerLifetimeRef.current;
      if (worker && lifetime && workerLoadedRef.current) {
        settle();
        resolve({ worker, lifetime: lifetime.signal, release });
        return;
      }
      const failure = loadFailureRef.current;
      if (failure === null) {
        // A resident worker that has not been asked to load yet (it started
        // while nothing needed it) loads now.
        if (worker && !loadRequestedRef.current) loadModel(false);
        return;
      }
      if (retried) {
        fail(new Error(failure));
        return;
      }
      retried = true;
      retryLoad();
    }

    setHolds((count) => count + 1);
    holdListenersRef.current.add(check);
    signal.addEventListener("abort", onAbort, { once: true });
    check();
  }), [loadModel, retryLoad, supported]);

  const synthesize = useCallback((request: SynthesisRequest<"supertonic3">) => queue.enqueue((signal) => (
    (async function* () {
      const hold = await holdWorker(signal);
      try {
        synthesisSeqRef.current += 1;
        yield* streamWorkerGeneration({
          worker: hold.worker,
          generationId: `supertonic3-synthesize-${synthesisSeqRef.current}`,
          request: workerGenerateRequest(request.text, request.settings.voice, {
            ...request.tuning,
            language: request.settings.language,
          }),
          signal,
          lifetime: hold.lifetime,
          stop: () => {
            hold.release();
            hardCancelGeneration(activeRef.current);
          },
          failureMessage: "Supertonic 3 worker failed.",
          stoppedMessage: "Supertonic 3 stopped before the request finished.",
        });
      } finally {
        hold.release();
      }
    })()
  ), request.signal), [hardCancelGeneration, holdWorker, queue]);

  return useMemo(() => ({
    id: "supertonic3",
    modelState: visibleModelState,
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
    synthesize,
  }), [
    cancelActiveGeneration,
    canGenerate,
    handleGenerate,
    handleStop,
    resetGeneratedAudio,
    retryLoad,
    synthesize,
    tts.error,
    tts.generationProgress,
    tts.isGenerating,
    tts.stats,
    visibleModelState,
  ]);
}
