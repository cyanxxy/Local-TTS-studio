// @vitest-environment node

import { createHash } from "node:crypto";
import type * as Ort from "onnxruntime-web";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EspeakPhonemize } from "../lib/espeakPhonemizer";
import type * as KittenVoices from "../lib/kittenVoices";
import { pinnedModelFileUrl, type PinnedModelFile } from "../lib/manifests/types";
import type { StyleTtsOutMessage } from "../lib/styleTtsRuntime";
import type { InferenceBackend, WorkerInMessage } from "../types";

function pinnedFile(content: string, repo: string, path: string): PinnedModelFile & { content: string } {
  const bytes = new TextEncoder().encode(content);
  return {
    repo,
    revision: "0123456789abcdef0123456789abcdef01234567",
    path,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    license: "apache-2.0",
    content,
  };
}

const FILES = {
  KITTEN_NANO_FP32_MODEL: pinnedFile("fp32 graph bytes", "test/kitten-fp32", "kitten.onnx"),
  KITTEN_NANO_INT8_MODEL: pinnedFile("int8 graph", "test/kitten-int8", "kitten.onnx"),
  KITTEN_VOICES_FILE: pinnedFile("voices archive", "test/kitten-fp32", "voices.npz"),
  KITTEN_CONFIG_FILE: pinnedFile("{\"config\":true}", "test/kitten-fp32", "config.json"),
};

/** Lower-cased letters are valid Kitten symbols, so this stands in for eSpeak. */
const phonemize: EspeakPhonemize = async (text) => [text.toLowerCase()];

interface SessionPlan {
  /** Per backend: what the warm-up and later runs produce. */
  waveform?: (frameCount: number) => Float32Array;
  createError?: Error;
}

interface Setup {
  webgpu?: boolean;
  plans?: Partial<Record<InferenceBackend, SessionPlan>>;
  /** Overrides the bytes served for a file URL. */
  serve?: Record<string, string>;
  caches?: unknown;
}

async function startWorker({ webgpu = false, plans = {}, serve = {}, caches }: Setup = {}) {
  vi.resetModules();
  const messages: StyleTtsOutMessage[] = [];
  const scope = {
    onmessage: null as ((event: MessageEvent<WorkerInMessage>) => void) | null,
    postMessage: vi.fn((message: StyleTtsOutMessage) => messages.push(message)),
    close: vi.fn(),
  };
  vi.stubGlobal("self", scope);
  vi.stubGlobal("caches", caches);
  const contentByUrl = new Map(Object.values(FILES).map((file) => [pinnedModelFileUrl(file), file.content]));
  const fetchMock = vi.fn(async (url: string) => new Response(serve[url] ?? contentByUrl.get(url) ?? "", { status: contentByUrl.has(url) ? 200 : 404 }));
  vi.stubGlobal("fetch", fetchMock);

  const sessions: Array<{ backend: InferenceBackend; model: string; run: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }> = [];
  const ortEnv = { wasm: {} as Record<string, unknown> };
  vi.doMock("onnxruntime-web", async (importOriginal) => {
    const actual = await importOriginal<typeof Ort>();
    const create = vi.fn(async (model: Uint8Array, options: Ort.InferenceSession.SessionOptions) => {
      const backend = options.executionProviders?.[0] as InferenceBackend;
      const plan = plans[backend] ?? {};
      if (plan.createError) throw plan.createError;
      const run = vi.fn(async (feeds: Record<string, Ort.Tensor>) => {
        const tokenCount = feeds.input_ids.dims[1];
        const durations = Array.from({ length: tokenCount }, () => 2);
        const samples = plan.waveform?.(tokenCount * 2) ?? new Float32Array(tokenCount * 2 * 600).fill(0.5);
        return {
          waveform: new actual.Tensor("float32", samples, [samples.length]),
          duration: new actual.Tensor("int64", BigInt64Array.from(durations, BigInt), [tokenCount]),
        };
      });
      const session = { backend, model: new TextDecoder().decode(model), run, release: vi.fn(async () => undefined) };
      sessions.push(session);
      return session;
    });
    return { ...actual, env: ortEnv, InferenceSession: { create } };
  });
  vi.doMock("virtual:phonemizer-assets", () => ({ PHONEMIZER_MODULE_URL: "/assets/phonemizer.js" }));
  const loadEspeakPhonemizer = vi.fn(async () => phonemize);
  vi.doMock("../lib/espeakPhonemizer", async (importOriginal) => ({
    ...await importOriginal<typeof import("../lib/espeakPhonemizer")>(),
    loadEspeakPhonemizer,
  }));
  vi.doMock("../lib/onnxWasmAssets", () => ({ TRANSFORMERS_ONNX_WASM_ASSETS: { asyncify: { mjs: "/ort.mjs", wasm: "/ort.wasm" } } }));
  vi.doMock("../lib/webgpu", () => ({ canInitializeWebGPU: async () => webgpu }));
  vi.doMock("../lib/manifests/kitten", () => FILES);
  // Real npz/config parsing has its own tests; here the worker only has to hand them the verified bytes.
  const parsed = { voices: [] as string[], config: [] as string[] };
  vi.doMock("../lib/kittenVoices", async (importOriginal) => {
    const actual = await importOriginal<typeof KittenVoices>();
    const data = new Float32Array(400 * 256);
    return {
      ...actual,
      parseKittenVoices: (buffer: ArrayBuffer) => {
        parsed.voices.push(new TextDecoder().decode(buffer));
        return new Map(actual.KITTEN_VOICES.map((voice) => [voice.styleKey, new actual.KittenStyleTable({ shape: [400, 256], data }, voice.styleKey)]));
      },
      parseKittenConfig: (buffer: ArrayBuffer) => {
        parsed.config.push(new TextDecoder().decode(buffer));
        return { speedPriors: {} };
      },
    };
  });

  await import("./kitten.worker");
  return {
    messages,
    scope,
    sessions,
    ortEnv,
    fetchMock,
    parsed,
    loadEspeakPhonemizer,
    send: (message: WorkerInMessage) => scope.onmessage?.({ data: message } as MessageEvent<WorkerInMessage>),
    ofType: <T extends StyleTtsOutMessage["type"]>(type: T) =>
      messages.filter((message) => message.type === type) as Array<Extract<StyleTtsOutMessage, { type: T }>>,
  };
}

type Worker = Awaited<ReturnType<typeof startWorker>>;

async function settledLoad(worker: Worker) {
  worker.send({ type: "LOAD" });
  await vi.waitFor(() => expect(worker.ofType("READY").length + worker.ofType("ERROR").length).toBe(1));
}

function fetchedUrls(worker: Worker): string[] {
  return worker.fetchMock.mock.calls.map(([url]) => url);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("kitten.worker", () => {
  it("loads the int8 graph on WASM with verified files, warms up and lists the eight voices", async () => {
    const worker = await startWorker();

    await settledLoad(worker);

    expect(worker.ofType("READY")).toEqual([{
      type: "READY",
      voices: ["Bella", "Jasper", "Luna", "Bruno", "Rosie", "Hugo", "Kiki", "Leo"],
      backend: "wasm",
    }]);
    expect(fetchedUrls(worker).sort()).toEqual([
      FILES.KITTEN_CONFIG_FILE,
      FILES.KITTEN_NANO_INT8_MODEL,
      FILES.KITTEN_VOICES_FILE,
    ].map(pinnedModelFileUrl).sort());
    expect(worker.parsed).toEqual({ voices: ["voices archive"], config: ["{\"config\":true}"] });
    expect(worker.loadEspeakPhonemizer).toHaveBeenCalledWith("/assets/phonemizer.js");
    expect(worker.sessions.map(({ backend, model }) => ({ backend, model }))).toEqual([{ backend: "wasm", model: "int8 graph" }]);
    // The warm-up proved the session before READY.
    expect(worker.sessions[0].run).toHaveBeenCalledOnce();
    expect(worker.ortEnv.wasm).toEqual({ wasmPaths: { mjs: "/ort.mjs", wasm: "/ort.wasm" }, numThreads: 1 });
    const percents = worker.ofType("LOAD_PROGRESS").map((message) => message.percent);
    expect(percents[0]).toBe(0);
    expect(percents.at(-1)).toBe(100);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
  });

  it("generates 24 kHz chunks with exact offsets and word timings", async () => {
    const worker = await startWorker();
    await settledLoad(worker);
    const text = "Hello there. How are you?";

    worker.send({ type: "GENERATE", generationId: "g1", text, voice: "Leo", speed: 1, quality: 5 });
    await vi.waitFor(() => expect(worker.ofType("GENERATION_COMPLETE")).toEqual([{ type: "GENERATION_COMPLETE", generationId: "g1" }]));

    const chunks = worker.ofType("AUDIO_CHUNK");
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.generationId).toBe("g1");
      expect(chunk.samplingRate).toBe(24_000);
      expect(text.slice(chunk.textStart, chunk.textEnd)).toBe(chunk.text);
      expect(chunk.audio.length).toBeGreaterThan(0);
    }
    const words = chunks.flatMap((chunk) => chunk.wordTimings ?? []).map((timing) => text.slice(timing.start, timing.end));
    expect(words).toEqual(["Hello", "there", "How", "are", "you"]);
  });

  it("runs the fp32 graph on WebGPU and plans longer chunks there", async () => {
    const worker = await startWorker({ webgpu: true });
    await settledLoad(worker);
    const text = Array.from({ length: 12 }, (_, index) => `Sentence ${index} is long enough to need planning.`).join(" ");

    worker.send({ type: "GENERATE", generationId: "g1", text, voice: "Bella", speed: 1, quality: 5 });
    await vi.waitFor(() => expect(worker.ofType("GENERATION_COMPLETE")).toHaveLength(1));

    expect(worker.ofType("READY")[0].backend).toBe("webgpu");
    expect(fetchedUrls(worker)).not.toContain(pinnedModelFileUrl(FILES.KITTEN_NANO_INT8_MODEL));
    expect(worker.sessions.map(({ backend, model }) => ({ backend, model }))).toEqual([{ backend: "webgpu", model: "fp32 graph bytes" }]);
    expect(Math.max(...worker.ofType("AUDIO_CHUNK").map((chunk) => chunk.text.length))).toBeGreaterThan(240);
  });

  it("falls back to WASM on the downloaded fp32 bytes when WebGPU warm-up yields NaN audio", async () => {
    const worker = await startWorker({
      webgpu: true,
      plans: { webgpu: { waveform: (frames) => new Float32Array(frames * 600).fill(Number.NaN) } },
    });

    await settledLoad(worker);

    expect(worker.ofType("READY")[0].backend).toBe("wasm");
    expect(worker.sessions.map(({ backend, model }) => ({ backend, model }))).toEqual([
      { backend: "webgpu", model: "fp32 graph bytes" },
      { backend: "wasm", model: "fp32 graph bytes" },
    ]);
    expect(worker.sessions[0].release).toHaveBeenCalledOnce();
    expect(worker.sessions[1].release).not.toHaveBeenCalled();
    expect(fetchedUrls(worker)).not.toContain(pinnedModelFileUrl(FILES.KITTEN_NANO_INT8_MODEL));
  });

  it("reports the last backend error when every backend fails", async () => {
    const worker = await startWorker({
      webgpu: true,
      plans: { webgpu: { createError: new Error("no adapter") }, wasm: { createError: new Error("out of memory") } },
    });

    await settledLoad(worker);

    expect(worker.ofType("ERROR")).toEqual([{ type: "ERROR", scope: "load", message: "out of memory" }]);
  });

  it("refuses files that fail digest verification before creating a session", async () => {
    const worker = await startWorker({ serve: { [pinnedModelFileUrl(FILES.KITTEN_VOICES_FILE)]: "voices ARCHIVE" } });

    await settledLoad(worker);

    expect(worker.ofType("ERROR")).toEqual([{
      type: "ERROR",
      scope: "load",
      message: "Kitten TTS voices.npz failed integrity verification.",
    }]);
    expect(worker.sessions).toHaveLength(0);
    expect(worker.parsed.voices).toHaveLength(0);
  });

  it("clears its cache on a forced reload", async () => {
    const storage = { open: vi.fn(async () => { throw new Error("blocked"); }), delete: vi.fn(async () => true) };
    const worker = await startWorker({ caches: storage });
    await settledLoad(worker);

    worker.send({ type: "LOAD", forceReload: true });
    await vi.waitFor(() => expect(worker.ofType("READY")).toHaveLength(2));

    expect(storage.delete).toHaveBeenCalledWith("transformers-cache-kitten-v1");
    expect(worker.sessions[0].release).toHaveBeenCalledOnce();
  });

  it("closes on CANCEL", async () => {
    const worker = await startWorker();
    await settledLoad(worker);

    worker.send({ type: "CANCEL" });

    expect(worker.ofType("CANCELLED")).toHaveLength(1);
    expect(worker.scope.close).toHaveBeenCalledOnce();
  });
});
