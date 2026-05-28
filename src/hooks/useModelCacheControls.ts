import { useCallback, useState } from "react";
import { MODELS } from "../constants";
import { clearModelCache, clearModelCacheForModel, getModelCacheKeys } from "../lib/modelCache";
import type { ModelType } from "../types";

type CacheStatus = { type: "success" | "error" | "info"; message: string } | null;

interface UseModelCacheControlsOptions {
  activeModel: ModelType;
  cancelActiveGeneration: (forceCancelTts?: boolean) => void;
  resetGeneratedAudio: () => void;
  reloadModel: (model: ModelType) => void;
}

interface UseModelCacheControlsReturn {
  cacheBusy: boolean;
  cacheStatus: CacheStatus;
  clearCache: () => Promise<void>;
  redownloadActiveModel: () => Promise<void>;
  retryActiveModelLoad: () => void;
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useModelCacheControls({
  activeModel,
  cancelActiveGeneration,
  resetGeneratedAudio,
  reloadModel,
}: UseModelCacheControlsOptions): UseModelCacheControlsReturn {
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheStatus, setCacheStatus] = useState<CacheStatus>(null);

  const clearCache = useCallback(async () => {
    setCacheBusy(true);
    setCacheStatus({ type: "info", message: "Clearing cached model files…" });
    try {
      const before = await getModelCacheKeys();
      const result = await clearModelCache();
      if (result.deletedKeys.length > 0) {
        setCacheStatus({
          type: "success",
          message: `Cleared ${result.deletedKeys.length} storages (${before.join(", ")}).`,
        });
      } else {
        setCacheStatus({ type: "info", message: "No cache entries found." });
      }
    } catch (err) {
      setCacheStatus({ type: "error", message: toErrorMessage(err) });
    } finally {
      setCacheBusy(false);
    }
  }, []);

  const retryActiveModelLoad = useCallback(() => {
    cancelActiveGeneration(true);
    resetGeneratedAudio();
    reloadModel(activeModel);
  }, [activeModel, cancelActiveGeneration, reloadModel, resetGeneratedAudio]);

  const redownloadActiveModel = useCallback(async () => {
    setCacheBusy(true);
    const modelLabel = activeModel === "kokoro" ? MODELS.kokoro.label : MODELS.supertonic.label;
    setCacheStatus({ type: "info", message: `Re-downloading ${modelLabel}…` });
    try {
      const result = await clearModelCacheForModel(activeModel);
      cancelActiveGeneration(true);
      resetGeneratedAudio();
      reloadModel(activeModel);
      const deletedLabel = result.deletedEntries === 1 ? "file" : "files";
      const voiceCacheNote = result.deletedKeys.length > 0
        ? ` Cleared ${result.deletedKeys.join(", ")}.`
        : "";
      setCacheStatus({
        type: "success",
        message: result.deletedEntries > 0
          ? `Cleared ${result.deletedEntries} cached ${modelLabel} ${deletedLabel}. Re-downloading ${modelLabel}.${voiceCacheNote}`
          : `No cached ${modelLabel} files were found. Re-downloading ${modelLabel}.${voiceCacheNote}`,
      });
    } catch (err) {
      setCacheStatus({ type: "error", message: toErrorMessage(err) });
    } finally {
      setCacheBusy(false);
    }
  }, [activeModel, cancelActiveGeneration, reloadModel, resetGeneratedAudio]);

  return {
    cacheBusy,
    cacheStatus,
    clearCache,
    redownloadActiveModel,
    retryActiveModelLoad,
  };
}
