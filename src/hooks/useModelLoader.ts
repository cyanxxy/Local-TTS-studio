import { useState, useEffect, useRef, useCallback } from "react";
import type { ModelState, ModelType, WorkerOutMessage } from "../types";

interface UseModelLoaderReturn {
  kokoroState: ModelState;
  supertonicState: ModelState;
  kokoroWorker: React.RefObject<Worker | null>;
  supertonicWorker: React.RefObject<Worker | null>;
  kokoroVoices: string[];
  hardRestartModel: (model: ModelType) => void;
  loadModel: (model: ModelType) => void;
  reloadModel: (model: ModelType) => void;
}

interface UseModelLoaderOptions {
  enabled?: boolean;
  preferredSupertonicVoice?: string;
  debugProfiling?: boolean;
  supportedModels?: readonly ModelType[];
}

const INITIAL_MODEL_STATE: ModelState = {
  ready: false,
  loading: false,
  downloadProgress: 0,
  error: null,
  backend: null,
};

const BROWSER_MODEL_IDLE_EVICT_MS = 15_000;

function clampPercent(percent: number): number {
  return Math.max(0, Math.min(100, percent));
}

function workerEventMessage(event: Event, fallback: string): string {
  if (event instanceof ErrorEvent && event.message) return event.message;
  if (event.type === "messageerror") return `${fallback} The worker sent an unreadable message.`;
  return fallback;
}

/**
 * Manages loading both TTS models via Web Workers.
 * Workers are created on startup, but models load lazily when selected.
 * Inactive workers are evicted after a short grace period so their model
 * allocations do not remain resident for the lifetime of the page.
 */
export function useModelLoader(
  activeModel: ModelType,
  {
    enabled = true,
    preferredSupertonicVoice,
    debugProfiling = false,
    supportedModels = ["kokoro", "supertonic"],
  }: UseModelLoaderOptions = {},
): UseModelLoaderReturn {
  const [kokoroState, setKokoroState] = useState<ModelState>(INITIAL_MODEL_STATE);
  const [supertonicState, setSupertonicState] = useState<ModelState>(INITIAL_MODEL_STATE);
  const [kokoroVoices, setKokoroVoices] = useState<string[]>([]);

  const kokoroWorker = useRef<Worker | null>(null);
  const supertonicWorker = useRef<Worker | null>(null);
  const kokoroLoadRequestedRef = useRef(false);
  const supertonicLoadRequestedRef = useRef(false);
  const activeModelRef = useRef(activeModel);
  const preferredSupertonicVoiceRef = useRef(preferredSupertonicVoice);
  const debugProfilingRef = useRef(debugProfiling);
  const supportsKokoro = supportedModels.includes("kokoro");
  const supportsSupertonic = supportedModels.includes("supertonic");
  const [kokoroResident, setKokoroResident] = useState(enabled && supportsKokoro);
  const [supertonicResident, setSupertonicResident] = useState(enabled && supportsSupertonic);
  const [kokoroWorkerRevision, setKokoroWorkerRevision] = useState(0);
  const [supertonicWorkerRevision, setSupertonicWorkerRevision] = useState(0);

  useEffect(() => {
    activeModelRef.current = activeModel;
    preferredSupertonicVoiceRef.current = preferredSupertonicVoice;
    debugProfilingRef.current = debugProfiling;
  }, [activeModel, debugProfiling, preferredSupertonicVoice]);

  const setLoadingState = useCallback((model: ModelType) => {
    const setter = model === "kokoro" ? setKokoroState : setSupertonicState;
    setter((prev) => ({
      ...prev,
      loading: true,
      downloadProgress: 0,
      error: null,
      backend: null,
    }));
  }, []);

  const setLoadFailure = useCallback((model: ModelType, message: string) => {
    const requestedRef = model === "kokoro" ? kokoroLoadRequestedRef : supertonicLoadRequestedRef;
    const setter = model === "kokoro" ? setKokoroState : setSupertonicState;
    requestedRef.current = false;
    setter((prev) => ({
      ...prev,
      ready: false,
      loading: false,
      error: message,
      backend: null,
    }));
  }, []);

  const hardRestartModel = useCallback((model: ModelType) => {
    const isActive = activeModelRef.current === model;
    if (model === "kokoro") {
      const worker = kokoroWorker.current;
      kokoroWorker.current = null;
      worker?.terminate();
      kokoroLoadRequestedRef.current = false;
      setKokoroState(INITIAL_MODEL_STATE);
      setKokoroVoices([]);
      setKokoroResident(isActive);
      if (isActive) setKokoroWorkerRevision((revision) => revision + 1);
      return;
    }

    const worker = supertonicWorker.current;
    supertonicWorker.current = null;
    worker?.terminate();
    supertonicLoadRequestedRef.current = false;
    setSupertonicState(INITIAL_MODEL_STATE);
    setSupertonicResident(isActive);
    if (isActive) setSupertonicWorkerRevision((revision) => revision + 1);
  }, []);

  const loadModel = useCallback((model: ModelType) => {
    if (!enabled) return;
    if (model === "kokoro" && !supportsKokoro) return;
    if (model === "supertonic" && !supportsSupertonic) return;

    const worker = model === "kokoro" ? kokoroWorker.current : supertonicWorker.current;
    const requestedRef = model === "kokoro" ? kokoroLoadRequestedRef : supertonicLoadRequestedRef;
    if (!worker || requestedRef.current) return;

    requestedRef.current = true;
    setLoadingState(model);
    try {
      worker.postMessage({
        type: "LOAD",
        preferredVoice: model === "supertonic" ? preferredSupertonicVoiceRef.current : undefined,
        debugProfiling: debugProfilingRef.current,
      });
    } catch (error) {
      setLoadFailure(model, error instanceof Error ? error.message : String(error));
    }
  }, [enabled, setLoadFailure, setLoadingState, supportsKokoro, supportsSupertonic]);

  const reloadModel = useCallback((model: ModelType) => {
    if (!enabled) return;
    if (model === "kokoro" && !supportsKokoro) return;
    if (model === "supertonic" && !supportsSupertonic) return;

    const worker = model === "kokoro" ? kokoroWorker.current : supertonicWorker.current;
    const requestedRef = model === "kokoro" ? kokoroLoadRequestedRef : supertonicLoadRequestedRef;
    if (!worker || requestedRef.current) return;

    requestedRef.current = true;
    if (model === "kokoro") {
      setKokoroState((prev) => ({
        ...prev,
        ready: false,
        loading: true,
        downloadProgress: 0,
        error: null,
        backend: null,
      }));
    } else {
      setSupertonicState((prev) => ({
        ...prev,
        ready: false,
        loading: true,
        downloadProgress: 0,
        error: null,
        backend: null,
      }));
    }

    try {
      worker.postMessage({
        type: "LOAD",
        forceReload: true,
        preferredVoice: model === "supertonic" ? preferredSupertonicVoiceRef.current : undefined,
        debugProfiling: debugProfilingRef.current,
      });
    } catch (error) {
      setLoadFailure(model, error instanceof Error ? error.message : String(error));
    }
  }, [enabled, setLoadFailure, supportsKokoro, supportsSupertonic]);

  const handleKokoroMessage = useCallback((e: MessageEvent<WorkerOutMessage>) => {
    const msg = e.data;
    switch (msg.type) {
      case "LOAD_PROGRESS":
        setKokoroState((prev) => ({
          ...prev,
          loading: true,
          downloadProgress: clampPercent(msg.percent),
          error: null,
          backend: null,
        }));
        break;
      case "READY":
        kokoroLoadRequestedRef.current = false;
        setKokoroState({
          ready: true,
          loading: false,
          downloadProgress: 100,
          error: null,
          backend: msg.backend ?? null,
        });
        if (msg.voices) setKokoroVoices(msg.voices);
        break;
      case "CANCELLED":
        kokoroLoadRequestedRef.current = false;
        setKokoroState(INITIAL_MODEL_STATE);
        if (activeModelRef.current === "kokoro") {
          setKokoroResident(true);
          setKokoroWorkerRevision((revision) => revision + 1);
        } else {
          setKokoroResident(false);
        }
        break;
      case "ERROR":
        if (msg.scope === "generate") break;
        kokoroLoadRequestedRef.current = false;
        setKokoroState((prev) => ({
          ...prev,
          ready: false,
          loading: false,
          error: msg.message,
          backend: null,
        }));
        break;
    }
  }, []);

  const handleSupertonicMessage = useCallback((e: MessageEvent<WorkerOutMessage>) => {
    const msg = e.data;
    switch (msg.type) {
      case "LOAD_PROGRESS":
        setSupertonicState((prev) => ({
          ...prev,
          loading: true,
          downloadProgress: clampPercent(msg.percent),
          error: null,
          backend: null,
        }));
        break;
      case "READY":
        supertonicLoadRequestedRef.current = false;
        setSupertonicState({
          ready: true,
          loading: false,
          downloadProgress: 100,
          error: null,
          backend: msg.backend ?? null,
        });
        break;
      case "CANCELLED":
        supertonicLoadRequestedRef.current = false;
        setSupertonicState(INITIAL_MODEL_STATE);
        if (activeModelRef.current === "supertonic") {
          setSupertonicResident(true);
          setSupertonicWorkerRevision((revision) => revision + 1);
        } else {
          setSupertonicResident(false);
        }
        break;
      case "ERROR":
        if (msg.scope === "generate") break;
        supertonicLoadRequestedRef.current = false;
        setSupertonicState((prev) => ({
          ...prev,
          ready: false,
          loading: false,
          error: msg.message,
          backend: null,
        }));
        break;
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    if (!enabled) {
      kokoroLoadRequestedRef.current = false;
      supertonicLoadRequestedRef.current = false;
      queueMicrotask(() => {
        if (disposed) return;
        setKokoroResident(false);
        setSupertonicResident(false);
        setKokoroState(INITIAL_MODEL_STATE);
        setSupertonicState(INITIAL_MODEL_STATE);
      });
      return () => {
        disposed = true;
      };
    }

    queueMicrotask(() => {
      if (disposed) return;
      if (!supportsKokoro) setKokoroResident(false);
      if (!supportsSupertonic) setSupertonicResident(false);

      if (activeModel === "kokoro" && supportsKokoro) {
        setKokoroResident(true);
      } else if (activeModel === "supertonic" && supportsSupertonic) {
        setSupertonicResident(true);
      }
    });

    const inactiveModel = activeModel === "kokoro" ? "supertonic" : "kokoro";
    const timeoutId = window.setTimeout(() => {
      if (inactiveModel === "kokoro") {
        kokoroLoadRequestedRef.current = false;
        setKokoroState(INITIAL_MODEL_STATE);
        setKokoroVoices([]);
        setKokoroResident(false);
      } else {
        supertonicLoadRequestedRef.current = false;
        setSupertonicState(INITIAL_MODEL_STATE);
        setSupertonicResident(false);
      }
    }, BROWSER_MODEL_IDLE_EVICT_MS);

    return () => {
      disposed = true;
      window.clearTimeout(timeoutId);
    };
  }, [activeModel, enabled, supportsKokoro, supportsSupertonic]);

  useEffect(() => {
    if (!enabled || !supportsKokoro || !kokoroResident) {
      kokoroWorker.current = null;
      return;
    }

    let worker: Worker | null = null;
    let disposed = false;
    const reportLoadFailure = (model: ModelType, message: string) => {
      queueMicrotask(() => {
        if (!disposed) {
          setLoadFailure(model, message);
        }
      });
    };

    try {
      worker = new Worker(
        new URL("../workers/kokoro.worker.ts", import.meta.url),
        { type: "module" },
      );
    } catch (error) {
      reportLoadFailure("kokoro", error instanceof Error ? error.message : String(error));
    }

    if (worker) {
      worker.onmessage = handleKokoroMessage;
      worker.onerror = (event) => {
        setLoadFailure("kokoro", workerEventMessage(event, "Kokoro worker failed."));
      };
      worker.onmessageerror = (event) => {
        setLoadFailure("kokoro", workerEventMessage(event, "Kokoro worker failed."));
      };
    }

    kokoroWorker.current = worker;

    return () => {
      disposed = true;
      kokoroLoadRequestedRef.current = false;
      if (kokoroWorker.current === worker) {
        kokoroWorker.current = null;
        worker?.terminate();
      }
    };
  }, [
    enabled,
    handleKokoroMessage,
    kokoroResident,
    kokoroWorkerRevision,
    setLoadFailure,
    supportsKokoro,
  ]);

  useEffect(() => {
    if (!enabled || !supportsSupertonic || !supertonicResident) {
      supertonicWorker.current = null;
      return;
    }

    let worker: Worker | null = null;
    let disposed = false;
    const reportLoadFailure = (message: string) => {
      queueMicrotask(() => {
        if (!disposed) setLoadFailure("supertonic", message);
      });
    };

    try {
      worker = new Worker(
        new URL("../workers/supertonic.worker.ts", import.meta.url),
        { type: "module" },
      );
    } catch (error) {
      reportLoadFailure(error instanceof Error ? error.message : String(error));
    }

    if (worker) {
      worker.onmessage = handleSupertonicMessage;
      worker.onerror = (event) => {
        setLoadFailure("supertonic", workerEventMessage(event, "Supertonic worker failed."));
      };
      worker.onmessageerror = (event) => {
        setLoadFailure("supertonic", workerEventMessage(event, "Supertonic worker failed."));
      };
    }

    supertonicWorker.current = worker;

    return () => {
      disposed = true;
      supertonicLoadRequestedRef.current = false;
      if (supertonicWorker.current === worker) {
        supertonicWorker.current = null;
        worker?.terminate();
      }
    };
  }, [
    enabled,
    handleSupertonicMessage,
    setLoadFailure,
    supertonicResident,
    supertonicWorkerRevision,
    supportsSupertonic,
  ]);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    queueMicrotask(() => {
      if (!disposed) {
        loadModel(activeModel);
      }
    });
    return () => {
      disposed = true;
    };
  }, [
    activeModel,
    enabled,
    kokoroResident,
    kokoroWorkerRevision,
    loadModel,
    supertonicResident,
    supertonicWorkerRevision,
  ]);

  const visibleKokoroState = enabled ? kokoroState : INITIAL_MODEL_STATE;
  const visibleSupertonicState = enabled ? supertonicState : INITIAL_MODEL_STATE;
  const visibleKokoroVoices = enabled ? kokoroVoices : [];

  return {
    kokoroState: visibleKokoroState,
    supertonicState: visibleSupertonicState,
    kokoroWorker,
    supertonicWorker,
    kokoroVoices: visibleKokoroVoices,
    hardRestartModel,
    loadModel,
    reloadModel,
  };
}
