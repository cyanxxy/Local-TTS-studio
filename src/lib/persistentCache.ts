const CACHE_DB_NAME = "local-tts-model-cache-v1";
const CACHE_STORE_NAME = "cache-entries";
const CACHE_KEY_DELIMITER = "::";
const CACHE_PROBE_NAME = "__local_tts_cache_probe__";

interface CacheEntryRecord {
  id: string;
  cacheName: string;
  url: string;
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: ArrayBuffer;
  updatedAt: number;
}

export interface CacheAdapterLike {
  match: (request: RequestInfo | URL) => Promise<Response | undefined>;
  put: (request: RequestInfo | URL, response: Response) => Promise<void>;
  delete?: (request: RequestInfo | URL) => Promise<boolean>;
}

export interface PersistentCacheEntryRef {
  cacheName: string;
  url: string;
}

interface CacheStorageLike {
  open: (cacheName: string) => Promise<CacheAdapterLike>;
  keys: () => Promise<string[]>;
  delete: (cacheName: string) => Promise<boolean>;
}

let dbPromise: Promise<IDBDatabase> | null = null;
let nativeCacheUsablePromise: Promise<boolean> | null = null;

function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function toUrl(request: RequestInfo | URL): string {
  if (typeof request === "string") return request;
  if (request instanceof URL) return request.toString();
  return request.url;
}

function toMethod(request: RequestInfo | URL): string {
  if (request instanceof Request) return request.method.toUpperCase();
  return "GET";
}

function toEntryId(cacheName: string, url: string): string {
  return `${cacheName}${CACHE_KEY_DELIMITER}${url}`;
}

/**
 * Recovers an entry's URL from its primary key. The key always starts with the
 * cache name, so slicing past it stays exact even when a name or URL itself
 * contains the delimiter.
 */
function urlFromEntryId(cacheName: string, entryId: string): string {
  const prefix = `${cacheName}${CACHE_KEY_DELIMITER}`;
  return entryId.startsWith(prefix) ? entryId.slice(prefix.length) : entryId;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
  });
}

async function openDatabase(): Promise<IDBDatabase> {
  if (!isIndexedDbAvailable()) {
    throw new Error("IndexedDB is not available in this environment.");
  }

  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(CACHE_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(CACHE_STORE_NAME)) {
          const store = db.createObjectStore(CACHE_STORE_NAME, { keyPath: "id" });
          store.createIndex("cacheName", "cacheName", { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Failed to open cache database."));
    });
  }

  return dbPromise;
}

async function readEntry(cacheName: string, url: string): Promise<CacheEntryRecord | undefined> {
  const db = await openDatabase();
  const transaction = db.transaction(CACHE_STORE_NAME, "readonly");
  const store = transaction.objectStore(CACHE_STORE_NAME);
  const request = store.get(toEntryId(cacheName, url));
  const result = await requestToPromise(request);
  // Read-only transactions auto-commit — no need to await transactionDone.
  return result as CacheEntryRecord | undefined;
}

async function writeEntry(cacheName: string, url: string, response: Response): Promise<void> {
  const db = await openDatabase();
  const body = await response.arrayBuffer();
  const headers = Array.from(response.headers.entries());
  const entry: CacheEntryRecord = {
    id: toEntryId(cacheName, url),
    cacheName,
    url,
    status: response.status,
    statusText: response.statusText,
    headers,
    body,
    updatedAt: Date.now(),
  };

  const transaction = db.transaction(CACHE_STORE_NAME, "readwrite");
  const store = transaction.objectStore(CACHE_STORE_NAME);
  store.put(entry);
  await transactionDone(transaction);
}

// Every cached model file is one record holding the whole body (hundreds of
// MB for the largest), so listing, existence checks, and deletions below walk
// keys only. A value cursor or get() would deserialize each body just to read
// its cache name.

async function deleteEntry(cacheName: string, url: string): Promise<boolean> {
  const db = await openDatabase();
  const transaction = db.transaction(CACHE_STORE_NAME, "readwrite");
  const store = transaction.objectStore(CACHE_STORE_NAME);
  const entryId = toEntryId(cacheName, url);
  const countRequest = store.count(entryId);
  let existed = false;
  countRequest.onsuccess = () => {
    existed = countRequest.result > 0;
    // Issued from the success callback so it joins the same transaction.
    if (existed) store.delete(entryId);
  };
  await transactionDone(transaction);
  return existed;
}

async function deleteByCacheName(cacheName: string): Promise<boolean> {
  const db = await openDatabase();
  const transaction = db.transaction(CACHE_STORE_NAME, "readwrite");
  const store = transaction.objectStore(CACHE_STORE_NAME);
  const index = store.index("cacheName");
  const request = index.openKeyCursor(IDBKeyRange.only(cacheName));
  let deletedAny = false;

  await new Promise<void>((resolve, reject) => {
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      deletedAny = true;
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error("Failed to iterate cache entries."));
  });

  await transactionDone(transaction);
  return deletedAny;
}

async function deleteMatchingEntries(
  cacheNames: readonly string[] | undefined,
  matches: (entry: PersistentCacheEntryRef) => boolean,
): Promise<PersistentCacheEntryRef[]> {
  const db = await openDatabase();
  const transaction = db.transaction(CACHE_STORE_NAME, "readwrite");
  const store = transaction.objectStore(CACHE_STORE_NAME);
  // The cacheName index yields each record's name (cursor.key) and primary key
  // without its value; the URL is recovered from the primary key.
  const request = store.index("cacheName").openKeyCursor();
  const selectedNames = cacheNames ? new Set(cacheNames) : null;
  const deleted: PersistentCacheEntryRef[] = [];

  await new Promise<void>((resolve, reject) => {
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }

      const cacheName = String(cursor.key);
      if (!selectedNames || selectedNames.has(cacheName)) {
        const ref = {
          cacheName,
          url: urlFromEntryId(cacheName, String(cursor.primaryKey)),
        };
        if (matches(ref)) {
          deleted.push(ref);
          store.delete(cursor.primaryKey);
        }
      }

      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error("Failed to iterate cache entries."));
  });

  await transactionDone(transaction);
  return deleted;
}

async function listCacheNames(): Promise<string[]> {
  if (!isIndexedDbAvailable()) return [];

  const db = await openDatabase();
  const transaction = db.transaction(CACHE_STORE_NAME, "readonly");
  const store = transaction.objectStore(CACHE_STORE_NAME);
  // "nextunique" visits each distinct cache name once, reading keys only.
  const request = store.index("cacheName").openKeyCursor(null, "nextunique");
  const names = new Set<string>();

  await new Promise<void>((resolve, reject) => {
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      names.add(String(cursor.key));
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error("Failed to read cache entries."));
  });

  await transactionDone(transaction);
  return Array.from(names).sort();
}

async function clearAllEntries(): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(CACHE_STORE_NAME, "readwrite");
  const store = transaction.objectStore(CACHE_STORE_NAME);
  store.clear();
  await transactionDone(transaction);
}

function createPersistentCacheStorage(): CacheStorageLike | null {
  if (!isIndexedDbAvailable()) return null;

  return {
    async open(cacheName: string): Promise<CacheAdapterLike> {
      return {
        async match(request: RequestInfo | URL): Promise<Response | undefined> {
          if (toMethod(request) !== "GET") return undefined;
          const entry = await readEntry(cacheName, toUrl(request));
          if (!entry) return undefined;
          // IndexedDB hands back a fresh structured clone on every read, so the
          // body is already private to this response.
          return new Response(entry.body, {
            status: entry.status,
            statusText: entry.statusText,
            headers: new Headers(entry.headers),
          });
        },
        async put(request: RequestInfo | URL, response: Response): Promise<void> {
          if (toMethod(request) !== "GET") return;
          const url = toUrl(request);
          await writeEntry(cacheName, url, response);
        },
        async delete(request: RequestInfo | URL): Promise<boolean> {
          if (toMethod(request) !== "GET") return false;
          const url = toUrl(request);
          return deleteEntry(cacheName, url);
        },
      };
    },
    async keys(): Promise<string[]> {
      return listCacheNames();
    },
    async delete(cacheName: string): Promise<boolean> {
      return deleteByCacheName(cacheName);
    },
  };
}

async function canUseNativeCacheStorage(): Promise<boolean> {
  if (typeof caches === "undefined") return false;
  if (!nativeCacheUsablePromise) {
    nativeCacheUsablePromise = (async () => {
      try {
        await caches.open(CACHE_PROBE_NAME);
        await caches.delete(CACHE_PROBE_NAME);
        return true;
      } catch {
        return false;
      }
    })();
  }
  return nativeCacheUsablePromise;
}

export async function ensurePersistentCacheStorage(): Promise<void> {
  if (await canUseNativeCacheStorage()) return;

  const persistentStorage = createPersistentCacheStorage();
  if (!persistentStorage) return;

  const target = globalThis as unknown as { caches?: unknown };

  try {
    Object.defineProperty(target, "caches", {
      value: persistentStorage,
      writable: true,
      configurable: true,
    });
  } catch {
    try {
      target.caches = persistentStorage;
    } catch {
      // Ignore if runtime does not allow patching global `caches`.
    }
  }
}

export async function getPersistentCacheAdapter(cacheName: string): Promise<CacheAdapterLike | null> {
  const storage = createPersistentCacheStorage();
  if (!storage) return null;
  return storage.open(cacheName);
}

export async function getPersistentCacheNames(): Promise<string[]> {
  return listCacheNames();
}

export async function clearPersistentCacheStorage(cacheNames?: readonly string[]): Promise<string[]> {
  const names = await listCacheNames();
  if (names.length === 0) return [];

  const selected = cacheNames
    ? names.filter((name) => cacheNames.includes(name))
    : names;

  if (selected.length === 0) return [];

  if (!cacheNames) {
    await clearAllEntries();
    return selected;
  }

  await Promise.all(selected.map((name) => deleteByCacheName(name)));
  return selected;
}

export async function clearPersistentCacheEntries(
  matches: (entry: PersistentCacheEntryRef) => boolean,
  cacheNames?: readonly string[],
): Promise<PersistentCacheEntryRef[]> {
  const names = await listCacheNames();
  if (names.length === 0) return [];

  const selected = cacheNames
    ? names.filter((name) => cacheNames.includes(name))
    : names;
  if (selected.length === 0) return [];

  return deleteMatchingEntries(selected, matches);
}
