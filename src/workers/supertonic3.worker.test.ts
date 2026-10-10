import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TextChunk } from "../lib/chunking";
import type { WorkerInMessage, WorkerOutMessage } from "../types";

const REVISION = "3cadd1ee6394adea1bd021217a0e650ede09a323";
const VOICES = ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"];
const MODEL_NAMES = ["duration_predictor", "text_encoder", "vector_estimator", "vocoder"] as const;

// Small stand-ins for the pinned assets so streamed bodies stay tiny. A cold
// load downloads 1,000 bytes in total: the six model files plus voice M1.
const ASSET_SIZES: Record<string, number> = {
  "onnx/tts.json": 40,
  "onnx/unicode_indexer.json": 40,
  "onnx/duration_predictor.onnx": 100,
  "onnx/text_encoder.onnx": 100,
  "onnx/vector_estimator.onnx": 600,
  "onnx/vocoder.onnx": 100,
  ...Object.fromEntries(VOICES.map((voice) => [`voice_styles/${voice}.json`, 20])),
};

/** Pinned-size bytes; JSON assets hold a minimal document padded with spaces. */
function assetBytes(file: string, size = ASSET_SIZES[file]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size).fill(0x20);
  if (file.endsWith(".json")) bytes.set(new TextEncoder().encode(file.includes("indexer") ? "[]" : "{}"));
  return bytes;
}

function fakeManifest() {
  return {
    repo: "Supertone/supertonic-3",
    revision: REVISION,
    files: Object.fromEntries(Object.keys(ASSET_SIZES).map((file) => [file, {
      byteLength: ASSET_SIZES[file],
      sha256: createHash("sha256").update(assetBytes(file)).digest("hex"),
    }])),
  };
}

function assetUrl(file: string): string {
  return `https://huggingface.co/Supertone/supertonic-3/resolve/${REVISION}/${file}`;
}

function fileFromUrl(url: string): string {
  return url.slice(url.indexOf(`/resolve/${REVISION}/`) + `/resolve/${REVISION}/`.length);
}

/** A real streamed Response, the shape that broke cold loads when Content-Length was missing. */
function streamResponse(
  bytes: Uint8Array,
  { chunkSize = 64, headers = {}, onCancel }: { chunkSize?: number; headers?: Record<string, string>; onCancel?: () => void } = {},
): Response {
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
    cancel: onCancel,
  });
  return new Response(body, { status: 200, headers });
}

interface HarnessOptions {
  respond?: (file: string) => Response | Promise<Response>;
  cachedAssets?: Record<string, Uint8Array<ArrayBuffer>>;
  chunks?: TextChunk[];
}

async function loadSupertonic3Worker({ respond, cachedAssets = {}, chunks }: HarnessOptions = {}) {
  vi.resetModules();
  const messages: WorkerOutMessage[] = [];
  const worker = {
    close: vi.fn(),
    onmessage: null as ((event: MessageEvent<WorkerInMessage>) => void) | null,
    postMessage: vi.fn((message: WorkerOutMessage) => {
      messages.push(message);
    }),
  };
  vi.stubGlobal("self", worker);

  const cacheStore = new Map<string, Response>(
    Object.entries(cachedAssets).map(([file, bytes]) => [assetUrl(file), new Response(bytes)]),
  );
  const cache = {
    match: vi.fn(async (url: string) => cacheStore.get(url)?.clone()),
    put: vi.fn(async (url: string, response: Response) => {
      cacheStore.set(url, response);
    }),
    delete: vi.fn(async (url: string) => cacheStore.delete(url)),
  };
  vi.stubGlobal("caches", {
    open: vi.fn(async () => cache),
    delete: vi.fn(async () => {
      cacheStore.clear();
      return true;
    }),
  });
  const fetchMock = vi.fn(async (url: string) => (respond ?? ((file) => streamResponse(assetBytes(file))))(fileFromUrl(url)));
  vi.stubGlobal("fetch", fetchMock);

  const runtime = {
    sampleRate: 10,
    synthesize: vi.fn(async () => new Float32Array([0.5, 0.5])),
    dispose: vi.fn(async () => undefined),
  };
  const createRuntime = vi.fn(async (
    _config: unknown,
    _indexer: unknown,
    loadModel: (name: (typeof MODEL_NAMES)[number]) => Promise<ArrayBuffer>,
  ) => {
    for (const name of MODEL_NAMES) await loadModel(name);
    return runtime;
  });
  vi.doMock("./manifests/supertonic3", () => ({ SUPERTONIC3_ASSETS: fakeManifest() }));
  vi.doMock("../lib/webgpu", () => ({ canInitializeWebGPU: async () => false }));
  vi.doMock("../lib/supertonic3Runtime", () => ({
    createSupertonic3RuntimeStreaming: createRuntime,
    createSupertonic3Style: () => ({ ttl: { dispose() {} }, dp: { dispose() {} } }),
  }));
  vi.doMock("../lib/chunking", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../lib/chunking")>();
    return chunks ? { ...actual, chunkWithConstraintsDetailed: () => chunks } : actual;
  });

  await import("./supertonic3.worker");
  const dispatch = (data: WorkerInMessage) => worker.onmessage?.({ data } as MessageEvent<WorkerInMessage>);
  return { cache, cacheStore, createRuntime, dispatch, fetchMock, messages, runtime, worker };
}

function loadProgress(messages: WorkerOutMessage[]): number[] {
  return messages.flatMap((message) => (message.type === "LOAD_PROGRESS" ? [message.percent] : []));
}

async function waitForReady(messages: WorkerOutMessage[]): Promise<void> {
  await vi.waitFor(() => expect(messages.some((message) => message.type === "READY")).toBe(true));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("Supertonic 3 asset downloads", () => {
  it("streams compressed assets that have no Content-Length and caches the decoded bytes", async () => {
    // Hugging Face answers the small JSON assets with Content-Encoding and no
    // Content-Length; the worker used to size its buffer from the missing
    // header and fail the very first cold-load fetch.
    const { cacheStore, dispatch, messages } = await loadSupertonic3Worker({
      respond: (file) => streamResponse(assetBytes(file), {
        headers: { "content-encoding": "br", "content-type": "application/json" },
      }),
    });

    dispatch({ type: "LOAD" });
    await waitForReady(messages);

    expect(messages.some((message) => message.type === "ERROR")).toBe(false);
    const cachedConfig = cacheStore.get(assetUrl("onnx/tts.json"));
    expect(new Uint8Array(await cachedConfig!.arrayBuffer())).toEqual(assetBytes("onnx/tts.json"));
    expect(cachedConfig!.headers.get("content-length")).toBe("40");
    expect(cachedConfig!.headers.get("content-encoding")).toBeNull();
    expect(cachedConfig!.headers.get("content-type")).toBe("application/json");
    expect(cacheStore.has(assetUrl("onnx/vector_estimator.onnx"))).toBe(true);
  });

  it("ignores a Content-Length that counts encoded bytes", async () => {
    const { dispatch, messages } = await loadSupertonic3Worker({
      respond: (file) => streamResponse(assetBytes(file), {
        headers: { "content-encoding": "gzip", "content-length": "12" },
      }),
    });

    dispatch({ type: "LOAD" });
    await waitForReady(messages);
    expect(messages.some((message) => message.type === "ERROR")).toBe(false);
  });

  it("rejects and stops a body longer than its pinned size without caching it", async () => {
    const onCancel = vi.fn();
    const { cacheStore, dispatch, messages } = await loadSupertonic3Worker({
      // Far longer than the 40-byte pin, so the stream is still open when the
      // overflow is detected and must be cancelled rather than drained.
      respond: (file) => streamResponse(
        file === "onnx/tts.json" ? assetBytes(file, 4_000) : assetBytes(file),
        { chunkSize: 16, onCancel },
      ),
    });

    dispatch({ type: "LOAD" });
    await vi.waitFor(() => expect(messages.at(-1)).toEqual({
      type: "ERROR",
      scope: "load",
      message: "Supertonic 3 onnx/tts.json exceeded its pinned size.",
    }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(cacheStore.has(assetUrl("onnx/tts.json"))).toBe(false);
  });

  it("rejects a truncated body", async () => {
    const { dispatch, messages } = await loadSupertonic3Worker({
      respond: (file) => streamResponse(file === "onnx/tts.json" ? assetBytes(file, 30) : assetBytes(file)),
    });

    dispatch({ type: "LOAD" });
    await vi.waitFor(() => expect(messages.at(-1)).toEqual({
      type: "ERROR",
      scope: "load",
      message: "Supertonic 3 onnx/tts.json was truncated at 30 of 40 bytes.",
    }));
  });

  it("rejects pinned-size bytes that fail integrity verification", async () => {
    const { cacheStore, dispatch, messages } = await loadSupertonic3Worker({
      respond: (file) => streamResponse(file === "onnx/tts.json" ? assetBytes(file).fill(0x41) : assetBytes(file)),
    });

    dispatch({ type: "LOAD" });
    await vi.waitFor(() => expect(messages.at(-1)).toEqual({
      type: "ERROR",
      scope: "load",
      message: "Supertonic 3 onnx/tts.json failed integrity verification.",
    }));
    expect(cacheStore.has(assetUrl("onnx/tts.json"))).toBe(false);
  });

  it("reports byte-weighted progress that only moves forward", async () => {
    const { dispatch, messages } = await loadSupertonic3Worker({
      respond: (file) => streamResponse(assetBytes(file), { chunkSize: 20 }),
    });

    dispatch({ type: "LOAD" });
    await waitForReady(messages);

    const percents = loadProgress(messages);
    // Every 20-byte chunk of the 1,000-byte cold load is worth 1.88% of the
    // 94% download span, whichever file it belongs to.
    expect(percents[0]).toBe(0);
    expect(percents.at(-1)).toBe(100);
    expect(percents.at(-2)).toBe(94);
    const downloads = percents.slice(1, -1);
    expect(downloads).toHaveLength(50);
    downloads.forEach((percent, index) => expect(percent).toBeCloseTo((index + 1) * 1.88, 5));
  });

  it("loads verified assets from the cache and re-downloads one that fails verification", async () => {
    const cachedAssets = Object.fromEntries(Object.keys(ASSET_SIZES).map((file) => [file, assetBytes(file)]));
    cachedAssets["onnx/vocoder.onnx"] = assetBytes("onnx/vocoder.onnx").fill(0x42);
    const { cacheStore, dispatch, fetchMock, messages } = await loadSupertonic3Worker({ cachedAssets });

    dispatch({ type: "LOAD" });
    await waitForReady(messages);

    expect(fetchMock.mock.calls.map(([url]) => fileFromUrl(url))).toEqual(["onnx/vocoder.onnx"]);
    expect(new Uint8Array(await cacheStore.get(assetUrl("onnx/vocoder.onnx"))!.arrayBuffer()))
      .toEqual(assetBytes("onnx/vocoder.onnx"));
  });
});

describe("Supertonic 3 generation", () => {
  it("includes sentence and final pauses in emitted PCM", async () => {
    const { dispatch, messages } = await loadSupertonic3Worker({
      chunks: [
        { text: "One.", start: 0, end: 4, pauseKind: "sentence", pauseAfterSec: 0.2 },
        { text: "Two.", start: 5, end: 9, pauseKind: "none", pauseAfterSec: 0 },
      ],
    });

    dispatch({ type: "LOAD" });
    await waitForReady(messages);
    dispatch({ type: "GENERATE", text: "One. Two.", voice: "M1", speed: 1, quality: 5, pauseOverridesSec: { sentence: 0.3 }, finalPauseSec: 0.5 });
    await vi.waitFor(() => expect(messages.some((message) => message.type === "GENERATION_COMPLETE")).toBe(true));

    const chunks = messages.filter((message) => message.type === "AUDIO_CHUNK");
    expect(Array.from(chunks[0].audio)).toEqual([0.5, 0.5, 0, 0, 0]);
    expect(Array.from(chunks[1].audio)).toEqual([0.5, 0.5, 0, 0, 0, 0, 0]);
  });
});
