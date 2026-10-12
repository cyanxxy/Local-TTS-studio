// @vitest-environment node

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deletePinnedAssetCache,
  fetchPinnedAsset,
  pinnedAssetSizes,
  pinnedAssetUrl,
  prunePinnedAssetCache,
} from "./pinnedModelAssets";
import type { PinnedAssetManifest } from "./pinnedModelFetch";

const BYTES = new TextEncoder().encode("pinned model bytes");
const CONFIG = new TextEncoder().encode('{"sample_rate":24000}');

function gitBlobSha1(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

const MANIFEST: PinnedAssetManifest = {
  repo: "owner/model",
  revision: "0123456789abcdef0123456789abcdef01234567",
  files: {
    "model.onnx": { byteLength: BYTES.byteLength, sha256: createHash("sha256").update(BYTES).digest("hex") },
    "voices/a b.json": { byteLength: CONFIG.byteLength, gitBlobSha1: gitBlobSha1(CONFIG) },
  },
};
const FILE = "model.onnx";
const URL_ = pinnedAssetUrl(MANIFEST, FILE);
const OPTIONS = { cacheName: "transformers-cache-test-v1", label: "Test TTS" };

function fakeProgress() {
  return { update: vi.fn<(file: string, loaded: number) => void>(), complete: vi.fn<(file: string) => void>() };
}

class FakeCache {
  readonly entries = new Map<string, Response>();
  failPut = false;

  async match(url: string) {
    return this.entries.get(url)?.clone();
  }

  async put(url: string, response: Response) {
    if (this.failPut) throw new DOMException("Quota exceeded", "QuotaExceededError");
    this.entries.set(url, response);
  }

  async delete(request: string | Request) {
    return this.entries.delete(typeof request === "string" ? request : request.url);
  }

  async keys() {
    return Array.from(this.entries.keys(), (url) => new Request(url));
  }
}

function stubCaches(cache: FakeCache | null) {
  const storage = {
    open: vi.fn(async () => {
      if (!cache) throw new DOMException("Blocked", "SecurityError");
      return cache;
    }),
    delete: vi.fn(async () => true),
  };
  vi.stubGlobal("caches", storage);
  return storage;
}

/**
 * A streamed response delivering `bytes` in `parts` pieces, without
 * Content-Length. With `endless`, the stream stays open after them.
 */
function streamedResponse(bytes: Uint8Array, parts = 2, endless = false) {
  const size = Math.ceil(bytes.byteLength / parts);
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.byteLength; offset += size) controller.enqueue(bytes.slice(offset, offset + size));
      if (!endless) controller.close();
    },
    cancel,
  });
  return { response: new Response(body, { status: 200 }), cancel };
}

function text(buffer: ArrayBuffer): string {
  return new TextDecoder().decode(buffer);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pinnedAssetUrl and pinnedAssetSizes", () => {
  it("resolve files at the pinned commit, encoding each path segment", () => {
    expect(URL_).toBe("https://huggingface.co/owner/model/resolve/0123456789abcdef0123456789abcdef01234567/model.onnx");
    expect(pinnedAssetUrl(MANIFEST, "voices/a b.json")).toBe(
      "https://huggingface.co/owner/model/resolve/0123456789abcdef0123456789abcdef01234567/voices/a%20b.json",
    );
    expect(pinnedAssetSizes(MANIFEST, ["model.onnx", "voices/a b.json"])).toEqual({
      "model.onnx": BYTES.byteLength,
      "voices/a b.json": CONFIG.byteLength,
    });
  });

  it("refuse files the manifest does not pin", async () => {
    expect(() => pinnedAssetSizes(MANIFEST, ["toString"])).toThrow("toString is not a pinned asset of owner/model.");
    await expect(fetchPinnedAsset(MANIFEST, "other.onnx", OPTIONS)).rejects.toThrow("other.onnx is not a pinned asset");
  });
});

describe("fetchPinnedAsset", () => {
  it("streams, verifies and caches a download, sizing the buffer from the manifest", async () => {
    const cache = new FakeCache();
    stubCaches(cache);
    const fetchMock = vi.fn(async () => streamedResponse(BYTES, 3).response);
    vi.stubGlobal("fetch", fetchMock);
    const progress = fakeProgress();

    const buffer = await fetchPinnedAsset(MANIFEST, FILE, { ...OPTIONS, progress });

    expect(fetchMock).toHaveBeenCalledWith(URL_, { signal: undefined });
    expect(text(buffer)).toBe("pinned model bytes");
    expect(progress.update.mock.calls).toEqual([[FILE, 6], [FILE, 12], [FILE, 18]]);
    expect(progress.complete).toHaveBeenCalledExactlyOnceWith(FILE);
    const cached = cache.entries.get(URL_)!;
    expect(cached.headers.get("content-length")).toBe(String(BYTES.byteLength));
    expect(text(await cached.arrayBuffer())).toBe("pinned model bytes");
  });

  it("serves a verified cached copy without the network", async () => {
    const cache = new FakeCache();
    cache.entries.set(URL_, new Response(BYTES.slice()));
    stubCaches(cache);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const progress = fakeProgress();

    const buffer = await fetchPinnedAsset(MANIFEST, FILE, { ...OPTIONS, progress });

    expect(text(buffer)).toBe("pinned model bytes");
    expect(progress.complete).toHaveBeenCalledExactlyOnceWith(FILE);
    expect(progress.update).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("evicts a cached copy that fails verification and downloads it again", async () => {
    const cache = new FakeCache();
    cache.entries.set(URL_, new Response(new TextEncoder().encode("tampered model bytes")));
    stubCaches(cache);
    vi.stubGlobal("fetch", vi.fn(async () => streamedResponse(BYTES).response));

    const buffer = await fetchPinnedAsset(MANIFEST, FILE, OPTIONS);

    expect(text(buffer)).toBe("pinned model bytes");
    expect(text(await cache.entries.get(URL_)!.arrayBuffer())).toBe("pinned model bytes");
  });

  it("rejects a download whose digest does not match and never caches it", async () => {
    const cache = new FakeCache();
    stubCaches(cache);
    const wrong = new TextEncoder().encode("pinned model BYTES");
    vi.stubGlobal("fetch", vi.fn(async () => streamedResponse(wrong).response));

    await expect(fetchPinnedAsset(MANIFEST, FILE, OPTIONS)).rejects.toThrow("Test TTS model.onnx failed integrity verification.");
    expect(cache.entries.size).toBe(0);
  });

  it("verifies regular files by their git blob id", async () => {
    stubCaches(new FakeCache());
    vi.stubGlobal("fetch", vi.fn(async () => streamedResponse(CONFIG).response));

    expect(text(await fetchPinnedAsset(MANIFEST, "voices/a b.json", OPTIONS))).toBe('{"sample_rate":24000}');
  });

  it("rejects a short download", async () => {
    stubCaches(new FakeCache());
    vi.stubGlobal("fetch", vi.fn(async () => streamedResponse(BYTES.slice(0, 5)).response));

    await expect(fetchPinnedAsset(MANIFEST, FILE, OPTIONS)).rejects.toThrow("Test TTS model.onnx was truncated at 5 of 18 bytes.");
  });

  it("checks the size of a body it cannot stream", async () => {
    stubCaches(new FakeCache());
    const unstreamed = (bytes: Uint8Array) => {
      const response = new Response(bytes.slice());
      Object.defineProperty(response, "body", { value: null });
      return response;
    };
    vi.stubGlobal("fetch", vi.fn(async () => unstreamed(BYTES.slice(0, 5))));
    await expect(fetchPinnedAsset(MANIFEST, FILE, OPTIONS)).rejects.toThrow("Test TTS model.onnx did not match its pinned size.");

    vi.stubGlobal("fetch", vi.fn(async () => unstreamed(BYTES)));
    expect(text(await fetchPinnedAsset(MANIFEST, FILE, OPTIONS))).toBe("pinned model bytes");
  });

  it("stops a download whose signal aborts, before reporting more progress", async () => {
    stubCaches(new FakeCache());
    const { response, cancel } = streamedResponse(BYTES, 3, true);
    vi.stubGlobal("fetch", vi.fn(async () => response));
    const controller = new AbortController();
    const progress = fakeProgress();
    progress.update.mockImplementationOnce(() => controller.abort(new Error("load abandoned")));

    await expect(fetchPinnedAsset(MANIFEST, FILE, { ...OPTIONS, progress, signal: controller.signal })).rejects.toThrow("load abandoned");
    expect(progress.update).toHaveBeenCalledTimes(1);
    expect(progress.complete).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
  });

  it("reports no completion for a verified download whose signal aborted meanwhile", async () => {
    const cache = new FakeCache();
    stubCaches(cache);
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => streamedResponse(BYTES).response));
    vi.spyOn(cache, "put").mockImplementation(async (url, cachedResponse) => {
      cache.entries.set(url, cachedResponse);
      controller.abort(new Error("load abandoned"));
    });
    const progress = fakeProgress();

    await expect(fetchPinnedAsset(MANIFEST, FILE, { ...OPTIONS, progress, signal: controller.signal })).rejects.toThrow("load abandoned");
    // The verified bytes still reach the cache for the next load.
    expect(cache.entries.has(URL_)).toBe(true);
    expect(progress.complete).not.toHaveBeenCalled();
  });

  it("stops reading and cancels the body once a download outgrows its pinned size", async () => {
    stubCaches(new FakeCache());
    const { response, cancel } = streamedResponse(new Uint8Array(BYTES.byteLength + 1), 2, true);
    vi.stubGlobal("fetch", vi.fn(async () => response));

    await expect(fetchPinnedAsset(MANIFEST, FILE, OPTIONS)).rejects.toThrow("Test TTS model.onnx exceeded its pinned size.");
    expect(cancel).toHaveBeenCalled();
  });

  it("reports HTTP failures", async () => {
    stubCaches(new FakeCache());
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404 })));

    await expect(fetchPinnedAsset(MANIFEST, FILE, OPTIONS)).rejects.toThrow("Failed to download Test TTS model.onnx: HTTP 404.");
  });

  it("downloads without caching when Cache Storage is missing, blocked or full", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(BYTES.slice())));

    vi.stubGlobal("caches", undefined);
    expect(text(await fetchPinnedAsset(MANIFEST, FILE, OPTIONS))).toBe("pinned model bytes");

    stubCaches(null);
    expect(text(await fetchPinnedAsset(MANIFEST, FILE, OPTIONS))).toBe("pinned model bytes");

    const full = new FakeCache();
    full.failPut = true;
    stubCaches(full);
    expect(text(await fetchPinnedAsset(MANIFEST, FILE, OPTIONS))).toBe("pinned model bytes");
    expect(full.entries.size).toBe(0);

    const unreadable = new FakeCache();
    vi.spyOn(unreadable, "match").mockRejectedValue(new Error("storage gone"));
    stubCaches(unreadable);
    expect(text(await fetchPinnedAsset(MANIFEST, FILE, OPTIONS))).toBe("pinned model bytes");
  });

  it("caches the decoded body with its content type", async () => {
    const cache = new FakeCache();
    stubCaches(cache);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(BYTES.slice(), {
      headers: { "content-type": "application/octet-stream", "content-length": "7" },
    })));

    await fetchPinnedAsset(MANIFEST, FILE, OPTIONS);

    const cached = cache.entries.get(URL_)!;
    expect(cached.headers.get("content-type")).toBe("application/octet-stream");
    expect(cached.headers.get("content-length")).toBe(String(BYTES.byteLength));
  });
});

describe("prunePinnedAssetCache and deletePinnedAssetCache", () => {
  it("removes only entries no manifest file points at", async () => {
    const cache = new FakeCache();
    const stale = pinnedAssetUrl({ ...MANIFEST, revision: "f".repeat(40) }, FILE);
    const otherModel: PinnedAssetManifest = { repo: "owner/other", revision: MANIFEST.revision, files: { [FILE]: MANIFEST.files[FILE] } };
    cache.entries.set(URL_, new Response("keep"));
    cache.entries.set(pinnedAssetUrl(otherModel, FILE), new Response("keep too"));
    cache.entries.set(stale, new Response("old revision"));
    stubCaches(cache);

    await prunePinnedAssetCache(OPTIONS.cacheName, [MANIFEST, otherModel]);

    expect(Array.from(cache.entries.keys())).toEqual([URL_, pinnedAssetUrl(otherModel, FILE)]);
  });

  it("never fails a load over housekeeping", async () => {
    const cache = new FakeCache();
    vi.spyOn(cache, "keys").mockRejectedValue(new Error("storage gone"));
    stubCaches(cache);
    await expect(prunePinnedAssetCache(OPTIONS.cacheName, [MANIFEST])).resolves.toBeUndefined();

    vi.stubGlobal("caches", undefined);
    await expect(prunePinnedAssetCache(OPTIONS.cacheName, [MANIFEST])).resolves.toBeUndefined();
    await expect(deletePinnedAssetCache(OPTIONS.cacheName)).resolves.toBeUndefined();
  });

  it("deletes the whole named cache", async () => {
    const storage = stubCaches(new FakeCache());
    storage.delete.mockRejectedValueOnce(new Error("blocked"));

    await expect(deletePinnedAssetCache(OPTIONS.cacheName)).resolves.toBeUndefined();
    await deletePinnedAssetCache(OPTIONS.cacheName);

    expect(storage.delete).toHaveBeenCalledWith(OPTIONS.cacheName);
    expect(storage.delete).toHaveBeenCalledTimes(2);
  });
});
