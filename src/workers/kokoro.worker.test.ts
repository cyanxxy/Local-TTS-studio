import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KOKORO_FIRST_UNIT_MAX_CHARS } from "../lib/chunking";
import type { WorkerInMessage, WorkerOutMessage } from "../types";

interface MockKokoroInstance {
  voices?: Record<string, unknown>;
  list_voices: ReturnType<typeof vi.fn>;
  generate: ReturnType<typeof vi.fn>;
  tokenizer?: ReturnType<typeof vi.fn>;
  generate_from_ids?: ReturnType<typeof vi.fn>;
  dispose?: ReturnType<typeof vi.fn>;
  model?: { dispose: ReturnType<typeof vi.fn> };
}

type KokoroPhonemize = (text: string, language?: string) => Promise<string>;

interface LoadOptions {
  baseFetch?: typeof fetch;
  canUseWebGPU?: boolean;
  fallbackVoices?: string[];
  instances?: MockKokoroInstance[];
  /** The phonemizer vite.kokoroAssets.ts exports from kokoro.web.js; absent by default. */
  phonemize?: KokoroPhonemize;
}

function createRawAudio(length: number = 2, samplingRate: number = 10) {
  return {
    audio: new Float32Array(length).fill(0.25),
    sampling_rate: samplingRate,
  };
}

function createInstance(responses: unknown[], voices?: Record<string, unknown>): MockKokoroInstance {
  return {
    voices,
    list_voices: vi.fn(() => ["af_heart", "am_echo"]),
    generate: vi.fn(async () => {
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next ?? createRawAudio();
    }),
  };
}

interface FromPretrainedOptions {
  dtype?: string;
  device?: string;
  progress_callback?: (info: unknown) => void;
}

// Pinned sizes from src/workers/manifests/kokoro.ts.
const FILE_SIZES: Record<string, number> = {
  "config.json": 44,
  "tokenizer.json": 3_497,
  "tokenizer_config.json": 113,
  "onnx/model.onnx": 325_532_232,
  "onnx/model_quantized.onnx": 92_361_116,
};

function modelFile(dtype: string | undefined): string {
  return dtype === "fp32" ? "onnx/model.onnx" : "onnx/model_quantized.onnx";
}

/** What Transformers.js 3 reports while kokoro-js downloads a model and its tokenizer. */
function downloadEvents(dtype: string | undefined): unknown[] {
  const model = modelFile(dtype);
  return [
    { status: "initiate", file: "config.json" },
    { status: "progress", file: "config.json", loaded: 44, total: 44 },
    { status: "done", file: "config.json" },
    { status: "initiate", file: model },
    { status: "progress", file: model, loaded: FILE_SIZES[model] / 2, total: FILE_SIZES[model] },
    { status: "done", file: model },
    { status: "initiate", file: "tokenizer.json" },
    { status: "done", file: "tokenizer.json" },
    { status: "initiate", file: "tokenizer_config.json" },
    { status: "done", file: "tokenizer_config.json" },
  ];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function loadWorkerModule({
  baseFetch,
  canUseWebGPU = false,
  fallbackVoices = ["af_heart", "am_echo"],
  instances,
  phonemize,
}: LoadOptions = {}) {
  vi.resetModules();
  const postedMessages: WorkerOutMessage[] = [];
  const workerGlobal = {
    close: vi.fn(),
    postMessage: vi.fn((message: WorkerOutMessage) => {
      postedMessages.push(message);
    }),
    onmessage: null as ((event: MessageEvent<WorkerInMessage>) => void) | null,
    ...(baseFetch ? { fetch: baseFetch } : {}),
  };
  vi.stubGlobal("self", workerGlobal);

  const queue = instances ?? [createInstance([createRawAudio()], { af_heart: {}, am_echo: {} })];
  const fromPretrained = vi.fn(async (_modelId: string, options: FromPretrainedOptions) => {
    for (const event of downloadEvents(options.dtype)) options.progress_callback?.(event);
    const next = queue.shift();
    if (!next) throw new Error("No Kokoro instance queued.");
    return next;
  });

  vi.doMock("kokoro-js", () => ({
    env: {},
    KokoroTTS: {
      from_pretrained: fromPretrained,
    },
    // Always defined: a mocked module throws on reading an export it lacks.
    phonemize,
  }));
  vi.doMock("../lib/onnxWasmAssets", () => ({
    KOKORO_ONNX_WASM_ASSETS: { mjs: "ort.mjs", wasm: "ort.wasm" },
    KOKORO_WEB_MODULE_URL: "kokoro-js",
  }));
  vi.doMock("../lib/onnxRuntime", () => ({
    configureKokoroOnnxRuntime: vi.fn(),
  }));
  vi.doMock("../constants", async (importOriginal) => ({
    ...await importOriginal<typeof import("../constants")>(),
    KOKORO_FALLBACK_VOICES: fallbackVoices,
  }));
  vi.doMock("../lib/webgpu", () => ({
    canInitializeWebGPU: vi.fn(async () => canUseWebGPU),
  }));

  await import("./kokoro.worker");

  function dispatch(message: WorkerInMessage): void {
    workerGlobal.onmessage?.({ data: message } as MessageEvent<WorkerInMessage>);
  }

  return {
    dispatch,
    fromPretrained,
    postedMessages,
    workerGlobal,
  };
}

describe("kokoro.worker", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to wasm, reports progress, and lists dynamic voices", async () => {
    const instance = createInstance([createRawAudio()], { af_heart: {}, af_bella: {} });
    const { dispatch, fromPretrained, postedMessages } = await loadWorkerModule({ instances: [instance] });

    dispatch({ type: "LOAD" });

    await vi.waitFor(() => expect(postedMessages.some((message) => message.type === "READY")).toBe(true));

    expect(fromPretrained).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      dtype: "q8",
      device: "wasm",
    }));
    // Byte-weighted over the pinned file sizes: the 44-byte config barely
    // registers, half of the 92 MB q8 model is half of the 94% download span,
    // and READY covers session creation.
    expect(postedMessages.filter((message) => message.type === "LOAD_PROGRESS")).toEqual([
      { type: "LOAD_PROGRESS", percent: 0 },
      { type: "LOAD_PROGRESS", percent: 47 },
      { type: "LOAD_PROGRESS", percent: 94 },
    ]);
    expect(postedMessages.at(-1)).toEqual({
      type: "READY",
      voices: ["af_heart", "af_bella"],
      backend: "wasm",
    });
  });

  it("pins kokoro-js's hard-coded /resolve/main/ downloads to the pinned revision", async () => {
    const baseFetch = vi.fn(async () => new Response("model bytes"));
    const { workerGlobal } = await loadWorkerModule({ baseFetch });
    const pinnedFetch = (workerGlobal as unknown as { fetch: typeof fetch }).fetch;

    await pinnedFetch("https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_quantized.onnx");

    expect(pinnedFetch).not.toBe(baseFetch);
    expect(baseFetch).toHaveBeenCalledExactlyOnceWith(
      "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/onnx/model_quantized.onnx",
      undefined,
    );
  });

  it("uses WebGPU with fp32 and falls back to configured static voices", async () => {
    const instance = createInstance([createRawAudio()]);
    instance.voices = {};
    instance.list_voices = vi.fn(() => undefined);
    const { dispatch, fromPretrained, postedMessages } = await loadWorkerModule({
      canUseWebGPU: true,
      fallbackVoices: ["fallback_a", "fallback_b"],
      instances: [instance],
    });

    dispatch({ type: "LOAD" });

    await vi.waitFor(() => expect(postedMessages.some((message) => message.type === "READY")).toBe(true));

    expect(fromPretrained).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      dtype: "fp32",
      device: "webgpu",
    }));
    expect(postedMessages.at(-1)).toEqual({
      type: "READY",
      voices: ["fallback_a", "fallback_b"],
      backend: "webgpu",
    });
  });

  it("warms WebGPU before reporting ready", async () => {
    const instance = createInstance([createRawAudio()], { af_heart: {}, am_echo: {} });
    const { dispatch, postedMessages } = await loadWorkerModule({
      canUseWebGPU: true,
      instances: [instance],
    });

    dispatch({ type: "LOAD" });

    await vi.waitFor(() => expect(postedMessages.some((message) => message.type === "READY")).toBe(true));
    expect(instance.generate).toHaveBeenCalledWith("Warm up.", expect.objectContaining({
      voice: "af_heart",
      speed: 1,
    }));
  });

  it("reuses a loaded model and reloads when forced", async () => {
    const first = createInstance([createRawAudio()]);
    first.dispose = vi.fn(async () => undefined);
    const second = createInstance([createRawAudio()]);
    const { dispatch, fromPretrained, postedMessages } = await loadWorkerModule({ instances: [first, second] });

    dispatch({ type: "LOAD" });
    await vi.waitFor(() => expect(postedMessages.filter((message) => message.type === "READY")).toHaveLength(1));

    dispatch({ type: "LOAD" });
    await vi.waitFor(() => expect(postedMessages.filter((message) => message.type === "READY")).toHaveLength(2));
    expect(fromPretrained).toHaveBeenCalledTimes(1);

    dispatch({ type: "LOAD", forceReload: true });
    await vi.waitFor(() => expect(postedMessages.filter((message) => message.type === "READY")).toHaveLength(3));
    expect(fromPretrained).toHaveBeenCalledTimes(2);
    expect(first.dispose).toHaveBeenCalledTimes(1);
  });

  it("merges short adjacent sentences into a single inference chunk", async () => {
    const instance = createInstance([createRawAudio()]);
    const { dispatch, postedMessages } = await loadWorkerModule({ instances: [instance] });

    dispatch({ type: "LOAD" });
    await vi.waitFor(() => expect(postedMessages.some((message) => message.type === "READY")).toBe(true));

    dispatch({
      type: "GENERATE",
      text: "First sentence. Second sentence.",
      voice: "af_heart",
      speed: 2,
      quality: 5,
      pauseOverridesSec: { sentence: 0.2 },
      sentenceSpeedVariance: 0.1,
      pronunciationRules: [{ from: "First", to: "1st" }],
      emphasisStrength: 0.5,
    });

    await vi.waitFor(() => expect(postedMessages.some((message) => message.type === "GENERATION_COMPLETE")).toBe(true));

    const chunks = postedMessages.filter((message): message is Extract<WorkerOutMessage, { type: "AUDIO_CHUNK" }> => (
      message.type === "AUDIO_CHUNK"
    ));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      index: 1,
      total: 1,
      text: "First sentence. Second sentence.",
      textStart: 0,
      textEnd: "First sentence. Second sentence.".length,
      pauseAfterSec: 0,
      pauseKind: "none",
    });
    expect(chunks[0].audio).toHaveLength(2);
    expect(instance.generate).toHaveBeenCalledWith("1st sentence. Second sentence.", expect.objectContaining({
      voice: "af_heart",
      speed: 1.15,
    }));
  });

  it("suppresses stale output after cancellation", async () => {
    const pending = deferred<ReturnType<typeof createRawAudio>>();
    const instance = createInstance([pending.promise]);
    const { dispatch, postedMessages, workerGlobal } = await loadWorkerModule({ instances: [instance] });

    dispatch({ type: "LOAD" });
    await vi.waitFor(() => expect(postedMessages.some((message) => message.type === "READY")).toBe(true));

    dispatch({ type: "GENERATE", text: "Only sentence.", voice: "af_heart", speed: 1, quality: 5 });
    dispatch({ type: "CANCEL" });
    expect(postedMessages).toContainEqual({ type: "CANCELLED" });
    expect(workerGlobal.close).toHaveBeenCalledOnce();
    pending.resolve(createRawAudio());
    await flushPromises();

    expect(postedMessages.some((message) => message.type === "AUDIO_CHUNK")).toBe(false);
    expect(postedMessages.some((message) => message.type === "GENERATION_COMPLETE")).toBe(false);
  });

  it("splits failed long chunks for retry and reports skipped segment failures", async () => {
    const longText = "This is a long sentence, with enough words to split cleanly after a failure and then continue.";
    const instance = createInstance([new Error("too long"), createRawAudio(), createRawAudio()]);
    const { dispatch, postedMessages } = await loadWorkerModule({ instances: [instance] });

    dispatch({ type: "LOAD" });
    await vi.waitFor(() => expect(postedMessages.some((message) => message.type === "READY")).toBe(true));
    dispatch({ type: "GENERATE", text: longText, voice: "missing", speed: 1, quality: 5 });

    await vi.waitFor(() => expect(postedMessages.some((message) => message.type === "GENERATION_COMPLETE")).toBe(true));
    expect(instance.generate).toHaveBeenCalledTimes(3);

    const failing = createInstance([new Error("still bad")]);
    const loaded = await loadWorkerModule({ instances: [failing] });
    loaded.dispatch({ type: "LOAD" });
    await vi.waitFor(() => expect(loaded.postedMessages.some((message) => message.type === "READY")).toBe(true));
    loaded.dispatch({ type: "GENERATE", text: "Short failure.", voice: "af_heart", speed: 1, quality: 5 });

    await vi.waitFor(() => expect(loaded.postedMessages.at(-1)).toMatchObject({
      type: "ERROR",
      message: expect.stringContaining("Generation completed with skipped segments"),
      scope: "generate",
    }));
  });

  it("splits a failing unit whose only punctuation is its final character", async () => {
    const text = "This failing sentence has plenty of internal whitespace but only one exclamation mark!";
    const instance = createInstance([new Error("too long"), createRawAudio(), createRawAudio()]);
    const { dispatch, postedMessages } = await loadWorkerModule({ instances: [instance] });

    dispatch({ type: "LOAD" });
    await vi.waitFor(() => expect(postedMessages.some((message) => message.type === "READY")).toBe(true));
    dispatch({ type: "GENERATE", text, voice: "af_heart", speed: 1, quality: 5 });

    await vi.waitFor(() => expect(postedMessages.some((message) => message.type === "GENERATION_COMPLETE")).toBe(true));
    expect(instance.generate).toHaveBeenCalledTimes(3);
    expect(postedMessages.filter((message) => message.type === "AUDIO_CHUNK")).toHaveLength(2);
    expect(postedMessages.some((message) => message.type === "ERROR")).toBe(false);
  });

  it("reports load and validation errors", async () => {
    const { dispatch, postedMessages } = await loadWorkerModule({ instances: [] });

    dispatch({ type: "LOAD" });
    await vi.waitFor(() => expect(postedMessages.at(-1)).toMatchObject({
      type: "ERROR",
      scope: "load",
    }));

    const noVoice = createInstance([createRawAudio()]);
    noVoice.voices = {};
    noVoice.list_voices = vi.fn(() => []);
    const loaded = await loadWorkerModule({ instances: [noVoice] });
    loaded.dispatch({ type: "GENERATE", text: "No model yet.", voice: "af_heart", speed: 1, quality: 5 });
    await vi.waitFor(() => expect(loaded.postedMessages.at(-1)).toEqual({
      type: "ERROR",
      message: "Model not loaded yet",
      scope: "generate",
    }));

    loaded.dispatch({ type: "LOAD" });
    await vi.waitFor(() => expect(loaded.postedMessages.some((message) => message.type === "READY")).toBe(true));
    loaded.dispatch({ type: "GENERATE", text: "   ", voice: "af_heart", speed: 1, quality: 5 });
    await vi.waitFor(() => expect(loaded.postedMessages.at(-1)).toEqual({
      type: "ERROR",
      message: "Input text is empty.",
      scope: "generate",
    }));
  });

  it("reports when no Kokoro voices are available", async () => {
    const noVoice = createInstance([createRawAudio()]);
    noVoice.voices = {};
    noVoice.list_voices = vi.fn(() => []);
    const { dispatch, postedMessages } = await loadWorkerModule({
      fallbackVoices: [],
      instances: [noVoice],
    });

    dispatch({ type: "LOAD" });
    await vi.waitFor(() => expect(postedMessages.some((message) => message.type === "READY")).toBe(true));

    dispatch({ type: "GENERATE", text: "Has text.", voice: "af_heart", speed: 1, quality: 5 });
    await vi.waitFor(() => expect(postedMessages.at(-1)).toEqual({
      type: "ERROR",
      message: "No Kokoro voices are available.",
      scope: "generate",
    }));
  });
});

describe("Kokoro load timeout cleanup", () => {
  it("disposes a GPU model that arrives after fallback has started", async () => {
    const late = deferred<MockKokoroInstance>();
    const gpu = createInstance([], { af_heart: {} });
    gpu.model = { dispose: vi.fn(async () => undefined) };
    const wasm = createInstance([], { af_heart: {} });
    wasm.dispose = vi.fn(async () => undefined);
    const { dispatch, fromPretrained, postedMessages } = await loadWorkerModule({ canUseWebGPU: true, instances: [wasm] });
    fromPretrained.mockImplementationOnce(() => late.promise);
    vi.useFakeTimers();
    try {
      dispatch({ type: "LOAD" });
      await vi.advanceTimersByTimeAsync(120_001);
      expect(postedMessages).toContainEqual(expect.objectContaining({ type: "READY", backend: "wasm" }));
      late.resolve(gpu);
      await vi.advanceTimersByTimeAsync(0);
      expect(gpu.model.dispose).toHaveBeenCalledOnce();
      expect(wasm.dispose).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe("Kokoro load watchdog", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps WebGPU for a slow download that keeps reporting progress", async () => {
    const gpu = createInstance([createRawAudio()], { af_heart: {} });
    const { dispatch, fromPretrained, postedMessages } = await loadWorkerModule({ canUseWebGPU: true, instances: [] });
    vi.useFakeTimers();
    fromPretrained.mockImplementationOnce(async (_modelId: string, options: FromPretrainedOptions) => {
      const total = FILE_SIZES["onnx/model.onnx"];
      // Ten minutes of progress every 30 s: far past any fixed deadline.
      for (let step = 1; step <= 20; step += 1) {
        await new Promise((resolve) => setTimeout(resolve, 30_000));
        options.progress_callback?.({ status: "progress", file: "onnx/model.onnx", loaded: (total * step) / 20, total });
      }
      return gpu;
    });

    dispatch({ type: "LOAD" });
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    await vi.waitFor(() => expect(postedMessages.at(-1)).toEqual({ type: "READY", voices: ["af_heart"], backend: "webgpu" }));
    expect(fromPretrained).toHaveBeenCalledOnce();
  });

  it("falls back to WASM when the WebGPU download stalls for a minute", async () => {
    const wasm = createInstance([], { af_heart: {} });
    const { dispatch, fromPretrained, postedMessages } = await loadWorkerModule({ canUseWebGPU: true, instances: [wasm] });
    vi.useFakeTimers();
    fromPretrained.mockImplementationOnce((_modelId: string, options: FromPretrainedOptions) => {
      options.progress_callback?.({ status: "progress", file: "onnx/model.onnx", loaded: 1_000, total: FILE_SIZES["onnx/model.onnx"] });
      return new Promise<MockKokoroInstance>(() => undefined);
    });

    dispatch({ type: "LOAD" });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(fromPretrained).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_001);
    await vi.waitFor(() => expect(postedMessages.at(-1)).toEqual({ type: "READY", voices: ["af_heart"], backend: "wasm" }));
    expect(fromPretrained).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ dtype: "q8", device: "wasm" }));
  });

  it("drops progress the abandoned WebGPU attempt reports after the WASM model is ready", async () => {
    const wasm = createInstance([], { af_heart: {} });
    const { dispatch, fromPretrained, postedMessages } = await loadWorkerModule({ canUseWebGPU: true, instances: [wasm] });
    vi.useFakeTimers();
    let abandonedProgress: ((info: unknown) => void) | undefined;
    fromPretrained.mockImplementationOnce((_modelId: string, options: FromPretrainedOptions) => {
      abandonedProgress = options.progress_callback;
      abandonedProgress?.({ status: "progress", file: "onnx/model.onnx", loaded: 1_000, total: FILE_SIZES["onnx/model.onnx"] });
      return new Promise<MockKokoroInstance>(() => undefined);
    });

    dispatch({ type: "LOAD" });
    await vi.advanceTimersByTimeAsync(60_001);
    await vi.waitFor(() => expect(postedMessages.at(-1)).toMatchObject({ type: "READY", backend: "wasm" }));
    const afterReady = postedMessages.length;

    // from_pretrained cannot be cancelled, so its download keeps reporting.
    abandonedProgress?.({ status: "progress", file: "onnx/model.onnx", loaded: FILE_SIZES["onnx/model.onnx"] / 2, total: FILE_SIZES["onnx/model.onnx"] });
    abandonedProgress?.({ status: "done", file: "onnx/model.onnx" });

    expect(postedMessages.slice(afterReady)).toEqual([]);
  });

  it("gives session creation two minutes once every download has finished", async () => {
    const wasm = createInstance([], { af_heart: {} });
    const { dispatch, fromPretrained, postedMessages } = await loadWorkerModule({ canUseWebGPU: true, instances: [wasm] });
    vi.useFakeTimers();
    fromPretrained.mockImplementationOnce((_modelId: string, options: FromPretrainedOptions) => {
      for (const event of downloadEvents("fp32")) options.progress_callback?.(event);
      return new Promise<MockKokoroInstance>(() => undefined);
    });

    dispatch({ type: "LOAD" });
    // Well past the inactivity budget, but nothing is left to download.
    await vi.advanceTimersByTimeAsync(119_000);
    expect(fromPretrained).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_001);
    await vi.waitFor(() => expect(postedMessages.at(-1)).toEqual({ type: "READY", voices: ["af_heart"], backend: "wasm" }));
  });
});

describe("Kokoro soft abort", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stops after the in-flight unit and keeps the model loaded for the next generation", async () => {
    const pending = deferred<ReturnType<typeof createRawAudio>>();
    const instance = createInstance([pending.promise], { af_heart: {} });
    const { dispatch, fromPretrained, postedMessages, workerGlobal } = await loadWorkerModule({ instances: [instance] });
    dispatch({ type: "LOAD" });
    await vi.waitFor(() => expect(postedMessages.some((message) => message.type === "READY")).toBe(true));
    const afterLoad = postedMessages.length;

    // Units never cross a line break, so this is two units.
    dispatch({ type: "GENERATE", generationId: "a", text: "First line.\nSecond line.", voice: "af_heart", speed: 1, quality: 5 });
    await vi.waitFor(() => expect(instance.generate).toHaveBeenCalledOnce());
    dispatch({ type: "ABORT", generationId: "a" });
    dispatch({ type: "GENERATE", generationId: "b", text: "Only line.", voice: "af_heart", speed: 1, quality: 5 });
    await flushPromises();
    // "b" waits for the aborted inference instead of running beside it.
    expect(instance.generate).toHaveBeenCalledOnce();

    pending.resolve(createRawAudio());
    await vi.waitFor(() => expect(postedMessages.at(-1)).toEqual({ type: "GENERATION_COMPLETE", generationId: "b" }));

    expect(postedMessages.slice(afterLoad).map((message) => [message.type, "generationId" in message ? message.generationId : undefined]))
      .toEqual([["ABORTED", "a"], ["AUDIO_CHUNK", "b"], ["GENERATION_COMPLETE", "b"]]);
    expect(instance.generate).toHaveBeenCalledTimes(2);
    expect(fromPretrained).toHaveBeenCalledOnce();
    expect(workerGlobal.close).not.toHaveBeenCalled();
  });

  it("waits for the running inference before a forced reload disposes the model", async () => {
    const pending = deferred<ReturnType<typeof createRawAudio>>();
    const first = createInstance([pending.promise]);
    first.dispose = vi.fn(async () => undefined);
    const second = createInstance([]);
    const { dispatch, postedMessages } = await loadWorkerModule({ instances: [first, second] });
    dispatch({ type: "LOAD" });
    await vi.waitFor(() => expect(postedMessages.some((message) => message.type === "READY")).toBe(true));

    dispatch({ type: "GENERATE", generationId: "a", text: "Only sentence.", voice: "af_heart", speed: 1, quality: 5 });
    await vi.waitFor(() => expect(first.generate).toHaveBeenCalledOnce());
    dispatch({ type: "LOAD", forceReload: true });
    await flushPromises();
    expect(first.dispose).not.toHaveBeenCalled();

    pending.resolve(createRawAudio());
    await vi.waitFor(() => expect(postedMessages.filter((message) => message.type === "READY")).toHaveLength(2));
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(postedMessages.some((message) => message.type === "AUDIO_CHUNK")).toBe(false);
  });
});

describe("Kokoro first unit", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("caps the first unit so the first audio arrives sooner, with exact text offsets", async () => {
    const text = Array.from({ length: 12 }, (_, index) => `Sentence ${index} keeps the long story going on.`).join(" ");
    const instance = createInstance([], { af_heart: {} });
    const { dispatch, postedMessages } = await loadWorkerModule({ instances: [instance] });
    dispatch({ type: "LOAD" });
    await vi.waitFor(() => expect(postedMessages.some((message) => message.type === "READY")).toBe(true));

    dispatch({ type: "GENERATE", text, voice: "af_heart", speed: 1, quality: 5 });
    await vi.waitFor(() => expect(postedMessages.some((message) => message.type === "GENERATION_COMPLETE")).toBe(true));

    const chunks = postedMessages.filter((message): message is Extract<WorkerOutMessage, { type: "AUDIO_CHUNK" }> => (
      message.type === "AUDIO_CHUNK"
    ));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].textEnd! - chunks[0].textStart!).toBeLessThanOrEqual(KOKORO_FIRST_UNIT_MAX_CHARS);
    expect(chunks[1].textEnd! - chunks[1].textStart!).toBeGreaterThan(KOKORO_FIRST_UNIT_MAX_CHARS);
    for (const chunk of chunks) expect(text.slice(chunk.textStart, chunk.textEnd)).toBe(chunk.text);
  });
});

describe("Kokoro context budget", () => {
  // One 135-character sentence: no sentence or line break to merge across.
  const SENTENCE = "The keeper climbed the spiral stairs every evening, counting each worn step, and at the top he lit the lamp that guided the ships home.";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A tokenizer whose phonemes cost `idsPerChar` ids per character, plus the start and end tokens. */
  function createBudgetedInstance(idsPerChar: number): MockKokoroInstance {
    const instance = createInstance([], { af_heart: {}, bf_emma: {} });
    instance.tokenizer = vi.fn((phonemes: string) => ({ input_ids: { dims: [1, phonemes.length * idsPerChar + 2] } }));
    instance.generate_from_ids = vi.fn(async () => createRawAudio(3));
    return instance;
  }

  async function generateWith(instance: MockKokoroInstance, voice: string, phonemize = vi.fn<KokoroPhonemize>(async (text) => text)) {
    const loaded = await loadWorkerModule({ instances: [instance], phonemize });
    loaded.dispatch({ type: "LOAD" });
    await vi.waitFor(() => expect(loaded.postedMessages.some((message) => message.type === "READY")).toBe(true));
    loaded.dispatch({ type: "GENERATE", generationId: "g", text: SENTENCE, voice, speed: 1, quality: 5 });
    return { ...loaded, phonemize };
  }

  function audioChunks(messages: WorkerOutMessage[]) {
    return messages.filter((message): message is Extract<WorkerOutMessage, { type: "AUDIO_CHUNK" }> => (
      message.type === "AUDIO_CHUNK"
    ));
  }

  it("generates a unit that fits from its untruncated ids, phonemized for the voice's language", async () => {
    const instance = createBudgetedInstance(3);
    const { phonemize, postedMessages } = await generateWith(instance, "bf_emma");

    await vi.waitFor(() => expect(postedMessages.at(-1)).toEqual({ type: "GENERATION_COMPLETE", generationId: "g" }));
    expect(phonemize).toHaveBeenCalledExactlyOnceWith(SENTENCE, "b");
    expect(instance.tokenizer).toHaveBeenCalledExactlyOnceWith(SENTENCE, { truncation: false });
    expect(instance.generate_from_ids).toHaveBeenCalledExactlyOnceWith(
      { dims: [1, SENTENCE.length * 3 + 2] },
      { voice: "bf_emma", speed: 1 },
    );
    expect(instance.generate).not.toHaveBeenCalled();
  });

  it.each([
    {
      idsPerChar: 4,
      parts: [
        "The keeper climbed the spiral stairs every evening, counting each worn step,",
        "and at the top he lit the lamp that guided the ships home.",
      ],
    },
    {
      idsPerChar: 8,
      parts: [
        "The keeper climbed the spiral stairs every evening,",
        "counting each worn step,",
        "and at the top he lit the lamp that guided the ships home.",
      ],
    },
  ])("splits a unit needing $idsPerChar ids per character at clause breaks and posts one chunk", async ({ idsPerChar, parts }) => {
    const instance = createBudgetedInstance(idsPerChar);
    const { phonemize, postedMessages } = await generateWith(instance, "af_heart");

    await vi.waitFor(() => expect(postedMessages.at(-1)).toEqual({ type: "GENERATION_COMPLETE", generationId: "g" }));
    expect(instance.generate).not.toHaveBeenCalled();
    expect(instance.generate_from_ids).toHaveBeenCalledTimes(parts.length);
    for (const [inputIds] of instance.generate_from_ids!.mock.calls) {
      expect((inputIds as { dims: number[] }).dims[1]).toBeLessThanOrEqual(512);
    }
    // Only the parts that fit reach the model, in order.
    const synthesized = phonemize.mock.calls
      .map(([text]) => text)
      .filter((text) => text.length * idsPerChar + 2 <= 512);
    expect(synthesized).toEqual(parts);
    expect(phonemize.mock.calls.every(([, language]) => language === "a")).toBe(true);

    const chunks = audioChunks(postedMessages);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ index: 1, total: 1, text: SENTENCE, textStart: 0, textEnd: SENTENCE.length });
    expect(chunks[0].audio).toHaveLength(3 * parts.length);
  });

  it("truncates like kokoro-js when an overflowing unit is too short to split", async () => {
    const instance = createInstance([createRawAudio(3)], { af_heart: {} });
    instance.tokenizer = vi.fn(() => ({ input_ids: { dims: [1, 600] } }));
    instance.generate_from_ids = vi.fn(async () => createRawAudio(3));
    const loaded = await loadWorkerModule({ instances: [instance], phonemize: vi.fn<KokoroPhonemize>(async (text) => text) });
    loaded.dispatch({ type: "LOAD" });
    await vi.waitFor(() => expect(loaded.postedMessages.some((message) => message.type === "READY")).toBe(true));

    loaded.dispatch({ type: "GENERATE", generationId: "g", text: "7", voice: "af_heart", speed: 1, quality: 5 });

    await vi.waitFor(() => expect(loaded.postedMessages.at(-1)).toEqual({ type: "GENERATION_COMPLETE", generationId: "g" }));
    expect(instance.generate).toHaveBeenCalledExactlyOnceWith("7", { voice: "af_heart", speed: 1 });
    expect(instance.generate_from_ids).not.toHaveBeenCalled();
  });

  it("stops before synthesizing when the generation is aborted while phonemizing", async () => {
    const pending = deferred<string>();
    const instance = createBudgetedInstance(3);
    const { dispatch, postedMessages } = await generateWith(instance, "af_heart", vi.fn<KokoroPhonemize>(() => pending.promise));

    dispatch({ type: "ABORT", generationId: "g" });
    pending.resolve(SENTENCE);
    await vi.waitFor(() => expect(postedMessages.at(-1)).toEqual({ type: "ABORTED", generationId: "g" }));
    expect(instance.tokenizer).not.toHaveBeenCalled();
    expect(instance.generate_from_ids).not.toHaveBeenCalled();
    expect(audioChunks(postedMessages)).toHaveLength(0);
  });
});
