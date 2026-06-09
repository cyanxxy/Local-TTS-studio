import { useState, useEffect, useRef, useCallback } from "react";
import type { ModelState, ModelType, WorkerOutMessage } from "../types";

interface UseModelLoaderReturn {
  kokoroState: ModelState;
  supertonicState: ModelState;
  kokoroWorker: React.RefObject<Worker | null>;
  supertonicWorker: React.RefObject<Worker | null>;
  kokoroVoices: string[];
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
 * Workers are singletons — never recreated unless the page refreshes.
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
  const preferredSupertonicVoiceRef = useRef(preferredSupertonicVoice);
  const debugProfilingRef = useRef(debugProfiling);
  const supportsKokoro = supportedModels.includes("kokoro");
  const supportsSupertonic = supportedModels.includes("supertonic");

  useEffect(() => {
    preferredSupertonicVoiceRef.current = preferredSupertonicVoice;
    debugProfilingRef.current = debugProfiling;
  }, [debugProfiling, preferredSupertonicVoice]);

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
    if (!enabled) {
      kokoroLoadRequestedRef.current = false;
      supertonicLoadRequestedRef.current = false;
      kokoroWorker.current = null;
      supertonicWorker.current = null;
      return;
    }

    let kWorker: Worker | null = null;
    let sWorker: Worker | null = null;
    let disposed = false;
    const reportLoadFailure = (model: ModelType, message: string) => {
      queueMicrotask(() => {
        if (!disposed) {
          setLoadFailure(model, message);
        }
      });
    };

    if (supportsKokoro) {
      try {
        kWorker = new Worker(
          new URL("../workers/kokoro.worker.ts", import.meta.url),
          { type: "module" },
        );
      } catch (error) {
        reportLoadFailure("kokoro", error instanceof Error ? error.message : String(error));
      }
    }

    if (supportsSupertonic) {
      try {
        sWorker = new Worker(
          new URL("../workers/supertonic.worker.ts", import.meta.url),
          { type: "module" },
        );
      } catch (error) {
        reportLoadFailure("supertonic", error instanceof Error ? error.message : String(error));
      }
    }

    if (kWorker) {
      kWorker.onmessage = handleKokoroMessage;
      kWorker.onerror = (event) => {
        setLoadFailure("kokoro", workerEventMessage(event, "Kokoro worker failed."));
      };
      kWorker.onmessageerror = (event) => {
        setLoadFailure("kokoro", workerEventMessage(event, "Kokoro worker failed."));
      };
    }
    if (sWorker) {
      sWorker.onmessage = handleSupertonicMessage;
      sWorker.onerror = (event) => {
        setLoadFailure("supertonic", workerEventMessage(event, "Supertonic worker failed."));
      };
      sWorker.onmessageerror = (event) => {
        setLoadFailure("supertonic", workerEventMessage(event, "Supertonic worker failed."));
      };
    }

    kokoroWorker.current = kWorker;
    supertonicWorker.current = sWorker;

    return () => {
      disposed = true;
      kokoroLoadRequestedRef.current = false;
      supertonicLoadRequestedRef.current = false;
      kokoroWorker.current = null;
      supertonicWorker.current = null;
      kWorker?.terminate();
      sWorker?.terminate();
    };
  }, [
    enabled,
    handleKokoroMessage,
    handleSupertonicMessage,
    setLoadFailure,
    supportsKokoro,
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
  }, [activeModel, enabled, loadModel]);

  const visibleKokoroState = enabled ? kokoroState : INITIAL_MODEL_STATE;
  const visibleSupertonicState = enabled ? supertonicState : INITIAL_MODEL_STATE;
  const visibleKokoroVoices = enabled ? kokoroVoices : [];

  return {
    kokoroState: visibleKokoroState,
    supertonicState: visibleSupertonicState,
    kokoroWorker,
    supertonicWorker,
    kokoroVoices: visibleKokoroVoices,
    loadModel,
    reloadModel,
  };
}
