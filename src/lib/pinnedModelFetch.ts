export function pinHuggingFaceModelUrl(
  url: string,
  modelId: string,
  revision: string,
): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const hostname = parsed.hostname.toLowerCase();
  const huggingFaceHost = hostname === "huggingface.co"
    || hostname === "hf.co"
    || hostname.endsWith(".huggingface.co")
    || hostname.endsWith(".hf.co");
  if (parsed.protocol !== "https:" || !huggingFaceHost) {
    return url;
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(parsed.pathname);
  } catch {
    return url;
  }
  const resolvePrefix = `/${modelId}/resolve/`;
  const resolveCachePrefix = `/api/resolve-cache/models/${modelId}/`;
  const prefix = decodedPath.startsWith(resolvePrefix)
    ? resolvePrefix
    : decodedPath.startsWith(resolveCachePrefix)
      ? resolveCachePrefix
      : null;
  if (!prefix) return url;

  const remainder = decodedPath.slice(prefix.length);
  const slash = remainder.indexOf("/");
  if (slash < 0) return url;
  const requestedRevision = remainder.slice(0, slash);
  if (requestedRevision === revision) return url;
  parsed.pathname = `${prefix}${revision}${remainder.slice(slash)}`;
  return parsed.toString();
}

export function createRevisionPinnedFetch(
  baseFetch: typeof fetch,
  modelId: string,
  revision: string,
): typeof fetch {
  return (input, init) => {
    if (typeof input === "string") {
      return baseFetch(pinHuggingFaceModelUrl(input, modelId, revision), init);
    }
    if (input instanceof URL) {
      return baseFetch(new URL(pinHuggingFaceModelUrl(input.toString(), modelId, revision)), init);
    }
    const pinnedUrl = pinHuggingFaceModelUrl(input.url, modelId, revision);
    return baseFetch(pinnedUrl === input.url ? input : new Request(pinnedUrl, input), init);
  };
}

interface RevisionCache {
  match(request: RequestInfo | URL): Promise<Response | undefined>;
  put(request: RequestInfo | URL, response: Response): Promise<void>;
}

interface RevisionEntryCache extends RevisionCache {
  keys(): Promise<readonly Request[]>;
  delete(request: RequestInfo | URL): Promise<boolean>;
}

interface RevisionCacheStorage {
  open(cacheName: string): Promise<RevisionCache>;
  delete(cacheName: string): Promise<boolean>;
}

/**
 * Libraries that hard-code a mutable URL as their cache key can still reuse
 * stale bytes even when fetch itself is revision-pinned. Keep a revision
 * marker beside those entries and replace the whole dedicated cache whenever
 * the application pin changes (or when migrating an unmarked legacy cache).
 */
export async function ensureRevisionScopedCache(
  cacheStorage: RevisionCacheStorage,
  cacheName: string,
  markerUrl: string,
  revision: string,
): Promise<void> {
  let cache = await cacheStorage.open(cacheName);
  const marker = await cache.match(markerUrl);
  const cachedRevision = marker ? await marker.text() : null;
  if (cachedRevision === revision) return;

  await cacheStorage.delete(cacheName);
  cache = await cacheStorage.open(cacheName);
  await cache.put(markerUrl, new Response(revision, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  }));
}

/** Revision-scope one model's entries inside a cache shared with other models. */
export async function ensureRevisionScopedCacheEntries(
  cacheStorage: Pick<RevisionCacheStorage, "open">,
  cacheName: string,
  markerUrl: string,
  revision: string,
  belongsToModel: (url: string) => boolean,
): Promise<void> {
  const cache = await cacheStorage.open(cacheName) as RevisionEntryCache;
  const marker = await cache.match(markerUrl);
  const cachedRevision = marker ? await marker.text() : null;
  if (cachedRevision === revision) return;

  for (const request of await cache.keys()) {
    if (request.url === markerUrl || belongsToModel(request.url)) {
      await cache.delete(request);
    }
  }
  await cache.put(markerUrl, new Response(revision, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  }));
}
