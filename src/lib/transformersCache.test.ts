import { beforeEach, describe, expect, it, vi } from "vitest";

type MockEnv = {
  cacheKey: string;
  useBrowserCache: boolean;
  useCustomCache: boolean;
  customCache: unknown;
};

type MockCacheAdapter = {
  match: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
};

async function loadModule(options: { adapter: MockCacheAdapter | null }) {
  vi.resetModules();

  const env: MockEnv = {
    cacheKey: "transformers-cache",
    useBrowserCache: true,
    useCustomCache: false,
    customCache: null,
  };

  const ensurePersistentCacheStorage = vi.fn(async () => undefined);
  const getPersistentCacheAdapter = vi.fn(async () => options.adapter);

  vi.doMock("@huggingface/transformers", () => ({ env }));
  vi.doMock("./persistentCache", () => ({
    ensurePersistentCacheStorage,
    getPersistentCacheAdapter,
  }));

  const module = await import("./transformersCache");

  return {
    env,
    module,
    ensurePersistentCacheStorage,
    getPersistentCacheAdapter,
  };
}

describe("transformersCache", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("configures Transformers.js to use the persistent cache adapter", async () => {
    const adapter: MockCacheAdapter = {
      match: vi.fn(async () => undefined),
      put: vi.fn(async () => undefined),
    };
    const {
      env,
      module,
      ensurePersistentCacheStorage,
      getPersistentCacheAdapter,
    } = await loadModule({ adapter });

    const cache = await module.initializeTransformersCache();

    expect(cache).toBe(adapter);
    expect(ensurePersistentCacheStorage).toHaveBeenCalledOnce();
    expect(getPersistentCacheAdapter).toHaveBeenCalledWith("transformers-cache");
    expect(env.useCustomCache).toBe(true);
    expect(env.customCache).toBe(adapter);
    expect(env.useBrowserCache).toBe(false);
  });

  it("falls back to the Cache API when no persistent adapter is available", async () => {
    const cacheStore = {
      match: vi.fn(async () => undefined),
      put: vi.fn(async () => undefined),
    };
    const open = vi.fn(async () => cacheStore);
    vi.stubGlobal("caches", { open });

    const { module } = await loadModule({ adapter: null });

    const cache = await module.getTransformersModelCache();

    expect(cache).toBe(cacheStore);
    expect(open).toHaveBeenCalledWith("transformers-cache");
  });
});
