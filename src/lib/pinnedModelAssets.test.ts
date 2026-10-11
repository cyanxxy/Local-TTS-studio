// @vitest-environment node

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pinnedModelFileUrl, type PinnedModelFile } from "./manifests/types";
import {
  deletePinnedModelCache,
  fetchPinnedModelFile,
  prunePinnedModelCache,
  trackDownloadProgress,
} from "./pinnedModelAssets";

const BYTES = new TextEncoder().encode("pinned model bytes");

function pinned(bytes: Uint8Array, path = "model.onnx"): PinnedModelFile {
  return {
    repo: "owner/model",
    revision: "0123456789abcdef0123456789abcdef01234567",
    path,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    license: "apache-2.0",
  };
}

const FILE = pinned(BYTES);
const URL_ = pinnedModelFileUrl(FILE);
const OPTIONS = { cacheName: "transformers-cache-test-v1", label: "Test TTS" };

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

describe("fetchPinnedModelFile", () => {
  it("streams, verifies and caches a download, sizing the buffer from the manifest", async () => {
    const cache = new FakeCache();
    stubCaches(cache);
    const fetchMock = vi.fn(async () => streamedResponse(BYTES, 3).response);
    vi.stubGlobal("fetch", fetchMock);
    const progress: number[] = [];

    const buffer = await fetchPinnedModelFile(FILE, { ...OPTIONS, onProgress: (bytes) => progress.push(bytes) });

    expect(fetchMock).toHaveBeenCalledWith(URL_);
    expect(text(buffer)).toBe("pinned model bytes");
    expect(progress).toEqual([6, 12, 18]);
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
    const onProgress = vi.fn();

    const buffer = await fetchPinnedModelFile(FILE, { ...OPTIONS, onProgress });

    expect(text(buffer)).toBe("pinned model bytes");
    expect(onProgress).toHaveBeenCalledWith(BYTES.byteLength);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("evicts a cached copy that fails verification and downloads it again", async () => {
    const cache = new FakeCache();
    cache.entries.set(URL_, new Response(new TextEncoder().encode("tampered model bytes")));
    stubCaches(cache);
    vi.stubGlobal("fetch", vi.fn(async () => streamedResponse(BYTES).response));

    const buffer = await fetchPinnedModelFile(FILE, OPTIONS);

    expect(text(buffer)).toBe("pinned model bytes");
    expect(text(await cache.entries.get(URL_)!.arrayBuffer())).toBe("pinned model bytes");
  });

  it("rejects a download whose digest does not match and never caches it", async () => {
    const cache = new FakeCache();
    stubCaches(cache);
    const wrong = new TextEncoder().encode("pinned model BYTES");
    vi.stubGlobal("fetch", vi.fn(async () => streamedResponse(wrong).response));

    await expect(fetchPinnedModelFile(FILE, OPTIONS)).rejects.toThrow("Test TTS model.onnx failed integrity verification.");
    expect(cache.entries.size).toBe(0);
  });

  it("rejects a short download", async () => {
    stubCaches(new FakeCache());
    vi.stubGlobal("fetch", vi.fn(async () => streamedResponse(BYTES.slice(0, 5)).response));

    await expect(fetchPinnedModelFile(FILE, OPTIONS)).rejects.toThrow("failed integrity verification");
  });

  it("stops reading and cancels the body once a download outgrows its pinned size", async () => {
    stubCaches(new FakeCache());
    const { response, cancel } = streamedResponse(new Uint8Array(BYTES.byteLength + 1), 2, true);
    vi.stubGlobal("fetch", vi.fn(async () => response));

    await expect(fetchPinnedModelFile(FILE, OPTIONS)).rejects.toThrow("Test TTS model.onnx is larger than its pinned size.");
    expect(cancel).toHaveBeenCalled();
  });

  it("reports HTTP failures", async () => {
    stubCaches(new FakeCache());
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404 })));

    await expect(fetchPinnedModelFile(FILE, OPTIONS)).rejects.toThrow("Failed to download Test TTS model.onnx: HTTP 404.");
  });

  it("downloads without caching when Cache Storage is missing, blocked or full", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(BYTES.slice())));

    vi.stubGlobal("caches", undefined);
    expect(text(await fetchPinnedModelFile(FILE, OPTIONS))).toBe("pinned model bytes");

    stubCaches(null);
    expect(text(await fetchPinnedModelFile(FILE, OPTIONS))).toBe("pinned model bytes");

    const full = new FakeCache();
    full.failPut = true;
    stubCaches(full);
    expect(text(await fetchPinnedModelFile(FILE, OPTIONS))).toBe("pinned model bytes");
    expect(full.entries.size).toBe(0);
  });
});

describe("trackDownloadProgress", () => {
  it("weights every file by its pinned size from the start and clamps overshoot", () => {
    const small = pinned(new Uint8Array(10), "config.json");
    const large = pinned(new Uint8Array(90), "model.onnx");
    const onProgress = vi.fn();
    const track = trackDownloadProgress([small, large], onProgress);

    track(small)(10);
    track(large)(45);
    track(large)(500);

    expect(onProgress.mock.calls.map(([fraction]) => fraction)).toEqual([0.1, 0.55, 1]);
  });

  it("reports completion for an empty file set", () => {
    const onProgress = vi.fn();
    trackDownloadProgress([], onProgress)(FILE)(1);

    expect(onProgress).toHaveBeenCalledWith(1);
  });
});

describe("prunePinnedModelCache and deletePinnedModelCache", () => {
  it("removes only entries no manifest file points at", async () => {
    const cache = new FakeCache();
    const stale = pinnedModelFileUrl({ ...FILE, revision: "f".repeat(40) });
    cache.entries.set(URL_, new Response("keep"));
    cache.entries.set(stale, new Response("old revision"));
    stubCaches(cache);

    await prunePinnedModelCache(OPTIONS.cacheName, [FILE]);

    expect(Array.from(cache.entries.keys())).toEqual([URL_]);
  });

  it("never fails a load over housekeeping", async () => {
    const cache = new FakeCache();
    vi.spyOn(cache, "keys").mockRejectedValue(new Error("storage gone"));
    stubCaches(cache);
    await expect(prunePinnedModelCache(OPTIONS.cacheName, [FILE])).resolves.toBeUndefined();

    vi.stubGlobal("caches", undefined);
    await expect(prunePinnedModelCache(OPTIONS.cacheName, [FILE])).resolves.toBeUndefined();
    await expect(deletePinnedModelCache(OPTIONS.cacheName)).resolves.toBeUndefined();
  });

  it("deletes the whole named cache", async () => {
    const storage = stubCaches(new FakeCache());
    storage.delete.mockRejectedValueOnce(new Error("blocked"));

    await expect(deletePinnedModelCache(OPTIONS.cacheName)).resolves.toBeUndefined();
    await deletePinnedModelCache(OPTIONS.cacheName);

    expect(storage.delete).toHaveBeenCalledWith(OPTIONS.cacheName);
    expect(storage.delete).toHaveBeenCalledTimes(2);
  });
});
