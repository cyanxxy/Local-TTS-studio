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

type Synthesize = (text: string, ...rest: unknown[]) => Promise<Float32Array>;

interface HarnessOptions {
  respond?: (file: string) => Response | Promise<Response>;
  cachedAssets?: Record<string, Uint8Array<ArrayBuffer>>;
  chunks?: TextChunk[];
  synthesize?: Synthesize;
  canUseWebGPU?: boolean;
  /** Makes WebGPU fail while its sessions are created or during the warm-up run. */
  webgpuFailure?: "create" | "warm-up";
  /** Stands in for ONNX session creation, after each model file was loaded. */
  createSession?: (name: (typeof MODEL_NAMES)[number]) => Promise<void>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function loadSupertonic3Worker({
  respond,
  cachedAssets = {},
  chunks,
  synthesize,
  canUseWebGPU = false,
  webgpuFailure,
  createSession,
}: HarnessOptions = {}) {
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

  const createFakeRuntime = (run: Synthesize) => ({
    sampleRate: 10,
    synthesize: vi.fn<Synthesize>(run),
    dispose: vi.fn(async () => undefined),
  });
  const defaultSynthesize: Synthesize = synthesize ?? (async () => new Float32Array([0.5, 0.5]));
  const runtimes = {
    webgpu: createFakeRuntime(webgpuFailure === "warm-up"
      ? async () => {
        throw new Error("WebGPU shader compilation failed.");
      }
      : defaultSynthesize),
    wasm: createFakeRuntime(defaultSynthesize),
  };
  const createRuntime = vi.fn(async (
    _config: unknown,
    _indexer: unknown,
    loadModel: (name: (typeof MODEL_NAMES)[number]) => Promise<ArrayBuffer>,
    backend: "webgpu" | "wasm",
  ) => {
    for (const name of MODEL_NAMES) {
      await loadModel(name);
      await createSession?.(name);
    }
    if (backend === "webgpu" && webgpuFailure === "create") throw new Error("WebGPU session creation failed.");
    return runtimes[backend];
  });
  vi.doMock("./manifests/supertonic3", () => ({ SUPERTONIC3_ASSETS: fakeManifest() }));
  vi.doMock("../lib/webgpu", () => ({ canInitializeWebGPU: async () => canUseWebGPU }));
  vi.doMock("../lib/supertonic3Runtime", async (importOriginal) => ({
    ...await importOriginal<typeof import("../lib/supertonic3Runtime")>(),
    createSupertonic3RuntimeStreaming: createRuntime,
    createSupertonic3Style: () => ({ ttl: { dispose() {} }, dp: { dispose() {} } }),
  }));
  vi.doMock("../lib/chunking", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../lib/chunking")>();
    return chunks ? { ...actual, chunkWithConstraintsDetailed: () => chunks } : actual;
  });

  await import("./supertonic3.worker");
  const dispatch = (data: WorkerInMessage) => worker.onmessage?.({ data } as MessageEvent<WorkerInMessage>);
  return { cache, cacheStore, createRuntime, dispatch, fetchMock, messages, runtime: runtimes.wasm, runtimes, worker };
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

describe("Supertonic 3 generation scheduling", () => {
  it("runs one inference at a time when a GENERATE arrives mid-generation", async () => {
    const gate = deferred<Float32Array>();
    let active = 0;
    let maxActive = 0;
    const { dispatch, messages, runtime } = await loadSupertonic3Worker({
      synthesize: async (text) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          return text.startsWith("Slow") ? await gate.promise : new Float32Array([0.25]);
        } finally {
          active -= 1;
        }
      },
    });
    dispatch({ type: "LOAD" });
    await waitForReady(messages);

    dispatch({ type: "GENERATE", generationId: "a", text: "Slow sentence that holds the model.", voice: "M1", speed: 1, quality: 5 });
    await vi.waitFor(() => expect(runtime.synthesize).toHaveBeenCalledOnce());
    dispatch({ type: "GENERATE", generationId: "b", text: "Fast sentence that runs afterwards.", voice: "M1", speed: 1, quality: 5 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.synthesize).toHaveBeenCalledOnce();

    gate.resolve(new Float32Array([0.75]));
    await vi.waitFor(() => expect(messages.at(-1)).toEqual({ type: "GENERATION_COMPLETE", generationId: "b" }));

    expect(maxActive).toBe(1);
    const generationMessages = messages.filter((message) => "generationId" in message);
    expect(generationMessages.map((message) => [message.type, "generationId" in message && message.generationId]))
      .toEqual([["AUDIO_CHUNK", "b"], ["GENERATION_COMPLETE", "b"]]);
  });

  it("waits for the running generation before a forced reload releases its sessions", async () => {
    const gate = deferred<Float32Array>();
    const { dispatch, messages, runtime } = await loadSupertonic3Worker({ synthesize: () => gate.promise });
    dispatch({ type: "LOAD" });
    await waitForReady(messages);

    dispatch({ type: "GENERATE", generationId: "a", text: "A sentence that is still running.", voice: "M1", speed: 1, quality: 5 });
    await vi.waitFor(() => expect(runtime.synthesize).toHaveBeenCalledOnce());
    dispatch({ type: "LOAD", forceReload: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.dispose).not.toHaveBeenCalled();

    gate.resolve(new Float32Array([0.5]));
    await vi.waitFor(() => expect(messages.filter((message) => message.type === "READY")).toHaveLength(2));
    expect(runtime.dispose).toHaveBeenCalledOnce();
    expect(messages.some((message) => message.type === "AUDIO_CHUNK")).toBe(false);
  });

  it("reports a generation before the model loads as a generate error with its id", async () => {
    const { dispatch, messages } = await loadSupertonic3Worker();

    dispatch({ type: "GENERATE", generationId: "early", text: "Too early to speak.", voice: "M1", speed: 1, quality: 5 });

    await vi.waitFor(() => expect(messages.at(-1)).toEqual({
      type: "ERROR",
      scope: "generate",
      generationId: "early",
      message: "Supertonic 3 is not loaded.",
    }));
  });
});

describe("Supertonic 3 backend selection", () => {
  it("warms WebGPU up with a one-step synthesis before reporting READY", async () => {
    const { dispatch, messages, runtimes } = await loadSupertonic3Worker({ canUseWebGPU: true });

    dispatch({ type: "LOAD" });
    await waitForReady(messages);

    expect(messages.at(-1)).toEqual({ type: "READY", voices: VOICES, backend: "webgpu" });
    expect(runtimes.webgpu.synthesize).toHaveBeenCalledExactlyOnceWith("Hello.", "en", expect.anything(), 1, 1);
  });

  it("falls back to WASM when the WebGPU warm-up fails, re-reading models from the cache", async () => {
    const { createRuntime, dispatch, fetchMock, messages, runtimes } = await loadSupertonic3Worker({
      canUseWebGPU: true,
      webgpuFailure: "warm-up",
    });

    dispatch({ type: "LOAD" });
    await waitForReady(messages);

    expect(messages.at(-1)).toEqual({ type: "READY", voices: VOICES, backend: "wasm" });
    expect(createRuntime.mock.calls.map((call) => call[3])).toEqual(["webgpu", "wasm"]);
    expect(runtimes.webgpu.dispose).toHaveBeenCalledOnce();
    expect(runtimes.wasm.synthesize).not.toHaveBeenCalled();
    // Each asset was downloaded once; the WASM attempt verified cached copies.
    expect(fetchMock).toHaveBeenCalledTimes(7);
    const percents = loadProgress(messages);
    expect(percents.filter((percent) => percent === 0)).toHaveLength(2);
    expect(messages.some((message) => message.type === "ERROR")).toBe(false);
  });

  it("falls back to WASM when WebGPU sessions cannot be created", async () => {
    const { dispatch, messages } = await loadSupertonic3Worker({ canUseWebGPU: true, webgpuFailure: "create" });

    dispatch({ type: "LOAD" });
    await waitForReady(messages);

    expect(messages.at(-1)).toEqual({ type: "READY", voices: VOICES, backend: "wasm" });
  });

  it("reports a failed download instead of downloading again for WASM", async () => {
    const { createRuntime, dispatch, fetchMock, messages } = await loadSupertonic3Worker({
      canUseWebGPU: true,
      respond: (file) => (file === "onnx/vocoder.onnx" ? new Response(null, { status: 404 }) : streamResponse(assetBytes(file))),
    });

    dispatch({ type: "LOAD" });
    await vi.waitFor(() => expect(messages.at(-1)).toEqual({
      type: "ERROR",
      scope: "load",
      message: "Failed to download onnx/vocoder.onnx: HTTP 404.",
    }));
    expect(createRuntime).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.filter(([url]) => fileFromUrl(url) === "onnx/vocoder.onnx")).toHaveLength(1);
  });
});

describe("Supertonic 3 seeds", () => {
  const sample = (random: (() => number) | undefined) => Array.from({ length: 4 }, () => random!());
  const noiseSource = (call: unknown[]) => (call[5] as { random?: () => number }).random;

  async function generateWith(dispatch: (message: WorkerInMessage) => void, messages: WorkerOutMessage[], id: string, extra: Partial<WorkerInMessage>) {
    dispatch({ type: "GENERATE", generationId: id, text: "A repeatable sentence for seeds.", voice: "M1", speed: 1, quality: 5, ...extra } as WorkerInMessage);
    await vi.waitFor(() => expect(messages.some((message) => message.type === "GENERATION_COMPLETE" && message.generationId === id)).toBe(true));
  }

  it("passes noise that repeats for the same text and seed and differs for another seed", async () => {
    const { dispatch, messages, runtime } = await loadSupertonic3Worker();
    dispatch({ type: "LOAD" });
    await waitForReady(messages);

    await generateWith(dispatch, messages, "a", { seed: 7 });
    await generateWith(dispatch, messages, "b", { seed: 7 });
    await generateWith(dispatch, messages, "c", { seed: 8 });
    await generateWith(dispatch, messages, "d", {});

    const [first, repeat, otherSeed, unseeded] = runtime.synthesize.mock.calls.map(noiseSource);
    expect(sample(repeat)).toEqual(sample(first));
    expect(sample(otherSeed)).not.toEqual(sample(first));
    expect(unseeded).toBeUndefined();
  });

  it.each([1.5, -1, 2 ** 32, Number.NaN])("rejects the invalid seed %s", async (seed) => {
    const { dispatch, messages, runtime } = await loadSupertonic3Worker();
    dispatch({ type: "LOAD" });
    await waitForReady(messages);

    dispatch({ type: "GENERATE", generationId: "bad", text: "Seeded sentence.", voice: "M1", speed: 1, quality: 5, seed });
    await vi.waitFor(() => expect(messages.at(-1)).toEqual({
      type: "ERROR",
      scope: "generate",
      generationId: "bad",
      message: "Supertonic 3 seed must be an integer from 0 to 4294967295.",
    }));
    expect(runtime.synthesize).not.toHaveBeenCalled();
  });
});

describe("Supertonic 3 asset prefetch", () => {
  it("downloads the next model file while the previous session is created", async () => {
    const sessions = new Map(MODEL_NAMES.map((name) => [name, deferred<void>()]));
    const { dispatch, fetchMock, messages } = await loadSupertonic3Worker({
      createSession: (name) => sessions.get(name)!.promise,
    });
    const fetched = () => fetchMock.mock.calls.map(([url]) => fileFromUrl(url));

    dispatch({ type: "LOAD" });
    // The small JSON assets, the default voice, and the first model start together.
    await vi.waitFor(() => expect(fetched()).toContain("onnx/text_encoder.onnx"));
    expect(fetched().slice(0, 4)).toEqual(expect.arrayContaining([
      "onnx/tts.json",
      "onnx/unicode_indexer.json",
      "voice_styles/M1.json",
      "onnx/duration_predictor.onnx",
    ]));
    // One file ahead at most: the vector estimator waits for the next session.
    expect(fetched()).not.toContain("onnx/vector_estimator.onnx");

    sessions.get("duration_predictor")!.resolve();
    await vi.waitFor(() => expect(fetched()).toContain("onnx/vector_estimator.onnx"));
    expect(fetched()).not.toContain("onnx/vocoder.onnx");

    for (const name of MODEL_NAMES) sessions.get(name)!.resolve();
    await waitForReady(messages);
    expect(fetched()).toHaveLength(7);
  });
});
