import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { BROWSER_ENGINE_IDS, ENGINES, type BrowserEngineId } from "../models/registry";
import type { ModelState, WorkerOutMessage } from "../types";
import { BROWSER_WORKER_FACTORIES } from "./browserWorkers";
import { workerEventMessage } from "./workerGeneration";

type EngineRecord<T> = { readonly [Id in BrowserEngineId]: T };

/** A live worker together with what callers may need to know about it. */
export interface BrowserWorkerLease {
  worker: Worker;
  /** Aborts when the pool terminates or replaces this worker. */
  lifetime: AbortSignal;
  /** Whether the worker reported its model loaded. */
  ready: boolean;
}

/** A loaded worker held for one piece of work; `release` lets the pool evict it again. */
export interface AcquiredBrowserWorker {
  worker: Worker;
  lifetime: AbortSignal;
  release: () => void;
}

export interface UseModelLoaderReturn {
  states: EngineRecord<ModelState>;
  /** Voice ids each loaded model reported; empty until it has loaded. */
  voices: EngineRecord<string[]>;
  /** The engine's current worker, or null while it is not resident. */
  getWorker: (model: BrowserEngineId) => Worker | null;
  getWorkerLease: (model: BrowserEngineId) => BrowserWorkerLease | null;
  /**
   * Resolves with the engine's worker once its model has loaded, starting the
   * worker and the load when needed, whichever engine is selected. The worker
   * stays resident until `release`. Rejects when the model cannot load, the
   * browser cannot run the engine, the pool unmounts, or `signal` aborts.
   */
  acquireWorker: (model: BrowserEngineId, signal: AbortSignal) => Promise<AcquiredBrowserWorker>;
  hardRestartModel: (model: BrowserEngineId) => void;
  loadModel: (model: BrowserEngineId) => void;
  reloadModel: (model: BrowserEngineId) => void;
}

export interface UseModelLoaderOptions {
  /** A visible surface runs the browser model: its worker starts and its model loads. */
  active?: boolean;
  /**
   * Some surface still selects the browser model. Its resident worker then
   * stays loaded while no visible surface uses it, instead of being evicted
   * after the idle grace period. `active` implies it.
   */
  retain?: boolean;
  /** Passed to an engine's worker when it loads, e.g. the Supertonic 2 voice to warm. */
  preferredVoices?: Partial<Record<BrowserEngineId, string>>;
  debugProfiling?: boolean;
  supportedModels?: readonly BrowserEngineId[];
}

const INITIAL_MODEL_STATE: ModelState = {
  ready: false,
  loading: false,
  downloadProgress: 0,
  error: null,
  backend: null,
};

const NO_VOICES: string[] = [];

/** How long a browser model no surface uses stays loaded before its worker is evicted. */
export const BROWSER_MODEL_IDLE_EVICT_MS = 15_000;

interface PoolEntry {
  resident: boolean;
  /**
   * Identifies one worker lifetime. Every (re)start bumps it, and a worker is
   * spawned at most once per revision, so a render that still shows an older
   * revision can never resurrect a worker that was deliberately retired.
   */
  revision: number;
  /** Outstanding `acquireWorker` holds; a held engine is never evicted. */
  holds: number;
  state: ModelState;
  voices: string[];
}

type PoolState = EngineRecord<PoolEntry>;

type PoolAction =
  | { type: "reside"; model: BrowserEngineId }
  | { type: "hold"; model: BrowserEngineId }
  | { type: "release"; model: BrowserEngineId }
  | { type: "state"; model: BrowserEngineId; update: (state: ModelState) => ModelState }
  | { type: "ready"; model: BrowserEngineId; state: ModelState; voices?: string[] }
  /**
   * The worker is gone: start a fresh one (`respawn`), or leave the engine
   * unloaded. A held engine always comes back.
   */
  | { type: "restart"; model: BrowserEngineId; respawn: boolean; forgetVoices: boolean };

function clampPercent(percent: number): number {
  return Math.max(0, Math.min(100, percent));
}

function mapEngines<T>(map: (model: BrowserEngineId) => T): EngineRecord<T> {
  return Object.fromEntries(BROWSER_ENGINE_IDS.map((model) => [model, map(model)])) as EngineRecord<T>;
}

function initialPool(resident: BrowserEngineId | null): PoolState {
  return mapEngines((model) => ({
    resident: model === resident,
    revision: 0,
    holds: 0,
    state: INITIAL_MODEL_STATE,
    voices: NO_VOICES,
  }));
}

function reside(entry: PoolEntry): PoolEntry {
  return entry.resident ? entry : { ...entry, resident: true, revision: entry.revision + 1 };
}

function poolReducer(pool: PoolState, action: PoolAction): PoolState {
  const entry = pool[action.model];
  let next: PoolEntry;
  switch (action.type) {
    case "reside":
      next = reside(entry);
      if (next === entry) return pool;
      break;
    case "hold":
      next = { ...reside(entry), holds: entry.holds + 1 };
      break;
    case "release":
      next = { ...entry, holds: Math.max(0, entry.holds - 1) };
      break;
    case "state":
      next = { ...entry, state: action.update(entry.state) };
      break;
    case "ready":
      next = { ...entry, state: action.state, voices: action.voices ?? entry.voices };
      break;
    case "restart": {
      const respawn = action.respawn || entry.holds > 0;
      if (!respawn && !entry.resident && entry.state === INITIAL_MODEL_STATE
        && (!action.forgetVoices || entry.voices === NO_VOICES)) return pool;
      next = {
        ...entry,
        resident: respawn,
        revision: respawn ? entry.revision + 1 : entry.revision,
        state: INITIAL_MODEL_STATE,
        voices: action.forgetVoices ? NO_VOICES : entry.voices,
      };
      break;
    }
  }
  return { ...pool, [action.model]: next };
}

interface Lease extends BrowserWorkerLease {
  revision: number;
  retire: AbortController;
  /** The last load failure, until the next load starts. */
  failure: string | null;
}

/**
 * The browser engines' module workers, one per registry engine with
 * `picker: "browser"`.
 *
 * Only the selected engine's worker starts, and only once a visible surface
 * runs it (or `acquireWorker` asks for an engine). Every other worker is
 * evicted after `BROWSER_MODEL_IDLE_EVICT_MS`, and so is the selected one when
 * no surface selects the browser model any more (`retain`), so model
 * allocations never outlive their use by long.
 */
export function useModelLoader(
  activeModel: BrowserEngineId,
  {
    active = true,
    retain = false,
    preferredVoices,
    debugProfiling = false,
    supportedModels = BROWSER_ENGINE_IDS,
  }: UseModelLoaderOptions = {},
): UseModelLoaderReturn {
  const supportsActive = supportedModels.includes(activeModel);
  const [pool, dispatch] = useReducer(
    poolReducer,
    active && supportsActive ? activeModel : null,
    initialPool,
  );
  // The selected engine joins the pool the moment a visible surface runs it;
  // adjusting during render spawns its worker in this same commit.
  if (active && supportsActive && !pool[activeModel].resident) {
    dispatch({ type: "reside", model: activeModel });
  }

  const leasesRef = useRef(new Map<BrowserEngineId, Lease>());
  const loadRequestedRef = useRef(new Set<BrowserEngineId>());
  // The last revision each engine had a worker constructed (or attempted) for.
  const spawnedRevisionRef = useRef(new Map<BrowserEngineId, number>());
  // Why an engine's latest worker could not be constructed, until one is.
  const spawnFailuresRef = useRef(new Map<BrowserEngineId, string>());
  const evictionTimersRef = useRef(new Map<BrowserEngineId, number>());
  // Wakes pending `acquireWorker` calls whenever a lease changes.
  const listenersRef = useRef(new Set<() => void>());
  const disposedRef = useRef(false);
  const activeModelRef = useRef(activeModel);
  const activeRef = useRef(active);
  const preferredVoicesRef = useRef(preferredVoices);
  const debugProfilingRef = useRef(debugProfiling);
  const supportedKey = supportedModels.join(",");

  useEffect(() => {
    activeModelRef.current = activeModel;
    activeRef.current = active;
    preferredVoicesRef.current = preferredVoices;
    debugProfilingRef.current = debugProfiling;
  }, [active, activeModel, debugProfiling, preferredVoices]);

  const isSupported = useCallback(
    (model: BrowserEngineId) => supportedKey.split(",").includes(model),
    [supportedKey],
  );

  const notify = useCallback(() => {
    for (const listener of [...listenersRef.current]) listener();
  }, []);

  /** Terminates the engine's worker, if any, and fails whatever was waiting on it. */
  const retireWorker = useCallback((model: BrowserEngineId) => {
    loadRequestedRef.current.delete(model);
    const lease = leasesRef.current.get(model);
    if (!lease) return;
    leasesRef.current.delete(model);
    lease.worker.onmessage = null;
    lease.worker.onerror = null;
    lease.worker.onmessageerror = null;
    lease.worker.terminate();
    lease.retire.abort();
    notify();
  }, [notify]);

  /** The selected engine comes straight back while a visible surface runs it. */
  const shouldRespawn = useCallback(
    (model: BrowserEngineId) => activeRef.current && activeModelRef.current === model,
    [],
  );

  const setLoadFailure = useCallback((model: BrowserEngineId, message: string) => {
    loadRequestedRef.current.delete(model);
    const lease = leasesRef.current.get(model);
    if (lease) lease.failure = message;
    dispatch({
      type: "state",
      model,
      update: (state) => ({ ...state, ready: false, loading: false, error: message, backend: null }),
    });
    notify();
  }, [notify]);

  const hardRestartModel = useCallback((model: BrowserEngineId) => {
    retireWorker(model);
    dispatch({ type: "restart", model, respawn: shouldRespawn(model), forgetVoices: true });
  }, [retireWorker, shouldRespawn]);

  const handleMessage = useCallback((model: BrowserEngineId, worker: Worker, message: WorkerOutMessage) => {
    const lease = leasesRef.current.get(model);
    if (lease?.worker !== worker) return;
    switch (message.type) {
      case "LOAD_PROGRESS":
        dispatch({
          type: "state",
          model,
          update: (state) => ({
            ...state,
            loading: true,
            downloadProgress: clampPercent(message.percent),
            error: null,
            backend: null,
          }),
        });
        break;
      case "READY":
        loadRequestedRef.current.delete(model);
        lease.ready = true;
        lease.failure = null;
        dispatch({
          type: "ready",
          model,
          state: { ready: true, loading: false, downloadProgress: 100, error: null, backend: message.backend ?? null },
          voices: message.voices,
        });
        notify();
        break;
      case "CANCELLED":
        // The worker closed itself after a hard cancel.
        retireWorker(model);
        dispatch({ type: "restart", model, respawn: shouldRespawn(model), forgetVoices: false });
        break;
      case "ERROR":
        if (message.scope === "generate") break;
        setLoadFailure(model, message.message);
        break;
    }
  }, [notify, retireWorker, setLoadFailure, shouldRespawn]);

  // Starts every worker the pool wants and retires every one it no longer
  // does. Diffing against the live leases keeps each worker for exactly as
  // long as its engine stays resident at the same revision.
  useEffect(() => {
    const leases = leasesRef.current;
    for (const model of BROWSER_ENGINE_IDS) {
      const entry = pool[model];
      const wanted = entry.resident && isSupported(model);
      const lease = leases.get(model);
      if (lease && (!wanted || lease.revision !== entry.revision)) retireWorker(model);
      if (!wanted || leases.has(model) || entry.revision <= (spawnedRevisionRef.current.get(model) ?? -1)) continue;
      spawnedRevisionRef.current.set(model, entry.revision);

      let worker: Worker;
      try {
        worker = BROWSER_WORKER_FACTORIES[model]();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        spawnFailuresRef.current.set(model, message);
        queueMicrotask(() => setLoadFailure(model, message));
        continue;
      }
      spawnFailuresRef.current.delete(model);
      const failure = `${ENGINES[model].label} worker failed.`;
      worker.onmessage = (event: MessageEvent<WorkerOutMessage>) => handleMessage(model, worker, event.data);
      worker.onerror = (event) => {
        if (leases.get(model)?.worker === worker) setLoadFailure(model, workerEventMessage(event, failure));
      };
      worker.onmessageerror = (event) => {
        if (leases.get(model)?.worker === worker) setLoadFailure(model, workerEventMessage(event, failure));
      };
      const retire = new AbortController();
      leases.set(model, {
        worker,
        lifetime: retire.signal,
        ready: false,
        revision: entry.revision,
        retire,
        failure: null,
      });
      notify();
    }
  }, [handleMessage, isSupported, notify, pool, retireWorker, setLoadFailure]);

  useEffect(() => {
    const timers = evictionTimersRef.current;
    const listeners = listenersRef.current;
    const spawnedRevisions = spawnedRevisionRef.current;
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      for (const timeoutId of timers.values()) window.clearTimeout(timeoutId);
      timers.clear();
      for (const model of BROWSER_ENGINE_IDS) retireWorker(model);
      // Every worker is gone, so a remount (StrictMode replays effects) may
      // start the current revisions again.
      spawnedRevisions.clear();
      for (const listener of [...listeners]) listener();
    };
  }, [retireWorker]);

  const startLoad = useCallback((model: BrowserEngineId, forceReload: boolean) => {
    const lease = leasesRef.current.get(model);
    if (!lease || !isSupported(model) || loadRequestedRef.current.has(model)) return;
    if (lease.ready && !forceReload) return;
    loadRequestedRef.current.add(model);
    lease.ready = false;
    lease.failure = null;
    dispatch({
      type: "state",
      model,
      update: (state) => ({
        ...state,
        ready: forceReload ? false : state.ready,
        loading: true,
        downloadProgress: 0,
        error: null,
        backend: null,
      }),
    });
    try {
      lease.worker.postMessage({
        type: "LOAD",
        ...(forceReload ? { forceReload: true } : {}),
        preferredVoice: preferredVoicesRef.current?.[model],
        debugProfiling: debugProfilingRef.current,
      });
    } catch (error) {
      setLoadFailure(model, error instanceof Error ? error.message : String(error));
    }
  }, [isSupported, setLoadFailure]);

  const loadModel = useCallback((model: BrowserEngineId) => startLoad(model, false), [startLoad]);
  const reloadModel = useCallback((model: BrowserEngineId) => startLoad(model, true), [startLoad]);

  const activeEntry = pool[activeModel];
  // Loads the selected engine once its worker is up. It runs a microtask
  // after the spawn pass above so the worker exists by then.
  useEffect(() => {
    if (!active || !activeEntry.resident) return;
    let disposed = false;
    queueMicrotask(() => {
      if (!disposed) loadModel(activeModel);
    });
    return () => {
      disposed = true;
    };
  }, [active, activeEntry.resident, activeEntry.revision, activeModel, loadModel]);

  // Gives every resident worker that nothing needs one grace period, then
  // evicts it. A worker that becomes needed again within it keeps running.
  useEffect(() => {
    const timers = evictionTimersRef.current;
    for (const model of BROWSER_ENGINE_IDS) {
      const entry = pool[model];
      const needed = !entry.resident || entry.holds > 0 || ((active || retain) && model === activeModel);
      const timeoutId = timers.get(model);
      if (needed) {
        if (timeoutId !== undefined) window.clearTimeout(timeoutId);
        timers.delete(model);
      } else if (timeoutId === undefined) {
        timers.set(model, window.setTimeout(() => {
          timers.delete(model);
          retireWorker(model);
          dispatch({ type: "restart", model, respawn: false, forgetVoices: true });
        }, BROWSER_MODEL_IDLE_EVICT_MS));
      }
    }
  }, [active, activeModel, pool, retain, retireWorker]);

  const getWorker = useCallback((model: BrowserEngineId) => leasesRef.current.get(model)?.worker ?? null, []);
  const getWorkerLease = useCallback((model: BrowserEngineId): BrowserWorkerLease | null => (
    leasesRef.current.get(model) ?? null
  ), []);

  const acquireWorker = useCallback((model: BrowserEngineId, signal: AbortSignal) => (
    new Promise<AcquiredBrowserWorker>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      if (!isSupported(model) || disposedRef.current) {
        reject(new Error(`${ENGINES[model].label} is not available in this browser.`));
        return;
      }
      let held = true;
      const release = () => {
        if (!held) return;
        held = false;
        dispatch({ type: "release", model });
      };
      let loadObserved = false;
      const settle = () => {
        listenersRef.current.delete(check);
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
        if (disposedRef.current) {
          fail(new Error(`${ENGINES[model].label} stopped.`));
          return;
        }
        const lease = leasesRef.current.get(model);
        if (!lease) {
          const spawnFailure = spawnFailuresRef.current.get(model);
          if (spawnFailure !== undefined) fail(new Error(spawnFailure));
          return;
        }
        if (lease.ready) {
          settle();
          resolve({ worker: lease.worker, lifetime: lease.lifetime, release });
          return;
        }
        // A failure from before this call gets one fresh attempt; one seen
        // after a load started (here or by anyone else) is final.
        if (lease.failure !== null && loadObserved) {
          fail(new Error(lease.failure));
          return;
        }
        loadObserved = true;
        startLoad(model, false);
      }

      dispatch({ type: "hold", model });
      listenersRef.current.add(check);
      signal.addEventListener("abort", onAbort, { once: true });
      check();
    })
  ), [isSupported, startLoad]);

  const states = useMemo(() => mapEngines((model) => pool[model].state), [pool]);
  const voices = useMemo(() => mapEngines((model) => pool[model].voices), [pool]);

  return useMemo(() => ({
    states,
    voices,
    getWorker,
    getWorkerLease,
    acquireWorker,
    hardRestartModel,
    loadModel,
    reloadModel,
  }), [acquireWorker, getWorker, getWorkerLease, hardRestartModel, loadModel, reloadModel, states, voices]);
}
