import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UseAudioPlayerReturn } from "./useAudioPlayer";
import { useSupertonic3Runtime } from "./useSupertonic3Runtime";

const ttsState = vi.hoisted(() => ({
  isGenerating: false,
  generationProgress: 0,
  stats: {
    firstLatency: null,
    processingTime: 0,
    charsPerSec: 0,
    rtf: 0,
    totalDuration: 0,
    currentDuration: 0,
  },
  error: null as string | null,
  generate: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("./useTTS", () => ({ useTTS: () => ttsState }));

class FakeWorker extends EventTarget {
  postMessage = vi.fn();
  terminate = vi.fn();
}

function createPlayer() {
  return {
    scheduleChunk: vi.fn(),
    reset: vi.fn(),
    beginStream: vi.fn(),
    endStream: vi.fn(),
    stopAll: vi.fn(),
  } as unknown as UseAudioPlayerReturn;
}

const baseOptions = {
  available: true,
  active: true,
  text: "Enough text to generate speech.",
  voice: "M1",
  language: "en",
  generationSettings: { speed: 1, quality: 5 },
  setShowPlayer: vi.fn(),
};

describe("useSupertonic3Runtime", () => {
  beforeEach(() => {
    ttsState.isGenerating = false;
    ttsState.generate.mockReset();
    ttsState.cancel.mockReset();
    baseOptions.setShowPlayer.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ends only the stream started by the active Supertonic runtime", async () => {
    const worker = new FakeWorker();
    const player = createPlayer();
    const { result, rerender } = renderHook(
      (props: { active: boolean }) => useSupertonic3Runtime({
        ...baseOptions,
        active: props.active,
        createWorker: () => worker as unknown as Worker,
        player,
      }),
      { initialProps: { active: false } },
    );

    expect(player.endStream).not.toHaveBeenCalled();
    rerender({ active: true });
    await waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith({ type: "LOAD", forceReload: false }));
    act(() => worker.dispatchEvent(new MessageEvent("message", {
      data: { type: "READY", voices: ["M1"], backend: "wasm" },
    })));
    await waitFor(() => expect(result.current.canGenerate).toBe(true));

    ttsState.generate.mockImplementationOnce(() => {
      ttsState.isGenerating = true;
    });
    act(() => result.current.handleGenerate());
    rerender({ active: true });
    expect(player.endStream).not.toHaveBeenCalled();

    ttsState.isGenerating = false;
    rerender({ active: true });
    expect(player.endStream).toHaveBeenCalledTimes(1);
  });

  it("recreates the worker when initial construction failed", async () => {
    const worker = new FakeWorker();
    const createWorker = vi.fn<() => Worker>()
      .mockImplementationOnce(() => { throw new Error("worker unavailable"); })
      .mockImplementationOnce(() => worker as unknown as Worker);
    const { result } = renderHook(() => useSupertonic3Runtime({
      ...baseOptions,
      createWorker,
      player: createPlayer(),
    }));
    await waitFor(() => expect(result.current.modelState.error).toBe("worker unavailable"));

    act(() => result.current.retryLoad());

    await waitFor(() => expect(createWorker).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith({ type: "LOAD", forceReload: false }));
  });

  it("recreates a worker that throws while loading", async () => {
    const failedWorker = new FakeWorker();
    failedWorker.postMessage.mockImplementationOnce(() => { throw new Error("worker crashed"); });
    const replacementWorker = new FakeWorker();
    const createWorker = vi.fn<() => Worker>()
      .mockReturnValueOnce(failedWorker as unknown as Worker)
      .mockReturnValueOnce(replacementWorker as unknown as Worker);
    const { result } = renderHook(() => useSupertonic3Runtime({
      ...baseOptions,
      createWorker,
      player: createPlayer(),
    }));
    await waitFor(() => expect(result.current.modelState.error).toBe("worker crashed"));

    act(() => result.current.retryLoad());

    await waitFor(() => expect(createWorker).toHaveBeenCalledTimes(2));
    expect(failedWorker.terminate).toHaveBeenCalledOnce();
    await waitFor(() => expect(replacementWorker.postMessage)
      .toHaveBeenCalledWith({ type: "LOAD", forceReload: false }));
  });

  it("does not finish its stream after the runtime becomes inactive", async () => {
    const worker = new FakeWorker();
    const player = createPlayer();
    const createWorker = () => worker as unknown as Worker;
    const { result, rerender } = renderHook(
      (props: { active: boolean }) => useSupertonic3Runtime({
        ...baseOptions,
        active: props.active,
        createWorker,
        player,
      }),
      { initialProps: { active: true } },
    );
    await waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith({ type: "LOAD", forceReload: false }));
    act(() => worker.dispatchEvent(new MessageEvent("message", {
      data: { type: "READY", voices: ["M1"], backend: "wasm" },
    })));
    await waitFor(() => expect(result.current.canGenerate).toBe(true));
    ttsState.generate.mockImplementationOnce(() => { ttsState.isGenerating = true; });
    act(() => result.current.handleGenerate());
    rerender({ active: false });

    ttsState.isGenerating = false;
    rerender({ active: false });

    expect(player.endStream).not.toHaveBeenCalled();
  });

  it("evicts the loaded worker after it remains inactive", async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const createWorker = vi.fn(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    });
    const { result, rerender } = renderHook(
      (props: { active: boolean }) => useSupertonic3Runtime({
        ...baseOptions,
        active: props.active,
        createWorker,
        player: createPlayer(),
      }),
      { initialProps: { active: true } },
    );
    expect(workers).toHaveLength(1);
    act(() => workers[0].dispatchEvent(new MessageEvent("message", {
      data: { type: "READY", voices: ["M1"], backend: "wasm" },
    })));
    expect(result.current.modelState.ready).toBe(true);

    rerender({ active: false });
    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });

    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(result.current.modelState.ready).toBe(false);

    rerender({ active: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(workers).toHaveLength(2);
    expect(workers[1].postMessage).toHaveBeenCalledWith({ type: "LOAD", forceReload: false });
  });

  it("hard-stops compute and recreates the worker when generation is cancelled", async () => {
    const workers: FakeWorker[] = [];
    const createWorker = vi.fn(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    });
    const { result } = renderHook(() => useSupertonic3Runtime({
      ...baseOptions,
      createWorker,
      player: createPlayer(),
    }));
    act(() => workers[0].dispatchEvent(new MessageEvent("message", {
      data: { type: "READY", voices: ["M1"], backend: "wasm" },
    })));
    ttsState.isGenerating = true;

    act(() => result.current.handleStop());

    expect(ttsState.cancel).toHaveBeenCalledOnce();
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    await waitFor(() => expect(workers).toHaveLength(2));
    expect(workers[1].postMessage).toHaveBeenCalledWith({ type: "LOAD", forceReload: false });
  });
});
