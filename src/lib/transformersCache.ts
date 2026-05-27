import { env } from "@huggingface/transformers";
import {
  ensurePersistentCacheStorage,
  getPersistentCacheAdapter,
  type CacheAdapterLike,
} from "./persistentCache";

export type ModelCacheStore = Pick<Cache, "match" | "put"> | Pick<CacheAdapterLike, "match" | "put">;

let transformersCachePromise: Promise<CacheAdapterLike | null> | null = null;

export async function initializeTransformersCache(): Promise<CacheAdapterLike | null> {
  if (!transformersCachePromise) {
    transformersCachePromise = (async () => {
      await ensurePersistentCacheStorage();
      const persistentCache = await getPersistentCacheAdapter(env.cacheKey);
      if (!persistentCache) return null;

      env.useCustomCache = true;
      env.customCache = persistentCache;
      env.useBrowserCache = false;

      return persistentCache;
    })();
  }

  return transformersCachePromise;
}

export function resetTransformersCacheInitialization(): void {
  transformersCachePromise = null;
}

export async function getTransformersModelCache(): Promise<ModelCacheStore | null> {
  const persistentCache = await initializeTransformersCache();
  if (persistentCache) return persistentCache;

  if (env.useCustomCache && env.customCache) {
    return env.customCache as ModelCacheStore;
  }

  if (typeof caches === "undefined") return null;

  try {
    return await caches.open(env.cacheKey);
  } catch {
    return null;
  }
}
