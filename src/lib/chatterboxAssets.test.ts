import { describe, expect, it, vi } from "vitest";
import {
  buildChatterboxAssetUrl,
  chatterboxGraphPath,
  createChatterboxAssetGuard,
  downloadVerifiedAsset,
  loadVerifiedAsset,
  resolveChatterboxAssetPath,
  selectChatterboxAssetFiles,
  type ChatterboxAssetCache,
  type ChatterboxDtype,
} from "./chatterboxAssets";
import type { PinnedAssetIntegrity } from "./pinnedModelFetch";

const MODEL = "Org/chatter-onnx";
const REVISION = "a".repeat(40);
const OTHER_REVISION = "b".repeat(40);

async function pin(text: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; integrity: PinnedAssetIntegrity }> {
  const bytes = new Uint8Array(new TextEncoder().encode(text));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const sha256 = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
  return { bytes, integrity: { byteLength: bytes.byteLength, sha256 } };
}

function bytesOf(data: ArrayBuffer | Uint8Array): number[] {
  return Array.from(data instanceof Uint8Array ? data : new Uint8Array(data));
}

function url(file: string, revision = REVISION): string {
  return buildChatterboxAssetUrl(MODEL, revision, file);
}

function memoryCache(): ChatterboxAssetCache & { store: Map<string, Response> } {
  const store = new Map<string, Response>();
  return {
    store,
    match: async (request) => store.get(String(request))?.clone(),
    put: async (request, response) => {
      store.set(String(request), response);
    },
    delete: async (request) => store.delete(String(request)),
  };
}

describe("chatterboxGraphPath and selectChatterboxAssetFiles", () => {
  const plan: ChatterboxDtype = {
    embed_tokens: "fp32",
    speech_encoder: "q4",
    language_model: "q4f16",
    conditional_decoder: "q8",
  };
  const integrity: PinnedAssetIntegrity = { byteLength: 1, sha256: "0".repeat(64) };

  it("names each graph with the Transformers.js suffix of its dtype", () => {
    expect(chatterboxGraphPath("embed_tokens", "fp32")).toBe("onnx/embed_tokens.onnx");
    expect(chatterboxGraphPath("speech_encoder", "q4")).toBe("onnx/speech_encoder_q4.onnx");
    expect(chatterboxGraphPath("language_model", "q4f16")).toBe("onnx/language_model_q4f16.onnx");
    expect(chatterboxGraphPath("conditional_decoder", "q8")).toBe("onnx/conditional_decoder_quantized.onnx");
    expect(chatterboxGraphPath("conditional_decoder", "fp16")).toBe("onnx/conditional_decoder_fp16.onnx");
  });

  it("keeps non-ONNX files and the graphs and weights the plan names", () => {
    const files = Object.fromEntries([
      "config.json",
      "onnx/embed_tokens.onnx",
      "onnx/embed_tokens.onnx_data",
      "onnx/embed_tokens_q4.onnx",
      "onnx/speech_encoder_q4.onnx",
      "onnx/speech_encoder_q4.onnx_data",
      "onnx/speech_encoder_q4f16.onnx_data",
      "onnx/language_model_q4f16.onnx",
      "onnx/conditional_decoder_quantized.onnx_data",
    ].map((file) => [file, integrity]));
    expect(Object.keys(selectChatterboxAssetFiles(files, plan)).sort()).toEqual([
      "config.json",
      "onnx/conditional_decoder_quantized.onnx_data",
      "onnx/embed_tokens.onnx",
      "onnx/embed_tokens.onnx_data",
      "onnx/language_model_q4f16.onnx",
      "onnx/speech_encoder_q4.onnx",
      "onnx/speech_encoder_q4.onnx_data",
    ]);
  });
});

describe("resolveChatterboxAssetPath", () => {
  it("extracts the revision and file from a Hugging Face resolve URL", () => {
    expect(resolveChatterboxAssetPath(`https://huggingface.co/${MODEL}/resolve/main/onnx/a_q4.onnx`, MODEL))
      .toEqual({ revision: "main", file: "onnx/a_q4.onnx" });
    expect(resolveChatterboxAssetPath(`https://hf.co/${MODEL}/resolve/${REVISION}/config.json`, MODEL))
      .toEqual({ revision: REVISION, file: "config.json" });
  });

  it.each([
    "not a url",
    `http://huggingface.co/${MODEL}/resolve/main/config.json`,
    `https://example.com/${MODEL}/resolve/main/config.json`,
    `https://huggingface.co/Other/model/resolve/main/config.json`,
    `https://huggingface.co/${MODEL}/resolve/main`,
    `https://huggingface.co/${MODEL}/resolve/main/`,
    `https://huggingface.co/${MODEL}/resolve//config.json`,
    `https://huggingface.co/${MODEL}/resolve/main/%E0%A4%A`,
  ])("rejects %s", (candidate) => {
    expect(resolveChatterboxAssetPath(candidate, MODEL)).toBeNull();
  });
});

describe("downloadVerifiedAsset", () => {
  it("streams a body that matches its pinned size and digest", async () => {
    const { bytes, integrity } = await pin("weights");
    const progress: number[] = [];
    const baseFetch = vi.fn(async () => new Response(bytes));
    const buffer = await downloadVerifiedAsset("https://x/f", "f", integrity, baseFetch, (loaded) => progress.push(loaded));
    expect(bytesOf(buffer)).toEqual(bytesOf(bytes));
    expect(progress.at(-1)).toBe(bytes.byteLength);
    expect(baseFetch).toHaveBeenCalledWith("https://x/f", { cache: "no-store" });
  });

  it("refuses non-OK responses, oversized, truncated and tampered bodies", async () => {
    const { bytes, integrity } = await pin("weights");
    const fetchOf = (response: Response) => vi.fn(async () => response);
    await expect(downloadVerifiedAsset("u", "f", integrity, fetchOf(new Response(null, { status: 404 }))))
      .rejects.toThrow(/HTTP 404/);
    await expect(downloadVerifiedAsset("u", "f", integrity, fetchOf(new Response(new Uint8Array(bytes.length + 1)))))
      .rejects.toThrow(/exceeded its pinned size/);
    await expect(downloadVerifiedAsset("u", "f", integrity, fetchOf(new Response(bytes.slice(0, 3)))))
      .rejects.toThrow(/truncated at 3/);
    await expect(downloadVerifiedAsset("u", "f", integrity, fetchOf(new Response(new Uint8Array(bytes.length)))))
      .rejects.toThrow(/failed integrity verification/);
  });

  it("verifies bodies the runtime exposes without a stream", async () => {
    const { bytes, integrity } = await pin("weights");
    const unstreamed = (body: Uint8Array) => ({
      ok: true,
      body: null,
      arrayBuffer: async () => body.slice().buffer,
    }) as unknown as Response;
    const progress = vi.fn();
    await expect(downloadVerifiedAsset("u", "f", integrity, async () => unstreamed(bytes), progress)).resolves.toBeDefined();
    expect(progress).toHaveBeenCalledWith(bytes.byteLength);
    await expect(downloadVerifiedAsset("u", "f", integrity, async () => unstreamed(bytes.slice(1))))
      .rejects.toThrow(/did not match its pinned size/);
  });
});

describe("loadVerifiedAsset", () => {
  it("downloads once, caches the verified bytes and then reads them back", async () => {
    const { bytes, integrity } = await pin("clip");
    const cache = memoryCache();
    const baseFetch = vi.fn(async () => new Response(bytes));
    const first = await loadVerifiedAsset("https://x/clip.wav", "clip.wav", integrity, baseFetch, cache);
    const progress = vi.fn();
    const second = await loadVerifiedAsset("https://x/clip.wav", "clip.wav", integrity, baseFetch, cache, progress);
    expect(bytesOf(first)).toEqual(bytesOf(bytes));
    expect(bytesOf(second)).toEqual(bytesOf(bytes));
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith(bytes.byteLength);
  });

  it("evicts a corrupt cache entry and downloads again", async () => {
    const { bytes, integrity } = await pin("clip");
    const cache = memoryCache();
    cache.store.set("https://x/clip.wav", new Response(new Uint8Array(bytes.length)));
    const baseFetch = vi.fn(async () => new Response(bytes));
    const buffer = await loadVerifiedAsset("https://x/clip.wav", "clip.wav", integrity, baseFetch, cache);
    expect(bytesOf(buffer)).toEqual(bytesOf(bytes));
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });

  it("works without a cache and survives a cache that cannot store", async () => {
    const { bytes, integrity } = await pin("clip");
    const baseFetch = vi.fn(async () => new Response(bytes));
    await expect(loadVerifiedAsset("u", "f", integrity, baseFetch, null)).resolves.toBeDefined();
    const failing: ChatterboxAssetCache = {
      match: async () => undefined,
      put: async () => {
        throw new Error("quota");
      },
    };
    await expect(loadVerifiedAsset("u", "f", integrity, baseFetch, failing)).resolves.toBeDefined();
  });
});

describe("createChatterboxAssetGuard", () => {
  async function setup(options: { cache?: ChatterboxAssetCache | null } = {}) {
    const weights = await pin("model weights");
    const config = await pin("{}");
    const files = { "onnx/a_q4.onnx_data": weights.integrity, "config.json": config.integrity };
    const bodies = new Map([[url("onnx/a_q4.onnx_data"), weights.bytes], [url("config.json"), config.bytes]]);
    const baseFetch = vi.fn(async (input: RequestInfo | URL) => {
      const body = bodies.get(String(input));
      return body ? new Response(body) : new Response(null, { status: 404 });
    });
    const onProgress = vi.fn();
    const onError = vi.fn();
    const cache = options.cache === undefined ? memoryCache() : options.cache;
    const guard = createChatterboxAssetGuard({
      modelId: MODEL,
      revision: REVISION,
      files,
      baseFetch: baseFetch as unknown as typeof fetch,
      cache,
      onProgress,
      onError,
    });
    return { guard, baseFetch, onProgress, onError, weights, config, cache };
  }

  it("rewrites any requested revision to the pinned one and verifies the download", async () => {
    const { guard, baseFetch, onProgress, weights } = await setup();
    const response = await guard.fetch(url("onnx/a_q4.onnx_data", "main"));
    expect(bytesOf(await response.arrayBuffer())).toEqual(bytesOf(weights.bytes));
    expect(baseFetch).toHaveBeenCalledWith(url("onnx/a_q4.onnx_data"), { cache: "no-store" });
    expect(onProgress).toHaveBeenCalledWith("onnx/a_q4.onnx_data", weights.bytes.byteLength);
  });

  it("answers files outside the manifest with 404 without touching the network", async () => {
    const { guard, baseFetch } = await setup();
    const response = await guard.fetch(url("onnx/other_q4.onnx"));
    expect(response.status).toBe(404);
    expect(baseFetch).not.toHaveBeenCalled();
  });

  it("refuses non-GET requests for pinned files", async () => {
    const { guard, baseFetch } = await setup();
    const response = await guard.fetch(url("config.json"), { method: "POST" });
    expect(response.status).toBe(404);
    expect(baseFetch).not.toHaveBeenCalled();
  });

  it("passes requests for other hosts straight through", async () => {
    const { guard, baseFetch } = await setup();
    await guard.fetch("https://example.com/thing");
    expect(baseFetch).toHaveBeenCalledWith("https://example.com/thing", undefined);
  });

  it("reports download and integrity failures to onError and rejects", async () => {
    const { guard, baseFetch, onError } = await setup();
    baseFetch.mockResolvedValueOnce(new Response(new Uint8Array(13)));
    await expect(guard.fetch(url("onnx/a_q4.onnx_data"))).rejects.toThrow(/failed integrity verification/);
    expect(onError).toHaveBeenCalledWith("onnx/a_q4.onnx_data", expect.any(Error));
  });

  it("serves a verified cache entry and evicts a corrupt one", async () => {
    const { guard, weights, cache } = await setup();
    const memory = cache as ReturnType<typeof memoryCache>;
    memory.store.set(url("onnx/a_q4.onnx_data"), new Response(weights.bytes));
    const hit = await guard.cache.match(url("onnx/a_q4.onnx_data", "main"));
    expect(bytesOf(await hit!.arrayBuffer())).toEqual(bytesOf(weights.bytes));

    memory.store.set(url("onnx/a_q4.onnx_data"), new Response(new Uint8Array(weights.bytes.length)));
    expect(await guard.cache.match(url("onnx/a_q4.onnx_data"))).toBeUndefined();
    expect(memory.store.has(url("onnx/a_q4.onnx_data"))).toBe(false);
  });

  it("never serves local repo cache keys and stores pinned files under the pinned URL", async () => {
    const { guard, cache, weights } = await setup();
    const memory = cache as ReturnType<typeof memoryCache>;
    expect(await guard.cache.match(`/models/${MODEL}/config.json`)).toBeUndefined();
    await guard.cache.put(`/models/${MODEL}/config.json`, new Response("{}"));
    expect(memory.store.size).toBe(0);

    await guard.cache.put(url("onnx/a_q4.onnx_data", OTHER_REVISION), new Response(weights.bytes));
    expect([...memory.store.keys()]).toEqual([url("onnx/a_q4.onnx_data")]);
    await guard.cache.put(url("onnx/unlisted.onnx"), new Response("x"));
    expect(memory.store.size).toBe(1);
  });

  it("forwards unrelated cache keys and deletes through to the store", async () => {
    const { guard, cache } = await setup();
    const memory = cache as ReturnType<typeof memoryCache>;
    memory.store.set("https://example.com/x", new Response("x"));
    expect(await (await guard.cache.match("https://example.com/x"))!.text()).toBe("x");
    expect(await guard.cache.delete!("https://example.com/x")).toBe(true);
  });

  it("degrades to downloads when no cache exists", async () => {
    const { guard } = await setup({ cache: null });
    expect(await guard.cache.match(url("config.json"))).toBeUndefined();
    await expect(guard.cache.put(url("config.json"), new Response("{}"))).resolves.toBeUndefined();
    expect(await guard.cache.delete!(url("config.json"))).toBe(false);
    expect(await guard.cache.match("https://example.com/x")).toBeUndefined();
    expect((await guard.fetch(url("config.json"))).status).toBe(200);
  });
});
