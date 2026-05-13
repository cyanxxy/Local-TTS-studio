import { env } from "@huggingface/transformers";
import { MODELS } from "../constants";
import type { ModelType } from "../types";
import {
  clearPersistentCacheEntries,
  clearPersistentCacheStorage,
  getPersistentCacheNames,
} from "./persistentCache";

export interface ClearModelCacheResult {
  deletedKeys: string[];
}

export interface ClearModelCacheForModelResult {
  deletedEntries: number;
  deletedKeys: string[];
}

function isCacheStorageAvailable(): boolean {
  return typeof caches !== "undefined";
}

function isTransformersCacheKey(key: string): boolean {
  return key === env.cacheKey || key.includes("transformers");
}

function isModelCacheKey(key: string): boolean {
  return isTransformersCacheKey(key) || key === "kokoro-voices";
}

function toIndexedDbLabel(cacheName: string): string {
  return `indexeddb:${cacheName}`;
}

function isTransformersCacheEntryCacheKey(key: string): boolean {
  return isTransformersCacheKey(key);
}

function getModelCacheUrlMarkers(model: ModelType): string[] {
  const modelId = MODELS[model].id;
  return [modelId, encodeURIComponent(modelId)];
}

function matchesModelCacheUrl(url: string, model: ModelType): boolean {
  return getModelCacheUrlMarkers(model).some((marker) => url.includes(marker));
}

export async function getModelCacheKeys(): Promise<string[]> {
  const cacheApiKeys = isCacheStorageAvailable()
    ? (await caches.keys()).filter(isModelCacheKey)
    : [];

  const indexedDbKeys = (await getPersistentCacheNames())
    .filter(isModelCacheKey)
    .map(toIndexedDbLabel);

  return Array.from(new Set([...cacheApiKeys, ...indexedDbKeys]));
}

export async function clearModelCache(): Promise<ClearModelCacheResult> {
  const deletedKeys: string[] = [];

  if (isCacheStorageAvailable()) {
    const keys = (await caches.keys()).filter(isModelCacheKey);
    const deleted = await Promise.all(
      keys.map(async (key) => ((await caches.delete(key)) ? key : null)),
    );
    deletedKeys.push(...deleted.filter((key): key is string => key !== null));
  }

  const indexedDbKeys = (await getPersistentCacheNames()).filter(isModelCacheKey);
  const clearedIndexedDbCaches = await clearPersistentCacheStorage(indexedDbKeys);
  deletedKeys.push(
    ...clearedIndexedDbCaches.map(toIndexedDbLabel),
  );

  return { deletedKeys: Array.from(new Set(deletedKeys)) };
}

export async function clearModelCacheForModel(
  model: ModelType,
): Promise<ClearModelCacheForModelResult> {
  const deletedKeys = new Set<string>();
  let deletedEntries = 0;

  if (isCacheStorageAvailable()) {
    const keys = await caches.keys();
    for (const key of keys) {
      if (!isModelCacheKey(key)) continue;

      if (key === "kokoro-voices") {
        if (model === "kokoro" && await caches.delete(key)) {
          deletedKeys.add(key);
        }
        continue;
      }

      if (!isTransformersCacheEntryCacheKey(key)) continue;

      const cache = await caches.open(key);
      const cacheWithKeys = cache as Cache;
      if (typeof cacheWithKeys.keys !== "function") continue;

      const requests = await cacheWithKeys.keys();
      const matchingRequests = requests.filter((request) => matchesModelCacheUrl(request.url, model));
      if (matchingRequests.length === 0) continue;

      const deleted = await Promise.all(
        matchingRequests.map(async (request) => (
          (await cacheWithKeys.delete(request)) ? request.url : null
        )),
      );
      deletedEntries += deleted.filter((url): url is string => url !== null).length;
    }
  }

  const indexedDbKeys = (await getPersistentCacheNames()).filter(isModelCacheKey);
  if (model === "kokoro" && indexedDbKeys.includes("kokoro-voices")) {
    const clearedVoiceCaches = await clearPersistentCacheStorage(["kokoro-voices"]);
    if (clearedVoiceCaches.length > 0) {
      deletedKeys.add(toIndexedDbLabel("kokoro-voices"));
    }
  }

  const indexedDbTransformersKeys = indexedDbKeys.filter(isTransformersCacheEntryCacheKey);
  const clearedIndexedDbEntries = await clearPersistentCacheEntries(
    (entry) => matchesModelCacheUrl(entry.url, model),
    indexedDbTransformersKeys,
  );
  deletedEntries += clearedIndexedDbEntries.length;

  return {
    deletedEntries,
    deletedKeys: Array.from(deletedKeys),
  };
}
