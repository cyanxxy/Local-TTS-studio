import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useModelCacheControls } from "./useModelCacheControls";

const {
  getModelCacheKeys,
  clearModelCache,
  clearModelCacheForModel,
} = vi.hoisted(() => ({
  getModelCacheKeys: vi.fn(),
  clearModelCache: vi.fn(),
  clearModelCacheForModel: vi.fn(),
}));

vi.mock("../lib/modelCache", () => ({
  getModelCacheKeys,
  clearModelCache,
  clearModelCacheForModel,
}));

describe("useModelCacheControls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears all caches and reports deleted storage names", async () => {
    getModelCacheKeys.mockResolvedValue(["transformers-cache", "kokoro-voices"]);
    clearModelCache.mockResolvedValue({ deletedKeys: ["transformers-cache"] });

    const { result } = renderHook(() => useModelCacheControls({
      activeModel: "kokoro",
      cancelActiveGeneration: vi.fn(),
      resetGeneratedAudio: vi.fn(),
      reloadModel: vi.fn(),
    }));

    await act(async () => {
      await result.current.clearCache();
    });

    expect(result.current.cacheBusy).toBe(false);
    expect(result.current.cacheStatus).toEqual({
      type: "success",
      message: "Cleared 1 storages (transformers-cache, kokoro-voices).",
    });
  });

  it("reports empty and failed cache clears", async () => {
    getModelCacheKeys.mockResolvedValue([]);
    clearModelCache.mockResolvedValueOnce({ deletedKeys: [] }).mockRejectedValueOnce(new Error("denied"));

    const { result } = renderHook(() => useModelCacheControls({
      activeModel: "kokoro",
      cancelActiveGeneration: vi.fn(),
      resetGeneratedAudio: vi.fn(),
      reloadModel: vi.fn(),
    }));

    await act(async () => {
      await result.current.clearCache();
    });
    expect(result.current.cacheStatus).toEqual({ type: "info", message: "No cache entries found." });

    await act(async () => {
      await result.current.clearCache();
    });
    expect(result.current.cacheStatus).toEqual({ type: "error", message: "denied" });
  });

  it("retries the active model load after cancelling and resetting audio", () => {
    const cancelActiveGeneration = vi.fn();
    const resetGeneratedAudio = vi.fn();
    const reloadModel = vi.fn();

    const { result } = renderHook(() => useModelCacheControls({
      activeModel: "supertonic",
      cancelActiveGeneration,
      resetGeneratedAudio,
      reloadModel,
    }));

    act(() => {
      result.current.retryActiveModelLoad();
    });

    expect(cancelActiveGeneration).toHaveBeenCalledWith(true);
    expect(resetGeneratedAudio).toHaveBeenCalledOnce();
    expect(reloadModel).toHaveBeenCalledWith("supertonic");
  });

  it("clears active model files before reloading and reports details", async () => {
    const cancelActiveGeneration = vi.fn();
    const resetGeneratedAudio = vi.fn();
    const reloadModel = vi.fn();
    clearModelCacheForModel.mockResolvedValue({ deletedEntries: 2, deletedKeys: ["kokoro-voices"] });

    const { result } = renderHook(() => useModelCacheControls({
      activeModel: "kokoro",
      cancelActiveGeneration,
      resetGeneratedAudio,
      reloadModel,
    }));

    await act(async () => {
      await result.current.redownloadActiveModel();
    });

    expect(clearModelCacheForModel).toHaveBeenCalledWith("kokoro");
    expect(cancelActiveGeneration).toHaveBeenCalledWith(true);
    expect(resetGeneratedAudio).toHaveBeenCalledOnce();
    expect(reloadModel).toHaveBeenCalledWith("kokoro");
    expect(result.current.cacheStatus).toEqual({
      type: "success",
      message: "Cleared 2 cached Kokoro files. Re-downloading Kokoro. Cleared kokoro-voices.",
    });
  });

  it("reports zero active model files and non-Error failures", async () => {
    clearModelCacheForModel.mockResolvedValueOnce({ deletedEntries: 0, deletedKeys: [] }).mockRejectedValueOnce("failed");

    const { result } = renderHook(() => useModelCacheControls({
      activeModel: "supertonic",
      cancelActiveGeneration: vi.fn(),
      resetGeneratedAudio: vi.fn(),
      reloadModel: vi.fn(),
    }));

    await act(async () => {
      await result.current.redownloadActiveModel();
    });
    expect(result.current.cacheStatus?.message).toBe("No cached Supertonic files were found. Re-downloading Supertonic.");

    await act(async () => {
      await result.current.redownloadActiveModel();
    });
    await waitFor(() => expect(result.current.cacheStatus).toEqual({ type: "error", message: "failed" }));
  });
});
