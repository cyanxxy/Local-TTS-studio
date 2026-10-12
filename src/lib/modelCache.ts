import { env } from "@huggingface/transformers";
import { MODELS } from "../constants";
import type { ModelType } from "../types";
import { KITTEN_CACHE_NAME, PARADEE_CACHE_NAME } from "./phonemeModels";
import { PIPER_CACHE_NAME } from "./piperVoices";
import { CHATTERBOX_DEFAULT_VOICE, CHATTERBOX_MODEL_ID } from "./chatterboxModel";
import {
  clearPersistentCacheEntries,
  clearPersistentCacheStorage,
  getPersistentCacheNames,
} from "./persistentCache";
import { resetTransformersCacheInitialization } from "./transformersCache";

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

/**
 * Models whose workers keep their pinned files in a Cache Storage of their own
 * rather than in the shared Transformers.js cache, so clearing one is deleting
 * that cache (a Piper cache holds every voice downloaded so far).
 */
const OWN_CACHE_NAMES: Partial<Record<ModelType, string>> = {
  kitten: KITTEN_CACHE_NAME,
  paradee: PARADEE_CACHE_NAME,
  piper: PIPER_CACHE_NAME,
};

/** Chatterbox keeps its pinned files in the shared Transformers.js cache, under these repositories. */
const EXTRA_MODEL_REPOS: Partial<Record<ModelType, readonly string[]>> = {
  chatterbox: [CHATTERBOX_MODEL_ID, CHATTERBOX_DEFAULT_VOICE.modelId],
};

function getModelCacheUrlMarkers(model: ModelType): string[] {
  const modelIds = model in MODELS
    ? [MODELS[model as keyof typeof MODELS].id]
    : [...(EXTRA_MODEL_REPOS[model] ?? [])];
  return modelIds.flatMap((modelId) => [modelId, encodeURIComponent(modelId)]);
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

  resetTransformersCacheInitialization();
  return { deletedKeys: Array.from(new Set(deletedKeys)) };
}

export async function clearModelCacheForModel(
  model: ModelType,
): Promise<ClearModelCacheForModelResult> {
  const deletedKeys = new Set<string>();
  let deletedEntries = 0;

  const ownCacheName = OWN_CACHE_NAMES[model];
  if (ownCacheName !== undefined) {
    if (isCacheStorageAvailable() && (await caches.has(ownCacheName))) {
      const cache = await caches.open(ownCacheName);
      deletedEntries = (await cache.keys()).length;
      if (await caches.delete(ownCacheName)) deletedKeys.add(ownCacheName);
    }
    return { deletedEntries, deletedKeys: Array.from(deletedKeys) };
  }

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
