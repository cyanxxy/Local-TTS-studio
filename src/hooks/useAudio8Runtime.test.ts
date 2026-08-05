import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Audio8LoadResult, Audio8ProgressEvent } from "../electron";
import type { UseAudioPlayerReturn } from "./useAudioPlayer";
import { useAudio8Runtime } from "./useAudio8Runtime";

const SAMPLE_RATE = 24_000;
const LONG_TEXT = [
  "The lamplighter walked the length of the harbour road every evening at dusk.",
  "He carried a brass ladder over one shoulder and a taper in his free hand.",
  "Nobody had asked him to keep the lamps burning since the electric line arrived.",
  "He kept them burning anyway, because the fishermen still steered by them.",
].join(" ");

function createBridge() {
  const listeners = new Set<(event: Audio8ProgressEvent) => void>();
  return {
    load: vi.fn<(request: { requestId: string }) => Promise<Audio8LoadResult>>(
      async () => ({ sampleRate: SAMPLE_RATE }),
    ),
    generate: vi.fn<(request: { requestId: string; text: string; voice: string }) => Promise<{
      sampleRate: number;
      elapsedSec: number;
      audio: ArrayBuffer;
    }>>(async () => ({
      sampleRate: SAMPLE_RATE,
      elapsedSec: 0.5,
      audio: new Float32Array(SAMPLE_RATE).buffer,
    })),
    cancel: vi.fn<(request: { requestId: string }) => Promise<{ cancelled: boolean }>>(
      async () => ({ cancelled: true }),
    ),
    getCacheInfo: vi.fn(async () => ({ path: "/cache/audio8", exists: true, sizeBytes: 599_933_441 })),
    clearCache: vi.fn(async () => ({ path: "/cache/audio8", cleared: true })),
    subscribeProgress: vi.fn((listener: (event: Audio8ProgressEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    emitProgress(event: Audio8ProgressEvent) {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

function createPlayer() {
  return {
    scheduleChunk: vi.fn(async () => {}),
    reset: vi.fn(),
    beginStream: vi.fn(),
    endStream: vi.fn(),
    stopAll: vi.fn(),
  } as unknown as UseAudioPlayerReturn;
}

type Bridge = ReturnType<typeof createBridge>;

function installBridge(bridge: Bridge | undefined) {
  Object.defineProperty(window, "electron", {
    value: bridge ? { isElectron: true, audio8: bridge } : undefined,
    configurable: true,
  });
}

function renderRuntime(bridge: Bridge | undefined, player = createPlayer(), text = LONG_TEXT) {
  installBridge(bridge);
  const setShowPlayer = vi.fn();
  const view = renderHook(
    (props: { active: boolean }) => useAudio8Runtime({
      active: props.active,
      text,
      voice: "clara",
      generationSettings: { speed: 1, quality: 5 },
      player,
      setShowPlayer,
    }),
    { initialProps: { active: true } },
  );
  return { ...view, player, setShowPlayer };
}

function loadRequestId(bridge: Bridge): string {
  return bridge.load.mock.calls[0][0].requestId;
}

describe("useAudio8Runtime model loading", () => {
  let bridge: Bridge;

  beforeEach(() => {
    bridge = createBridge();
  });

  afterEach(() => {
    installBridge(undefined);
  });

  it("reuses the in-flight load when Audio8 is deselected and selected again", async () => {
    let settleLoad: (() => void) | undefined;
    bridge.load.mockImplementation(() => new Promise<Audio8LoadResult>((resolve) => {
      settleLoad = () => resolve({ sampleRate: SAMPLE_RATE });
    }));
    const { result, rerender } = renderRuntime(bridge);
    await waitFor(() => expect(bridge.load).toHaveBeenCalledTimes(1));
    // Let the activation's cache read settle so its state update does not land
    // in the middle of the rerenders below.
    await waitFor(() => expect(result.current.cacheInfo).not.toBeNull());

    await act(async () => {
      rerender({ active: false });
      rerender({ active: true });
      rerender({ active: false });
      rerender({ active: true });
      await Promise.resolve();
    });

    expect(bridge.load).toHaveBeenCalledTimes(1);
    expect(result.current.modelState.loading).toBe(true);
    await act(async () => {
      settleLoad?.();
      await Promise.resolve();
    });
    expect(result.current.modelState.ready).toBe(true);

    // A settled load is reused too: reselecting must not re-download.
    await act(async () => {
      rerender({ active: false });
      rerender({ active: true });
      await Promise.resolve();
    });
    expect(bridge.load).toHaveBeenCalledTimes(1);
  });

  it("surfaces a load failure that lands while Audio8 is deselected", async () => {
    let failLoad: (() => void) | undefined;
    bridge.load.mockImplementation(() => new Promise<Audio8LoadResult>((_resolve, reject) => {
      failLoad = () => reject(new Error(
        "Error invoking remote method 'audio8:load': Error: Checksum mismatch for slow_ar_int4.onnx.data.",
      ));
    }));
    const { result, rerender } = renderRuntime(bridge);
    await waitFor(() => expect(bridge.load).toHaveBeenCalledTimes(1));

    rerender({ active: false });
    await act(async () => {
      failLoad?.();
      await Promise.resolve();
    });

    // Without this the runtime would sit on `loading: true` forever with no
    // error and no way for the user to retry.
    expect(result.current.modelState.loading).toBe(false);
    expect(result.current.modelState.error).toBe("Checksum mismatch for slow_ar_int4.onnx.data.");
  });

  it("only retries the load when retryLoad asks for it", async () => {
    bridge.load.mockRejectedValueOnce(new Error("network unreachable"));
    const { result, rerender } = renderRuntime(bridge);
    await waitFor(() => expect(result.current.modelState.error).toBe("network unreachable"));

    rerender({ active: false });
    rerender({ active: true });
    expect(bridge.load).toHaveBeenCalledTimes(1);

    act(() => result.current.retryLoad());
    await waitFor(() => expect(bridge.load).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.modelState.ready).toBe(true));
  });

  it("reports download progress for its own load and ignores other requests", async () => {
    let settleLoad: (() => void) | undefined;
    bridge.load.mockImplementation(() => new Promise<Audio8LoadResult>((resolve) => {
      settleLoad = () => resolve({ sampleRate: SAMPLE_RATE });
    }));
    const { result, rerender } = renderRuntime(bridge);
    await waitFor(() => expect(bridge.load).toHaveBeenCalledTimes(1));

    act(() => bridge.emitProgress({ requestId: loadRequestId(bridge), percent: 41 }));
    expect(result.current.modelState.downloadProgress).toBe(41);

    act(() => bridge.emitProgress({ requestId: "audio8-load-someone-else", percent: 99 }));
    expect(result.current.modelState.downloadProgress).toBe(41);

    // Progress keeps arriving across a deselect/reselect cycle because the
    // subscription belongs to the bridge, not to one activation.
    rerender({ active: false });
    act(() => bridge.emitProgress({ requestId: loadRequestId(bridge), percent: 76 }));
    rerender({ active: true });
    expect(result.current.modelState.downloadProgress).toBe(76);

    await act(async () => {
      settleLoad?.();
      await Promise.resolve();
    });
    expect(result.current.modelState.downloadProgress).toBe(100);
  });

  it("explains that Audio8 needs the desktop app when no bridge is present", async () => {
    const { result } = renderRuntime(undefined);
    await waitFor(() => expect(result.current.modelState.error)
      .toBe("Audio8 local inference requires the Electron app."));
    expect(result.current.canGenerate).toBe(false);
  });
});

describe("useAudio8Runtime generation", () => {
  let bridge: Bridge;

  beforeEach(() => {
    bridge = createBridge();
  });

  afterEach(() => {
    installBridge(undefined);
  });

  it("synthesises every chunk in order and reports stats", async () => {
    const { result, player, setShowPlayer } = renderRuntime(bridge);
    await waitFor(() => expect(result.current.canGenerate).toBe(true));

    await act(async () => {
      result.current.handleGenerate();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.isGenerating).toBe(false));

    expect(setShowPlayer).toHaveBeenCalledWith(true);
    expect(player.beginStream).toHaveBeenCalledTimes(1);
    expect(player.endStream).toHaveBeenCalledTimes(1);
    const chunkCount = bridge.generate.mock.calls.length;
    expect(chunkCount).toBeGreaterThan(1);
    expect(player.scheduleChunk).toHaveBeenCalledTimes(chunkCount);
    for (const [request] of bridge.generate.mock.calls) {
      expect(request.voice).toBe("clara");
      expect(request.text.length).toBeLessThanOrEqual(180);
    }
    expect(result.current.generationProgress).toBe(100);
    expect(result.current.stats.totalDuration).toBeGreaterThan(0);
    expect(result.current.stats.totalDuration).toBeGreaterThan(chunkCount);
    expect(result.current.stats.rtf).toBeCloseTo(result.current.stats.processingTime / chunkCount, 5);
    expect(result.current.error).toBeNull();
  });

  it("reports inference progress for the active generation request", async () => {
    let settleGeneration: (() => void) | undefined;
    bridge.generate.mockImplementationOnce(() => new Promise((resolve) => {
      settleGeneration = () => resolve({
        sampleRate: SAMPLE_RATE,
        elapsedSec: 0.5,
        audio: new Float32Array(SAMPLE_RATE).buffer,
      });
    }));
    const { result } = renderRuntime(bridge, createPlayer(), "This sentence is long enough to synthesize locally.");
    await waitFor(() => expect(result.current.canGenerate).toBe(true));

    act(() => result.current.handleGenerate());
    await waitFor(() => expect(bridge.generate).toHaveBeenCalledTimes(1));
    const requestId = bridge.generate.mock.calls[0][0].requestId;
    act(() => bridge.emitProgress({ requestId, percent: 50 }));
    expect(result.current.generationProgress).toBe(50);

    await act(async () => {
      settleGeneration?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.generationProgress).toBe(100));
  });

  it("fails loudly instead of scheduling silence when the payload is not audio", async () => {
    bridge.generate.mockResolvedValue({
      sampleRate: SAMPLE_RATE,
      elapsedSec: 0.5,
      audio: undefined as unknown as ArrayBuffer,
    });
    const { result, player } = renderRuntime(bridge);
    await waitFor(() => expect(result.current.canGenerate).toBe(true));

    await act(async () => {
      result.current.handleGenerate();
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.error).toBe("Audio8 returned invalid local audio."));
    expect(player.scheduleChunk).not.toHaveBeenCalled();
    expect(result.current.isGenerating).toBe(false);
  });

  it("strips the Electron IPC wrapper from a generation failure", async () => {
    bridge.generate.mockRejectedValue(new Error(
      "Error invoking remote method 'audio8:generate': Error: Audio8 worker exited.",
    ));
    const { result } = renderRuntime(bridge);
    await waitFor(() => expect(result.current.canGenerate).toBe(true));

    await act(async () => {
      result.current.handleGenerate();
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.error).toBe("Audio8 worker exited."));
  });

  it("cancels the request in flight and abandons the remaining chunks", async () => {
    let settleFirst: (() => void) | undefined;
    bridge.generate.mockImplementationOnce(() => new Promise((resolve) => {
      settleFirst = () => resolve({
        sampleRate: SAMPLE_RATE,
        elapsedSec: 0.5,
        audio: new Float32Array(SAMPLE_RATE).buffer,
      });
    }));
    const { result, player } = renderRuntime(bridge);
    await waitFor(() => expect(result.current.canGenerate).toBe(true));

    await act(async () => {
      result.current.handleGenerate();
      await Promise.resolve();
    });
    expect(result.current.isGenerating).toBe(true);
    const cancelledRequestId = bridge.generate.mock.calls[0][0].requestId;

    act(() => result.current.handleStop());

    expect(bridge.cancel).toHaveBeenCalledWith({ requestId: cancelledRequestId });
    expect(player.stopAll).toHaveBeenCalledTimes(1);
    expect(result.current.isGenerating).toBe(false);
    await act(async () => {
      settleFirst?.();
      await Promise.resolve();
    });
    expect(bridge.generate).toHaveBeenCalledTimes(1);
  });

  it("cancels generation when Audio8 is deselected", async () => {
    bridge.generate.mockImplementationOnce(() => new Promise(() => {}));
    const { result, rerender, player } = renderRuntime(bridge);
    await waitFor(() => expect(result.current.canGenerate).toBe(true));
    act(() => result.current.handleGenerate());
    await waitFor(() => expect(bridge.generate).toHaveBeenCalledTimes(1));
    const requestId = bridge.generate.mock.calls[0][0].requestId;

    rerender({ active: false });

    expect(bridge.cancel).toHaveBeenCalledWith({ requestId });
    expect(player.endStream).toHaveBeenCalled();
    expect(result.current.isGenerating).toBe(false);
  });
});

describe("useAudio8Runtime cache controls", () => {
  let bridge: Bridge;

  beforeEach(() => {
    bridge = createBridge();
  });

  afterEach(() => {
    installBridge(undefined);
  });

  it("reads the cache when Audio8 becomes active and again once the model lands", async () => {
    const { result } = renderRuntime(bridge);
    await waitFor(() => expect(result.current.cacheInfo?.sizeBytes).toBe(599_933_441));
    expect(result.current.cacheInfo?.path).toBe("/cache/audio8");
    await waitFor(() => expect(bridge.getCacheInfo.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("invalidates the resident model when the cache is cleared and only reloads on retry", async () => {
    const { result } = renderRuntime(bridge);
    await waitFor(() => expect(result.current.modelState.ready).toBe(true));
    bridge.getCacheInfo.mockResolvedValue({ path: "/cache/audio8", exists: false, sizeBytes: 0 });

    await act(async () => {
      result.current.clearCache();
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.cacheStatus).toEqual({
      tone: "success",
      text: "Audio8 model cache cleared. Retry when you want to download it again.",
    }));
    expect(result.current.cacheInfo?.sizeBytes).toBe(0);
    expect(result.current.cacheBusy).toBe(false);
    // Reclaiming disk must not silently restart the 572 MiB download.
    expect(result.current.modelState.ready).toBe(false);
    expect(result.current.modelState.error).toContain("local cache was cleared");
    expect(bridge.load).toHaveBeenCalledTimes(1);
    act(() => result.current.retryLoad());
    await waitFor(() => expect(bridge.load).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.modelState.ready).toBe(true));
  });

  it("reports a failed clear without disturbing the runtime", async () => {
    const { result } = renderRuntime(bridge);
    await waitFor(() => expect(result.current.modelState.ready).toBe(true));
    bridge.clearCache.mockRejectedValue(new Error(
      "Error invoking remote method 'audio8:clear-cache': Error: EPERM: operation not permitted.",
    ));

    await act(async () => {
      result.current.clearCache();
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.cacheStatus).toEqual({
      tone: "error",
      text: "EPERM: operation not permitted.",
    }));
    expect(result.current.modelState.ready).toBe(true);
  });

  it("says so when there was nothing cached to clear", async () => {
    bridge.clearCache.mockResolvedValue({ path: "/cache/audio8", cleared: false });
    const { result } = renderRuntime(bridge);
    await waitFor(() => expect(result.current.modelState.ready).toBe(true));

    await act(async () => {
      result.current.clearCache();
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.cacheStatus).toEqual({
      tone: "info",
      text: "Audio8 was unloaded. No cached model files were found.",
    }));
    expect(result.current.modelState.ready).toBe(false);
  });
});
