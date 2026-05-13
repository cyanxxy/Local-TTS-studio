import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const DB_NAME = "local-tts-model-cache-v1";

async function deleteDatabase(indexedDB: IDBFactory): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}

async function loadModule(options: { indexedDb?: boolean; caches?: unknown } = {}) {
  vi.resetModules();
  vi.unstubAllGlobals();

  if (options.indexedDb ?? true) {
    const idb = new IDBFactory();
    vi.stubGlobal("indexedDB", idb);
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    await deleteDatabase(idb);
  } else {
    vi.stubGlobal("indexedDB", undefined);
    vi.stubGlobal("IDBKeyRange", undefined);
  }

  if ("caches" in options) {
    vi.stubGlobal("caches", options.caches);
  } else {
    vi.stubGlobal("caches", undefined);
  }

  return import("./persistentCache");
}

describe("persistentCache", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns no adapter or names when IndexedDB is unavailable", async () => {
    const module = await loadModule({ indexedDb: false });

    await expect(module.getPersistentCacheNames()).resolves.toEqual([]);
    await expect(module.getPersistentCacheAdapter("models")).resolves.toBeNull();
    await expect(module.ensurePersistentCacheStorage()).resolves.toBeUndefined();
  });

  it("uses native CacheStorage when it is available", async () => {
    const caches = {
      open: vi.fn(async () => ({})),
      delete: vi.fn(async () => true),
    };
    const module = await loadModule({ caches });

    await module.ensurePersistentCacheStorage();
    await module.ensurePersistentCacheStorage();

    expect(caches.open).toHaveBeenCalledOnce();
    expect(caches.open).toHaveBeenCalledWith("__local_tts_cache_probe__");
    expect(globalThis.caches).toBe(caches);
  });

  it("stores, matches, deletes, and lists persistent cache entries", async () => {
    const module = await loadModule();
    const adapter = await module.getPersistentCacheAdapter("models");
    expect(adapter).not.toBeNull();

    await adapter?.put("https://example.com/model.bin", new Response("model", {
      status: 201,
      statusText: "Created",
      headers: { "x-test": "yes" },
    }));
    await adapter?.put(new Request("https://example.com/post.bin", { method: "POST" }), new Response("ignored"));

    const match = await adapter?.match(new URL("https://example.com/model.bin"));
    expect(match?.status).toBe(201);
    expect(match?.statusText).toBe("Created");
    expect(match?.headers.get("x-test")).toBe("yes");
    expect(await match?.text()).toBe("model");
    expect(await adapter?.match(new Request("https://example.com/model.bin", { method: "POST" }))).toBeUndefined();
    expect(await module.getPersistentCacheNames()).toEqual(["models"]);

    expect(await adapter?.delete?.("https://example.com/missing.bin")).toBe(false);
    expect(await adapter?.delete?.("https://example.com/model.bin")).toBe(true);
    expect(await adapter?.match("https://example.com/model.bin")).toBeUndefined();
  });

  it("installs persistent CacheStorage fallback when native cache probing fails", async () => {
    const module = await loadModule({
      caches: {
        open: vi.fn(async () => {
          throw new Error("disabled");
        }),
        delete: vi.fn(async () => false),
      },
    });

    await module.ensurePersistentCacheStorage();

    const storage = globalThis.caches;
    const adapter = await storage.open("fallback");
    await adapter.put("https://example.com/file.bin", new Response("cached"));
    expect(await (await adapter.match("https://example.com/file.bin"))?.text()).toBe("cached");
    expect(await storage.keys()).toEqual(["fallback"]);
    expect(await storage.delete("fallback")).toBe(true);
  });

  it("clears selected cache storages and matching entries", async () => {
    const module = await loadModule();
    const models = await module.getPersistentCacheAdapter("models");
    const voices = await module.getPersistentCacheAdapter("voices");

    await models?.put("https://example.com/model-a.bin", new Response("a"));
    await models?.put("https://example.com/model-b.bin", new Response("b"));
    await voices?.put("https://example.com/voice.bin", new Response("voice"));

    await expect(module.clearPersistentCacheStorage(["missing"])).resolves.toEqual([]);
    await expect(module.clearPersistentCacheEntries(
      (entry) => entry.url.endsWith("model-a.bin"),
      ["models"],
    )).resolves.toEqual([{ cacheName: "models", url: "https://example.com/model-a.bin" }]);

    await expect(module.getPersistentCacheNames()).resolves.toEqual(["models", "voices"]);
    await expect(module.clearPersistentCacheStorage(["voices"])).resolves.toEqual(["voices"]);
    await expect(module.getPersistentCacheNames()).resolves.toEqual(["models"]);
    await expect(module.clearPersistentCacheStorage()).resolves.toEqual(["models"]);
    await expect(module.getPersistentCacheNames()).resolves.toEqual([]);
  });

  it("returns no matching deletions when the persistent cache is empty", async () => {
    const module = await loadModule();

    await expect(module.clearPersistentCacheStorage()).resolves.toEqual([]);
    await expect(module.clearPersistentCacheEntries(() => true)).resolves.toEqual([]);
  });
});
