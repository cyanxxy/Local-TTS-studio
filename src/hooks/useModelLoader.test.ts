import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerInMessage, WorkerOutMessage } from "../types";
import { useModelLoader } from "./useModelLoader";

class MockWorker {
  static instances: MockWorker[] = [];

  public postedMessages: WorkerInMessage[] = [];
  public onmessage: ((event: MessageEvent<WorkerOutMessage>) => void) | null = null;

  constructor() {
    MockWorker.instances.push(this);
  }

  postMessage(message: WorkerInMessage): void {
    this.postedMessages.push(message);
    if (message.type === "LOAD") {
      this.emit({ type: "LOAD_PROGRESS", percent: 0 });
    }
  }

  terminate(): void {}

  emit(message: WorkerOutMessage): void {
    this.onmessage?.({ data: message } as MessageEvent<WorkerOutMessage>);
  }
}

describe("useModelLoader", () => {
  beforeEach(() => {
    MockWorker.instances = [];
    vi.stubGlobal("Worker", MockWorker as unknown as typeof Worker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    MockWorker.instances = [];
  });

  it("marks the active model as loading before progress events arrive", async () => {
    const { result } = renderHook(() => useModelLoader("kokoro"));

    await waitFor(() => expect(MockWorker.instances).toHaveLength(2));
    await waitFor(() => expect(result.current.kokoroState.loading).toBe(true));

    expect(MockWorker.instances[0].postedMessages).toContainEqual({
      type: "LOAD",
      preferredVoice: undefined,
      debugProfiling: false,
    });
    expect(result.current.kokoroState.downloadProgress).toBe(0);
    expect(result.current.kokoroState.error).toBeNull();
  });

  it("passes the selected Supertonic voice and profiling flag during load", async () => {
    renderHook(() => useModelLoader("supertonic", {
      preferredSupertonicVoice: "Male",
      debugProfiling: true,
    }));

    await waitFor(() => expect(MockWorker.instances).toHaveLength(2));

    expect(MockWorker.instances[1].postedMessages).toContainEqual({
      type: "LOAD",
      preferredVoice: "Male",
      debugProfiling: true,
    });
  });

  it("ignores generation-scoped worker errors when the model is already ready", async () => {
    const { result } = renderHook(() => useModelLoader("kokoro"));

    await waitFor(() => expect(MockWorker.instances).toHaveLength(2));

    act(() => {
      MockWorker.instances[0].emit({ type: "READY", voices: ["af_heart"], backend: "webgpu" });
    });

    expect(result.current.kokoroState.ready).toBe(true);
    expect(result.current.kokoroState.error).toBeNull();

    act(() => {
      MockWorker.instances[0].emit({ type: "ERROR", message: "Chunk failed", scope: "generate" });
    });

    expect(result.current.kokoroState.ready).toBe(true);
    expect(result.current.kokoroState.error).toBeNull();
  });

  it("stores load-scoped worker errors and stops the loading state", async () => {
    const { result } = renderHook(() => useModelLoader("supertonic"));

    await waitFor(() => expect(MockWorker.instances).toHaveLength(2));

    act(() => {
      MockWorker.instances[1].emit({ type: "ERROR", message: "Failed to fetch model", scope: "load" });
    });

    expect(result.current.supertonicState.ready).toBe(false);
    expect(result.current.supertonicState.loading).toBe(false);
    expect(result.current.supertonicState.error).toBe("Failed to fetch model");
  });

  it("does not create workers when loading is disabled", () => {
    const { result } = renderHook(() => useModelLoader("kokoro", { enabled: false }));

    expect(MockWorker.instances).toHaveLength(0);
    expect(result.current.kokoroState.loading).toBe(false);
    expect(result.current.kokoroState.ready).toBe(false);

    act(() => {
      result.current.loadModel("kokoro");
      result.current.reloadModel("kokoro");
    });

    expect(MockWorker.instances).toHaveLength(0);
  });

  it("creates only supported workers when a browser limits the model set", async () => {
    const { result } = renderHook(() => useModelLoader("supertonic", {
      supportedModels: ["supertonic"],
    }));

    await waitFor(() => expect(MockWorker.instances).toHaveLength(1));

    expect(result.current.kokoroWorker.current).toBeNull();
    expect(result.current.supertonicWorker.current).not.toBeNull();
    expect(MockWorker.instances[0].postedMessages).toContainEqual({
      type: "LOAD",
      preferredVoice: undefined,
      debugProfiling: false,
    });

    act(() => {
      result.current.loadModel("kokoro");
      result.current.reloadModel("kokoro");
    });

    expect(MockWorker.instances).toHaveLength(1);
  });
});
