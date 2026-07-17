import { describe, expect, it, vi } from "vitest";
import {
  createRevisionPinnedFetch,
  ensureRevisionScopedCache,
  ensureRevisionScopedCacheEntries,
  pinHuggingFaceModelUrl,
} from "./pinnedModelFetch";

describe("revision-pinned model fetch", () => {
  const model = "onnx-community/Kokoro-82M-v1.0-ONNX";
  const revision = "1939ad2a8e416c0acfeecc08a694d14ef25f2231";

  it("pins every selected-model resolve shape while preserving unrelated URLs", () => {
    expect(pinHuggingFaceModelUrl(
      `https://huggingface.co/${model}/resolve/main/voices/af_heart.bin`,
      model,
      revision,
    )).toBe(`https://huggingface.co/${model}/resolve/${revision}/voices/af_heart.bin`);
    expect(pinHuggingFaceModelUrl(
      "https://huggingface.co/other/model/resolve/main/config.json",
      model,
      revision,
    )).toBe("https://huggingface.co/other/model/resolve/main/config.json");
    expect(pinHuggingFaceModelUrl(
      `https://hf.co/${encodeURIComponent(model)}/resolve/a-release-tag/voices/af_heart.bin?download=true`,
      model,
      revision,
    )).toBe(`https://hf.co/${model}/resolve/${revision}/voices/af_heart.bin?download=true`);
    expect(pinHuggingFaceModelUrl(
      `https://huggingface.co/api/resolve-cache/models/${model}/main/model.onnx`,
      model,
      revision,
    )).toBe(`https://huggingface.co/api/resolve-cache/models/${model}/${revision}/model.onnx`);
    expect(pinHuggingFaceModelUrl(
      `https://huggingface.co/${model}/resolve/${revision}/config.json`,
      model,
      revision,
    )).toBe(`https://huggingface.co/${model}/resolve/${revision}/config.json`);
    expect(pinHuggingFaceModelUrl(
      `https://www.huggingface.co/${model}/resolve/main/config.json`,
      model,
      revision,
    )).toBe(`https://www.huggingface.co/${model}/resolve/${revision}/config.json`);
  });

  it("pins string fetch inputs without changing request options", async () => {
    const baseFetch = vi.fn(async () => new Response("ok"));
    const pinnedFetch = createRevisionPinnedFetch(baseFetch as typeof fetch, model, revision);
    const init = { cache: "no-store" as const };
    await pinnedFetch(`https://huggingface.co/${model}/resolve/main/config.json`, init);

    expect(baseFetch).toHaveBeenCalledWith(
      `https://huggingface.co/${model}/resolve/${revision}/config.json`,
      init,
    );
  });

  it("replaces unmarked or stale mutable caches and preserves the active revision", async () => {
    const entries = new Map<string, Response>();
    entries.set("https://huggingface.co/model/resolve/main/voice.bin", new Response("stale"));
    const cache = {
      match: vi.fn(async (key: RequestInfo | URL) => entries.get(String(key))?.clone()),
      put: vi.fn(async (key: RequestInfo | URL, value: Response) => {
        entries.set(String(key), value.clone());
      }),
    };
    const cacheStorage = {
      open: vi.fn(async () => cache),
      delete: vi.fn(async () => {
        entries.clear();
        return true;
      }),
    };
    const marker = "https://huggingface.co/model/open-tts-cache-revision";

    await ensureRevisionScopedCache(cacheStorage, "model-voices", marker, revision);
    expect(cacheStorage.delete).toHaveBeenCalledTimes(1);
    expect(entries.has("https://huggingface.co/model/resolve/main/voice.bin")).toBe(false);
    expect(await (await cache.match(marker))?.text()).toBe(revision);

    await ensureRevisionScopedCache(cacheStorage, "model-voices", marker, revision);
    expect(cacheStorage.delete).toHaveBeenCalledTimes(1);

    await ensureRevisionScopedCache(cacheStorage, "model-voices", marker, "new-revision");
    expect(cacheStorage.delete).toHaveBeenCalledTimes(2);
    expect(await (await cache.match(marker))?.text()).toBe("new-revision");
  });

  it("removes only stale model entries from a shared Transformers cache", async () => {
    const marker = "https://huggingface.co/model/open-tts-transformers-cache-revision";
    const staleModel = new Request(`https://huggingface.co/${model}/resolve/main/config.json`);
    const unrelated = new Request("https://huggingface.co/other/model/resolve/main/config.json");
    const entries = new Map<string, Response>([
      [staleModel.url, new Response("stale")],
      [unrelated.url, new Response("keep")],
    ]);
    const cache = {
      match: vi.fn(async (key: RequestInfo | URL) => entries.get(String(key))?.clone()),
      put: vi.fn(async (key: RequestInfo | URL, value: Response) => {
        entries.set(String(key), value.clone());
      }),
      keys: vi.fn(async () => [...entries.keys()].map((url) => new Request(url))),
      delete: vi.fn(async (key: RequestInfo | URL) => entries.delete(
        typeof key === "string" ? key : key instanceof URL ? key.toString() : key.url,
      )),
    };

    await ensureRevisionScopedCacheEntries(
      { open: vi.fn(async () => cache) },
      "transformers-cache",
      marker,
      revision,
      (url) => url.includes(model),
    );

    expect(entries.has(staleModel.url)).toBe(false);
    expect(entries.has(unrelated.url)).toBe(true);
    expect(await (await cache.match(marker))?.text()).toBe(revision);
  });
});
