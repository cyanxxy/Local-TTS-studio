import { beforeEach, describe, expect, it, vi } from "vitest";

type MockPersistentCacheEntryRef = {
  cacheName: string;
  url: string;
};

function deletedRequestUrls(cacheDelete: ReturnType<typeof vi.fn>): string[] {
  return cacheDelete.mock.calls.map(([request]) => (request as Request).url);
}

async function loadModule(options?: {
  persistentNames?: string[];
  clearedEntries?: MockPersistentCacheEntryRef[];
  clearedCacheNames?: string[];
}) {
  vi.resetModules();

  const env = {
    cacheKey: "transformers-cache",
  };

  const getPersistentCacheNames = vi.fn(async () => options?.persistentNames ?? []);
  const clearPersistentCacheEntries = vi.fn(async () => options?.clearedEntries ?? []);
  const clearPersistentCacheStorage = vi.fn(async () => options?.clearedCacheNames ?? []);

  vi.doMock("@huggingface/transformers", () => ({ env }));
  vi.doMock("./persistentCache", () => ({
    getPersistentCacheNames,
    clearPersistentCacheEntries,
    clearPersistentCacheStorage,
  }));

  const module = await import("./modelCache");

  return {
    module,
    clearPersistentCacheEntries,
    clearPersistentCacheStorage,
    getPersistentCacheNames,
  };
}

describe("modelCache", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("clears only Supertonic entries when re-downloading Supertonic", async () => {
    const supertonicRequest = new Request("https://huggingface.co/onnx-community/Supertonic-TTS-2-ONNX/resolve/main/model.onnx");
    const kokoroRequest = new Request("https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/model.onnx");
    const cacheDelete = vi.fn(async () => true);
    const cacheKeys = vi.fn(async () => [supertonicRequest, kokoroRequest]);
    const open = vi.fn(async () => ({
      keys: cacheKeys,
      delete: cacheDelete,
    }));
    const deleteCache = vi.fn(async () => true);
    vi.stubGlobal("caches", {
      keys: vi.fn(async () => ["transformers-cache", "kokoro-voices"]),
      open,
      delete: deleteCache,
    });

    const {
      module,
      clearPersistentCacheEntries,
      clearPersistentCacheStorage,
    } = await loadModule({
      persistentNames: ["transformers-cache", "kokoro-voices"],
      clearedEntries: [{
        cacheName: "transformers-cache",
        url: "https://huggingface.co/onnx-community/Supertonic-TTS-2-ONNX/resolve/main/voices/female.bin",
      }],
    });

    const result = await module.clearModelCacheForModel("supertonic");

    expect(cacheDelete).toHaveBeenCalledOnce();
    expect(deletedRequestUrls(cacheDelete)).toEqual([supertonicRequest.url]);
    expect(deletedRequestUrls(cacheDelete)).not.toContain(kokoroRequest.url);
    expect(clearPersistentCacheStorage).not.toHaveBeenCalled();
    expect(clearPersistentCacheEntries).toHaveBeenCalledOnce();
    expect(result).toEqual({
      deletedEntries: 2,
      deletedKeys: [],
    });
  });

  it.each([
    ["kitten", "transformers-cache-kitten-v1"],
    ["paradee", "transformers-cache-paradee-v1"],
    ["piper", "transformers-cache-piper-v1"],
  ] as const)("deletes the cache of its own that holds %s's pinned files, and nothing else", async (model, cacheName) => {
    const requests = [new Request("https://huggingface.co/a/resolve/rev/one.onnx"), new Request("https://huggingface.co/a/resolve/rev/two.json")];
    const deleteCache = vi.fn(async () => true);
    vi.stubGlobal("caches", {
      keys: vi.fn(async () => ["transformers-cache", cacheName, "transformers-cache-kitten-v1", "transformers-cache-piper-v1"]),
      has: vi.fn(async (name: string) => name === cacheName),
      open: vi.fn(async () => ({ keys: vi.fn(async () => requests) })),
      delete: deleteCache,
    });
    const { module, clearPersistentCacheEntries } = await loadModule();

    const result = await module.clearModelCacheForModel(model);

    expect(deleteCache).toHaveBeenCalledOnce();
    expect(deleteCache).toHaveBeenCalledWith(cacheName);
    expect(clearPersistentCacheEntries).not.toHaveBeenCalled();
    expect(result).toEqual({ deletedEntries: 2, deletedKeys: [cacheName] });
  });

  it("clears only Chatterbox's repositories from the shared cache", async () => {
    const chatterbox = new Request("https://huggingface.co/ResembleAI/chatterbox-turbo-ONNX/resolve/rev/onnx/language_model_q4.onnx");
    const voice = new Request("https://huggingface.co/onnx-community/chatterbox-ONNX/resolve/rev/default_voice.wav");
    const kokoro = new Request("https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/model.onnx");
    const cacheDelete = vi.fn(async () => true);
    vi.stubGlobal("caches", {
      keys: vi.fn(async () => ["transformers-cache"]),
      open: vi.fn(async () => ({ keys: vi.fn(async () => [chatterbox, voice, kokoro]), delete: cacheDelete })),
    });
    const { module } = await loadModule();

    const result = await module.clearModelCacheForModel("chatterbox");

    expect(deletedRequestUrls(cacheDelete).sort()).toEqual([chatterbox.url, voice.url].sort());
    expect(result.deletedEntries).toBe(2);
  });

  it("reports nothing cleared when a model's own cache was never created", async () => {
    const deleteCache = vi.fn(async () => true);
    vi.stubGlobal("caches", { keys: vi.fn(async () => []), has: vi.fn(async () => false), delete: deleteCache });
    const { module } = await loadModule();

    expect(await module.clearModelCacheForModel("piper")).toEqual({ deletedEntries: 0, deletedKeys: [] });
    expect(deleteCache).not.toHaveBeenCalled();
  });

  it("clears Kokoro request entries and the dedicated voice cache", async () => {
    const supertonicRequest = new Request("https://huggingface.co/onnx-community/Supertonic-TTS-2-ONNX/resolve/main/model.onnx");
    const kokoroRequest = new Request("https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/model.onnx");
    const cacheDelete = vi.fn(async () => true);
    const open = vi.fn(async () => ({
      keys: vi.fn(async () => [supertonicRequest, kokoroRequest]),
      delete: cacheDelete,
    }));
    const deleteCache = vi.fn(async (key: string) => key === "kokoro-voices");
    vi.stubGlobal("caches", {
      keys: vi.fn(async () => ["transformers-cache", "kokoro-voices"]),
      open,
      delete: deleteCache,
    });

    const {
      module,
      clearPersistentCacheEntries,
      clearPersistentCacheStorage,
    } = await loadModule({
      persistentNames: ["transformers-cache", "kokoro-voices"],
      clearedEntries: [{
        cacheName: "transformers-cache",
        url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/config.json",
      }],
      clearedCacheNames: ["kokoro-voices"],
    });

    const result = await module.clearModelCacheForModel("kokoro");

    expect(cacheDelete).toHaveBeenCalledOnce();
    expect(deletedRequestUrls(cacheDelete)).toEqual([kokoroRequest.url]);
    expect(deletedRequestUrls(cacheDelete)).not.toContain(supertonicRequest.url);
    expect(deleteCache).toHaveBeenCalledOnce();
    expect(deleteCache).toHaveBeenCalledWith("kokoro-voices");
    expect(clearPersistentCacheStorage).toHaveBeenCalledWith(["kokoro-voices"]);
    expect(clearPersistentCacheEntries).toHaveBeenCalledOnce();
    expect(result).toEqual({
      deletedEntries: 2,
      deletedKeys: ["kokoro-voices", "indexeddb:kokoro-voices"],
    });
  });
});
