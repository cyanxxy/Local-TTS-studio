import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BROWSER_ENGINE_IDS, type BrowserEngineId } from "../models/registry";
import type { WorkerInMessage, WorkerOutMessage } from "../types";
import { BROWSER_MODEL_IDLE_EVICT_MS, useModelLoader, type UseModelLoaderOptions } from "./useModelLoader";

class MockWorker {
  static instances: MockWorker[] = [];

  public postedMessages: WorkerInMessage[] = [];
  public onmessage: ((event: MessageEvent<WorkerOutMessage>) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public onmessageerror: ((event: Event) => void) | null = null;
  public terminate = vi.fn();
  public readonly url: URL;

  constructor(url: URL) {
    this.url = url;
    MockWorker.instances.push(this);
  }

  postMessage(message: WorkerInMessage): void {
    this.postedMessages.push(message);
    if (message.type === "LOAD") {
      this.emit({ type: "LOAD_PROGRESS", percent: 0 });
    }
  }

  emit(message: WorkerOutMessage): void {
    this.onmessage?.({ data: message } as MessageEvent<WorkerOutMessage>);
  }

  /** Which engine's module this worker runs, from its URL. */
  get model(): BrowserEngineId | undefined {
    return BROWSER_ENGINE_IDS.find((id) => this.url.pathname.endsWith(`/${id}.worker.ts`));
  }

  get loads(): WorkerInMessage[] {
    return this.postedMessages.filter((message) => message.type === "LOAD");
  }
}

const LOAD = { type: "LOAD", preferredVoice: undefined, debugProfiling: false } as const;

function renderLoader(model: BrowserEngineId, options: UseModelLoaderOptions = {}) {
  return renderHook(
    ({ model: current, options: currentOptions }) => useModelLoader(current, currentOptions),
    { initialProps: { model, options } },
  );
}

/** Lets the pool's queued load microtasks run. */
async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useModelLoader", () => {
  beforeEach(() => {
    MockWorker.instances = [];
    vi.stubGlobal("Worker", MockWorker as unknown as typeof Worker);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    MockWorker.instances = [];
  });

  it.each(BROWSER_ENGINE_IDS)("starts only the selected %s worker and marks its model loading", async (model) => {
    const { result } = renderLoader(model);

    await waitFor(() => expect(result.current.states[model].loading).toBe(true));
    expect(MockWorker.instances).toHaveLength(1);
    expect(MockWorker.instances[0].model).toBe(model);
    expect(result.current.getWorker(model)).toBe(MockWorker.instances[0]);
    expect(MockWorker.instances[0].loads).toEqual([LOAD]);
    expect(result.current.states[model].downloadProgress).toBe(0);
    expect(result.current.states[model].error).toBeNull();
    for (const other of BROWSER_ENGINE_IDS.filter((id) => id !== model)) {
      expect(result.current.getWorker(other)).toBeNull();
      expect(result.current.states[other].loading).toBe(false);
    }
  });

  it("passes an engine's preferred voice and the profiling flag during load", async () => {
    renderLoader("supertonic", { preferredVoices: { supertonic: "Male" }, debugProfiling: true });

    await waitFor(() => expect(MockWorker.instances[0]?.loads).toEqual([
      { type: "LOAD", preferredVoice: "Male", debugProfiling: true },
    ]));
  });

  it("reports readiness, the model's voices and its backend", async () => {
    const { result } = renderLoader("kokoro");
    await waitFor(() => expect(result.current.states.kokoro.loading).toBe(true));

    act(() => MockWorker.instances[0].emit({ type: "READY", voices: ["af_heart"], backend: "webgpu" }));
    expect(result.current.states.kokoro).toEqual({
      ready: true,
      loading: false,
      downloadProgress: 100,
      error: null,
      backend: "webgpu",
    });
    expect(result.current.voices.kokoro).toEqual(["af_heart"]);
    expect(result.current.getWorkerLease("kokoro")).toMatchObject({ worker: MockWorker.instances[0], ready: true });

    act(() => MockWorker.instances[0].emit({ type: "LOAD_PROGRESS", percent: 140 }));
    expect(result.current.states.kokoro.downloadProgress).toBe(100);
  });

  it("ignores generation-scoped worker errors when the model is already ready", async () => {
    const { result } = renderLoader("kokoro");
    await waitFor(() => expect(MockWorker.instances).toHaveLength(1));

    act(() => MockWorker.instances[0].emit({ type: "READY", voices: ["af_heart"], backend: "webgpu" }));
    act(() => MockWorker.instances[0].emit({ type: "ERROR", message: "Chunk failed", scope: "generate" }));

    expect(result.current.states.kokoro.ready).toBe(true);
    expect(result.current.states.kokoro.error).toBeNull();
  });

  it("stores load-scoped worker errors and stops the loading state", async () => {
    const { result } = renderLoader("supertonic");
    await waitFor(() => expect(MockWorker.instances).toHaveLength(1));

    act(() => MockWorker.instances[0].emit({ type: "ERROR", message: "Failed to fetch model", scope: "load" }));

    expect(result.current.states.supertonic).toMatchObject({ ready: false, loading: false, error: "Failed to fetch model" });
  });

  it("names the engine when its worker crashes", async () => {
    const { result } = renderLoader("supertonic");
    await waitFor(() => expect(MockWorker.instances).toHaveLength(1));

    act(() => MockWorker.instances[0].onerror?.(new Event("error")));
    expect(result.current.states.supertonic.error).toBe("Supertonic worker failed.");

    act(() => MockWorker.instances[0].onmessageerror?.(new Event("messageerror")));
    expect(result.current.states.supertonic.error).toBe(
      "Supertonic worker failed. The worker sent an unreadable message.",
    );
  });

  it("starts no worker while no visible surface runs the browser model", async () => {
    const { result } = renderLoader("kokoro", { active: false });

    act(() => {
      result.current.loadModel("kokoro");
      result.current.reloadModel("kokoro");
    });
    await flushMicrotasks();

    expect(MockWorker.instances).toHaveLength(0);
    expect(result.current.states.kokoro).toMatchObject({ loading: false, ready: false });
  });

  it("starts only workers the browser supports", async () => {
    const { result } = renderLoader("supertonic", { supportedModels: ["supertonic"] });
    await waitFor(() => expect(MockWorker.instances).toHaveLength(1));
    expect(result.current.getWorker("supertonic")).toBe(MockWorker.instances[0]);

    act(() => {
      result.current.loadModel("kokoro");
      result.current.reloadModel("kokoro");
    });
    expect(MockWorker.instances).toHaveLength(1);
    expect(result.current.getWorker("kokoro")).toBeNull();
  });

  it("starts no worker for a selected engine the browser cannot run", async () => {
    renderLoader("supertonic", { supportedModels: ["kokoro"] });
    await flushMicrotasks();

    expect(MockWorker.instances).toHaveLength(0);
  });

  it("evicts a deselected engine's worker after the grace period and starts it again on selection", async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderLoader("kokoro");
    expect(MockWorker.instances).toHaveLength(1);
    const kokoro = MockWorker.instances[0];

    rerender({ model: "supertonic", options: {} });
    expect(MockWorker.instances).toHaveLength(2);
    const supertonic = MockWorker.instances[1];
    await act(async () => {
      vi.advanceTimersByTime(BROWSER_MODEL_IDLE_EVICT_MS - 1);
      await Promise.resolve();
    });
    expect(kokoro.terminate).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });

    expect(kokoro.terminate).toHaveBeenCalledOnce();
    expect(result.current.getWorker("kokoro")).toBeNull();
    expect(result.current.getWorker("supertonic")).toBe(supertonic);

    rerender({ model: "kokoro", options: {} });
    await flushMicrotasks();
    expect(MockWorker.instances).toHaveLength(3);
    expect(result.current.getWorker("kokoro")).toBe(MockWorker.instances[2]);
    expect(MockWorker.instances[2].loads).toEqual([LOAD]);
  });

  it("keeps a loaded model while another surface still selects it, and does not reload it", async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderLoader("kokoro");
    await flushMicrotasks();
    const kokoro = MockWorker.instances[0];
    act(() => kokoro.emit({ type: "READY", voices: ["af_heart"], backend: "wasm" }));

    rerender({ model: "kokoro", options: { active: false, retain: true } });
    await act(async () => {
      vi.advanceTimersByTime(BROWSER_MODEL_IDLE_EVICT_MS * 2);
      await Promise.resolve();
    });
    expect(kokoro.terminate).not.toHaveBeenCalled();
    expect(result.current.states.kokoro.ready).toBe(true);

    rerender({ model: "kokoro", options: { active: true, retain: true } });
    await flushMicrotasks();
    expect(MockWorker.instances).toHaveLength(1);
    expect(kokoro.loads).toHaveLength(1);
  });

  it("evicts the selected model once no surface selects it", async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderLoader("kokoro");
    await flushMicrotasks();
    const kokoro = MockWorker.instances[0];
    const { lifetime } = result.current.getWorkerLease("kokoro")!;

    rerender({ model: "kokoro", options: { active: false, retain: false } });
    expect(kokoro.terminate).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(BROWSER_MODEL_IDLE_EVICT_MS);
      await Promise.resolve();
    });

    expect(kokoro.terminate).toHaveBeenCalledOnce();
    expect(lifetime.aborted).toBe(true);
    expect(result.current.getWorkerLease("kokoro")).toBeNull();
    expect(result.current.states.kokoro.loading).toBe(false);
  });

  it("starts and loads the selected worker again after a hard cancel", async () => {
    const { result } = renderLoader("kokoro");
    await waitFor(() => expect(MockWorker.instances).toHaveLength(1));
    const cancelled = MockWorker.instances[0];
    act(() => cancelled.emit({ type: "READY", voices: ["af_heart"] }));

    act(() => cancelled.emit({ type: "CANCELLED" }));

    await waitFor(() => expect(MockWorker.instances).toHaveLength(2));
    expect(cancelled.terminate).toHaveBeenCalledOnce();
    expect(result.current.getWorker("kokoro")).toBe(MockWorker.instances[1]);
    // The voices stay known while the replacement loads.
    expect(result.current.voices.kokoro).toEqual(["af_heart"]);
    await waitFor(() => expect(MockWorker.instances[1].loads).toEqual([LOAD]));
  });

  it("leaves a hard-cancelled worker down while no visible surface runs it", async () => {
    const { result, rerender } = renderLoader("kokoro");
    await waitFor(() => expect(MockWorker.instances).toHaveLength(1));
    rerender({ model: "kokoro", options: { active: false, retain: true } });

    act(() => MockWorker.instances[0].emit({ type: "CANCELLED" }));
    await flushMicrotasks();

    expect(MockWorker.instances).toHaveLength(1);
    expect(result.current.getWorker("kokoro")).toBeNull();
  });

  it("terminates the selected worker synchronously before replacing it", async () => {
    const { result } = renderLoader("kokoro");
    await waitFor(() => expect(MockWorker.instances).toHaveLength(1));
    const activeWorker = MockWorker.instances[0];
    const { lifetime } = result.current.getWorkerLease("kokoro")!;

    act(() => result.current.hardRestartModel("kokoro"));

    expect(activeWorker.terminate).toHaveBeenCalledOnce();
    expect(lifetime.aborted).toBe(true);
    expect(result.current.getWorker("kokoro")).not.toBe(activeWorker);
    await waitFor(() => expect(MockWorker.instances).toHaveLength(2));
    await waitFor(() => expect(MockWorker.instances[1].loads).toEqual([LOAD]));
  });

  it("ignores messages from a worker it already replaced", async () => {
    const { result } = renderLoader("kokoro");
    await waitFor(() => expect(MockWorker.instances).toHaveLength(1));
    const replaced = MockWorker.instances[0];
    act(() => result.current.hardRestartModel("kokoro"));
    await waitFor(() => expect(MockWorker.instances).toHaveLength(2));

    act(() => replaced.emit({ type: "READY", voices: ["af_stale"] }));
    expect(result.current.states.kokoro.ready).toBe(false);
    expect(result.current.voices.kokoro).toEqual([]);
  });

  it("reloads a loaded model from scratch on request", async () => {
    const { result } = renderLoader("supertonic");
    await waitFor(() => expect(MockWorker.instances).toHaveLength(1));
    act(() => MockWorker.instances[0].emit({ type: "READY" }));

    act(() => result.current.reloadModel("supertonic"));

    expect(MockWorker.instances[0].loads.at(-1)).toEqual({ ...LOAD, forceReload: true });
    expect(result.current.states.supertonic).toMatchObject({ ready: false, loading: true });
    expect(result.current.getWorkerLease("supertonic")?.ready).toBe(false);
  });

  it("reports a worker that cannot be constructed once", async () => {
    let constructions = 0;
    vi.stubGlobal("Worker", class {
      constructor() {
        constructions += 1;
        throw new Error("Workers are blocked.");
      }
    });
    const { result } = renderLoader("kokoro");

    await waitFor(() => expect(result.current.states.kokoro.error).toBe("Workers are blocked."));
    await flushMicrotasks();
    expect(constructions).toBe(1);

    act(() => result.current.hardRestartModel("kokoro"));
    await waitFor(() => expect(constructions).toBe(2));
  });

  it("reports a LOAD the worker refuses", async () => {
    const { result } = renderLoader("kokoro");
    await waitFor(() => expect(MockWorker.instances).toHaveLength(1));
    act(() => MockWorker.instances[0].emit({ type: "ERROR", message: "boom", scope: "load" }));
    MockWorker.instances[0].postMessage = () => {
      throw new Error("Could not clone the request.");
    };

    act(() => result.current.loadModel("kokoro"));
    expect(result.current.states.kokoro.error).toBe("Could not clone the request.");
  });

  it("terminates every worker on unmount", async () => {
    const { unmount } = renderLoader("kokoro");
    await waitFor(() => expect(MockWorker.instances).toHaveLength(1));

    unmount();
    expect(MockWorker.instances[0].terminate).toHaveBeenCalledOnce();
  });

  it("starts a worker again when StrictMode replays its effects", async () => {
    const { result } = renderHook(() => useModelLoader("kokoro"), { wrapper: StrictMode });

    await waitFor(() => expect(result.current.getWorker("kokoro")).not.toBeNull());
    const live = MockWorker.instances.filter((worker) => worker.terminate.mock.calls.length === 0);
    expect(live).toHaveLength(1);
    expect(result.current.getWorker("kokoro")).toBe(live[0]);
    await waitFor(() => expect(live[0].loads).toEqual([LOAD]));
  });

  describe("acquireWorker", () => {
    it("starts and loads an engine no surface selects, and resolves once it is ready", async () => {
      vi.useFakeTimers();
      const { result } = renderLoader("kokoro");
      await flushMicrotasks();
      expect(MockWorker.instances).toHaveLength(1);

      let acquired: Awaited<ReturnType<typeof result.current.acquireWorker>> | undefined;
      act(() => {
        void result.current.acquireWorker("supertonic", new AbortController().signal).then((value) => {
          acquired = value;
        });
      });
      await flushMicrotasks();
      const supertonic = MockWorker.instances[1];
      expect(supertonic.model).toBe("supertonic");
      expect(supertonic.loads).toEqual([LOAD]);
      expect(acquired).toBeUndefined();

      act(() => supertonic.emit({ type: "READY" }));
      await flushMicrotasks();
      expect(acquired?.worker).toBe(supertonic);
      expect(acquired?.lifetime.aborted).toBe(false);

      // Held: the idle grace period does not apply.
      await act(async () => {
        vi.advanceTimersByTime(BROWSER_MODEL_IDLE_EVICT_MS * 2);
        await Promise.resolve();
      });
      expect(supertonic.terminate).not.toHaveBeenCalled();

      act(() => acquired?.release());
      act(() => acquired?.release());
      await act(async () => {
        vi.advanceTimersByTime(BROWSER_MODEL_IDLE_EVICT_MS);
        await Promise.resolve();
      });
      expect(supertonic.terminate).toHaveBeenCalledOnce();
      expect(acquired?.lifetime.aborted).toBe(true);
      expect(result.current.getWorker("kokoro")).toBe(MockWorker.instances[0]);
    });

    it("resolves at once with a loaded worker and does not load it again", async () => {
      const { result } = renderLoader("kokoro");
      await flushMicrotasks();
      act(() => MockWorker.instances[0].emit({ type: "READY", voices: [] }));

      let acquired: Awaited<ReturnType<typeof result.current.acquireWorker>> | undefined;
      await act(async () => {
        acquired = await result.current.acquireWorker("kokoro", new AbortController().signal);
      });

      expect(acquired?.worker).toBe(MockWorker.instances[0]);
      expect(MockWorker.instances[0].loads).toHaveLength(1);
    });

    it("rejects when the model fails to load, and retries a failure from before the call once", async () => {
      const { result } = renderLoader("kokoro");
      await flushMicrotasks();
      const worker = MockWorker.instances[0];
      act(() => worker.emit({ type: "ERROR", message: "offline", scope: "load" }));

      let failure: unknown;
      act(() => {
        result.current.acquireWorker("kokoro", new AbortController().signal).catch((error: unknown) => {
          failure = error;
        });
      });
      expect(worker.loads).toHaveLength(2);
      act(() => worker.emit({ type: "ERROR", message: "still offline", scope: "load" }));
      await flushMicrotasks();

      expect(failure).toEqual(new Error("still offline"));
    });

    it("rejects with the signal's reason when the caller gives up, and releases its hold", async () => {
      vi.useFakeTimers();
      const { result } = renderLoader("kokoro");
      await flushMicrotasks();
      const controller = new AbortController();
      let failure: unknown;
      act(() => {
        result.current.acquireWorker("supertonic", controller.signal).catch((error: unknown) => {
          failure = error;
        });
      });
      await flushMicrotasks();
      const supertonic = MockWorker.instances[1];

      act(() => controller.abort(new Error("not needed")));
      await flushMicrotasks();
      expect(failure).toEqual(new Error("not needed"));

      await act(async () => {
        vi.advanceTimersByTime(BROWSER_MODEL_IDLE_EVICT_MS);
        await Promise.resolve();
      });
      expect(supertonic.terminate).toHaveBeenCalledOnce();

      const aborted = new AbortController();
      aborted.abort(new Error("already"));
      await expect(result.current.acquireWorker("supertonic", aborted.signal)).rejects.toEqual(new Error("already"));
    });

    it("rejects engines the browser cannot run and workers that cannot be built", async () => {
      const { result } = renderLoader("kokoro", { supportedModels: ["kokoro"] });
      await expect(result.current.acquireWorker("supertonic", new AbortController().signal))
        .rejects.toThrow("Supertonic is not available in this browser.");

      vi.stubGlobal("Worker", class {
        constructor() {
          throw new Error("Workers are blocked.");
        }
      });
      const blocked = renderLoader("supertonic", { active: false });
      let failure: unknown;
      act(() => {
        blocked.result.current.acquireWorker("supertonic", new AbortController().signal).catch((error: unknown) => {
          failure = error;
        });
      });
      await waitFor(() => expect(failure).toEqual(new Error("Workers are blocked.")));
    });

    it("keeps waiting through a restart and rejects when the pool unmounts", async () => {
      const { result, unmount } = renderLoader("kokoro");
      await flushMicrotasks();
      let failure: unknown;
      act(() => {
        result.current.acquireWorker("kokoro", new AbortController().signal).catch((error: unknown) => {
          failure = error;
        });
      });
      act(() => result.current.hardRestartModel("kokoro"));
      await flushMicrotasks();
      expect(MockWorker.instances).toHaveLength(2);
      expect(failure).toBeUndefined();

      unmount();
      await flushMicrotasks();
      expect(failure).toEqual(new Error("Kokoro stopped."));
    });

    it("brings a held engine back after a hard restart even when no surface selects it", async () => {
      const { result } = renderLoader("kokoro", { active: false, retain: false });
      act(() => {
        // The pool unmounts after the test, which rejects the pending hold.
        result.current.acquireWorker("supertonic", new AbortController().signal).catch(() => undefined);
      });
      await flushMicrotasks();
      expect(MockWorker.instances).toHaveLength(1);

      act(() => result.current.hardRestartModel("supertonic"));
      await flushMicrotasks();
      expect(MockWorker.instances).toHaveLength(2);
      expect(MockWorker.instances[1].model).toBe("supertonic");
      expect(MockWorker.instances[1].loads).toEqual([LOAD]);
    });
  });
});
