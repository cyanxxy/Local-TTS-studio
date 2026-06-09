import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerInMessage, WorkerOutMessage } from "../types";

interface MockKokoroInstance {
  voices?: Record<string, unknown>;
  list_voices: ReturnType<typeof vi.fn>;
  generate: ReturnType<typeof vi.fn>;
  dispose?: ReturnType<typeof vi.fn>;
}

interface LoadOptions {
  canUseWebGPU?: boolean;
  fallbackVoices?: string[];
  instances?: MockKokoroInstance[];
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
  canUseWebGPU = false,
  fallbackVoices = ["af_heart", "am_echo"],
  instances,
}: LoadOptions = {}) {
  vi.resetModules();
  const postedMessages: WorkerOutMessage[] = [];
  const workerGlobal = {
    postMessage: vi.fn((message: WorkerOutMessage) => {
      postedMessages.push(message);
    }),
    onmessage: null as ((event: MessageEvent<WorkerInMessage>) => void) | null,
  };
  vi.stubGlobal("self", workerGlobal);

  const queue = instances ?? [createInstance([createRawAudio()], { af_heart: {}, am_echo: {} })];
  const fromPretrained = vi.fn(async (_modelId: string, options: { progress_callback?: (info: unknown) => void }) => {
    options.progress_callback?.({ file: "model.onnx", status: "progress", loaded: 5, total: 10 });
    options.progress_callback?.({ file: "model.onnx", status: "done" });
    const next = queue.shift();
    if (!next) throw new Error("No Kokoro instance queued.");
    return next;
  });

  vi.doMock("kokoro-js", () => ({
    env: {},
    KokoroTTS: {
      from_pretrained: fromPretrained,
    },
  }));
  vi.doMock("../lib/onnxWasmAssets", () => ({
    KOKORO_ONNX_WASM_ASSETS: { mjs: "ort.mjs", wasm: "ort.wasm" },
  }));
  vi.doMock("../lib/onnxRuntime", () => ({
    configureKokoroOnnxRuntime: vi.fn(),
  }));
  vi.doMock("../constants", () => ({
    KOKORO_FALLBACK_VOICES: fallbackVoices,
    KOKORO_WEBGPU_MAX_INFERENCE_CHARS: 520,
    KOKORO_WASM_MAX_INFERENCE_CHARS: 280,
    MAX_CHUNK_LENGTH: 1000,
    SUPERTONIC_MIN_CHUNK_LENGTH: 100,
    MODELS: {
      kokoro: {
        defaultVoice: "af_heart",
      },
    },
    SPEED_MAX: 2,
    SPEED_MIN: 0.5,
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
    expect(postedMessages).toContainEqual({ type: "LOAD_PROGRESS", percent: 0 });
    expect(postedMessages).toContainEqual({ type: "LOAD_PROGRESS", percent: 50 });
    expect(postedMessages.at(-1)).toEqual({
      type: "READY",
      voices: ["af_heart", "af_bella"],
      backend: "wasm",
    });
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
    const { dispatch, postedMessages } = await loadWorkerModule({ instances: [instance] });

    dispatch({ type: "LOAD" });
    await vi.waitFor(() => expect(postedMessages.some((message) => message.type === "READY")).toBe(true));

    dispatch({ type: "GENERATE", text: "Only sentence.", voice: "af_heart", speed: 1, quality: 5 });
    dispatch({ type: "CANCEL" });
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
    expect(loaded.postedMessages.at(-1)).toEqual({
      type: "ERROR",
      message: "Model not loaded yet",
      scope: "generate",
    });

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
