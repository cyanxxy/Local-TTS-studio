import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerInMessage, WorkerOutMessage } from "../types";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

interface MockTensorLike {
  dims: number[];
}

interface MockPipelineInstance extends ReturnType<typeof vi.fn> {
  dispose: ReturnType<typeof vi.fn>;
  model: { config: { style_dim: number } };
}

interface LoadWorkerModuleOptions {
  allowRemoteModels?: boolean;
  chunkTexts?: string[];
  fetchMode?: "valid" | "invalid";
  pipelineInstances?: MockPipelineInstance[];
  rechunkTexts?: string[];
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

function createRawAudio(length: number = 8, samplingRate: number = 44_100) {
  return {
    audio: new Float32Array(length).fill(0.2),
    sampling_rate: samplingRate,
  };
}

function createPipelineInstance(
  responses: Array<unknown>,
  calls: Array<{ text: string | string[]; options: Record<string, unknown> }>,
): MockPipelineInstance {
  const instance = vi.fn(async (text: string | string[], options: Record<string, unknown>) => {
    calls.push({ text, options });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  }) as MockPipelineInstance;

  instance.dispose = vi.fn(async () => undefined);
  instance.model = { config: { style_dim: 128 } };
  return instance;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function loadWorkerModule({
  allowRemoteModels = true,
  chunkTexts = ["First sentence.", "Second sentence.", "Third sentence."],
  fetchMode = "valid",
  pipelineInstances,
  rechunkTexts = [],
}: LoadWorkerModuleOptions = {}) {
  vi.resetModules();

  const postedMessages: WorkerOutMessage[] = [];
  const workerGlobal = {
    postMessage: vi.fn((message: WorkerOutMessage) => {
      postedMessages.push(message);
    }),
    onmessage: null as ((event: MessageEvent<WorkerInMessage>) => void) | null,
  };

  vi.stubGlobal("self", workerGlobal);
  vi.stubGlobal("fetch", vi.fn(async () => {
    const payload = fetchMode === "valid"
      ? new Float32Array(128).buffer
      : new Uint8Array([1, 2]).buffer;
    return new Response(payload, {
      status: 200,
      headers: {
        "content-length": String(payload.byteLength),
      },
    });
  }));

  class MockTensor {
    type: string;
    data: Float32Array;
    dims: number[];

    constructor(type: string, data: Float32Array, dims: number[]) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  }

  const pipelineCalls: Array<{ text: string | string[]; options: Record<string, unknown> }> = [];
  const pipelineQueue = pipelineInstances ?? [
    createPipelineInstance([createRawAudio()], pipelineCalls),
  ];

  vi.doMock("@huggingface/transformers", () => ({
    env: {
      allowRemoteModels,
      remoteHost: "https://huggingface.co",
      remotePathTemplate: "/{model}/resolve/{revision}/",
      backends: {
        onnx: {
          webgpu: {},
          wasm: {},
        },
      },
    },
    pipeline: vi.fn(async (_task: string, _modelId: string, options?: { progress_callback?: (info: unknown) => void }) => {
      options?.progress_callback?.({});
      options?.progress_callback?.({ file: "model.onnx", status: "progress", loaded: 5, total: 10 });
      options?.progress_callback?.({ file: "model.onnx", status: "done" });
      const next = pipelineQueue.shift();
      if (!next) {
        throw new Error("No pipeline instance queued for test.");
      }
      return next;
    }),
    TextToAudioPipeline: class {},
    Tensor: MockTensor,
  }));

  vi.doMock("../lib/transformersCache", () => ({
    initializeTransformersCache: vi.fn(async () => null),
    getTransformersModelCache: vi.fn(async () => null),
  }));

  vi.doMock("../lib/webgpu", () => ({
    canInitializeWebGPU: vi.fn(async () => false),
  }));

  vi.doMock("../lib/onnxRuntime", () => ({
    configureTransformersOnnxRuntime: vi.fn(() => undefined),
  }));

  vi.doMock("../lib/chunking", () => ({
    chunkWithConstraintsDetailed: vi.fn(() => chunkTexts.map((text, index) => ({
      text,
      start: index * 20,
      end: index * 20 + text.length,
      pauseAfterSec: 0,
      pauseKind: "sentence",
    }))),
    rechunkChunkForRetry: vi.fn(() => rechunkTexts.map((text, index) => ({
      text,
      start: index * 10,
      end: index * 10 + text.length,
      pauseAfterSec: 0,
      pauseKind: "sentence",
    }))),
  }));

  vi.doMock("../lib/textTuning", () => ({
    resolvePauseSeconds: vi.fn((_pauseKind: string, fallbackPause: number) => fallbackPause),
    resolveSentenceSpeed: vi.fn((speed: number) => speed),
    tuneChunkText: vi.fn((text: string) => text),
  }));

  await import("./supertonic.worker");

  function dispatch(message: WorkerInMessage): void {
    workerGlobal.onmessage?.({ data: message } as MessageEvent<WorkerInMessage>);
  }

  return {
    dispatch,
    flushPromises,
    pipelineCalls,
    postedMessages,
    workerGlobal,
  };
}

describe("supertonic.worker", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("suppresses stale generation output after cancel", async () => {
    const deferred = createDeferred<ReturnType<typeof createRawAudio>>();
    const pipelineCalls: Array<{ text: string | string[]; options: Record<string, unknown> }> = [];
    const generationInstance = createPipelineInstance([createRawAudio(), deferred.promise], pipelineCalls);

    const { dispatch, postedMessages } = await loadWorkerModule({
      chunkTexts: ["Only sentence."],
      pipelineInstances: [generationInstance],
    });

    dispatch({ type: "LOAD" });
    await vi.waitFor(() => {
      expect(postedMessages.some((message) => message.type === "READY")).toBe(true);
    });

    dispatch({
      type: "GENERATE",
      text: "Only sentence.",
      voice: "Female",
      speed: 1,
      quality: 5,
    });
    dispatch({ type: "CANCEL" });

    deferred.resolve(createRawAudio());
    await flushPromises();

    const generationMessages = postedMessages.filter((message) => (
      message.type === "AUDIO_CHUNK" || message.type === "GENERATION_COMPLETE"
    ));
    expect(generationMessages).toHaveLength(0);
  });

  it("disposes the previous pipeline on force reload", async () => {
    const initialCalls: Array<{ text: string | string[]; options: Record<string, unknown> }> = [];
    const reloadCalls: Array<{ text: string | string[]; options: Record<string, unknown> }> = [];
    const firstInstance = createPipelineInstance([createRawAudio()], initialCalls);
    const secondInstance = createPipelineInstance([createRawAudio()], reloadCalls);

    const { dispatch, postedMessages } = await loadWorkerModule({
      chunkTexts: ["Only sentence."],
      pipelineInstances: [firstInstance, secondInstance],
    });

    dispatch({ type: "LOAD" });
    await vi.waitFor(() => {
      expect(postedMessages.some((message) => message.type === "READY")).toBe(true);
    });

    dispatch({ type: "LOAD", forceReload: true });
    await vi.waitFor(() => {
      expect(postedMessages.filter((message) => message.type === "READY")).toHaveLength(2);
    });

    expect(firstInstance.dispose).toHaveBeenCalledTimes(1);
    expect(secondInstance.dispose).not.toHaveBeenCalled();
  });

  it("disposes a newly created pipeline if load fails after creation", async () => {
    const pipelineCalls: Array<{ text: string | string[]; options: Record<string, unknown> }> = [];
    const failingInstance = createPipelineInstance([createRawAudio()], pipelineCalls);

    const { dispatch, postedMessages } = await loadWorkerModule({
      chunkTexts: ["Only sentence."],
      fetchMode: "invalid",
      pipelineInstances: [failingInstance],
    });

    dispatch({ type: "LOAD" });
    await vi.waitFor(() => {
      expect(postedMessages.some((message) => message.type === "ERROR")).toBe(true);
    });

    expect(failingInstance.dispose).toHaveBeenCalledTimes(1);
  });

  it("sends batch-safe speaker embeddings once batching becomes active", async () => {
    const pipelineCalls: Array<{ text: string | string[]; options: Record<string, unknown> }> = [];
    const batchingInstance = createPipelineInstance([
      createRawAudio(),
      createRawAudio(),
      [createRawAudio(), createRawAudio()],
    ], pipelineCalls);

    const { dispatch, postedMessages } = await loadWorkerModule({
      chunkTexts: ["First sentence.", "Second sentence.", "Third sentence."],
      pipelineInstances: [batchingInstance],
    });

    dispatch({ type: "LOAD" });
    await vi.waitFor(() => {
      expect(postedMessages.some((message) => message.type === "READY")).toBe(true);
    });

    dispatch({
      type: "GENERATE",
      text: "First sentence. Second sentence. Third sentence.",
      voice: "Female",
      speed: 1,
      quality: 5,
    });
    await vi.waitFor(() => {
      expect(postedMessages.some((message) => message.type === "GENERATION_COMPLETE")).toBe(true);
    });

    expect(Array.isArray(pipelineCalls[2]?.text)).toBe(true);
    const speakerEmbeddings = pipelineCalls[2]?.options.speaker_embeddings as MockTensorLike;
    expect(speakerEmbeddings.dims).toEqual([1, 128]);
  });

  it("reuses a loaded model, lazy-loads voices, and rejects unknown voices", async () => {
    const pipelineCalls: Array<{ text: string | string[]; options: Record<string, unknown> }> = [];
    const instance = createPipelineInstance([createRawAudio()], pipelineCalls);
    const { dispatch, postedMessages } = await loadWorkerModule({
      pipelineInstances: [instance],
    });

    dispatch({ type: "LOAD", preferredVoice: "Male", debugProfiling: true });
    await vi.waitFor(() => {
      expect(postedMessages.some((message) => message.type === "READY")).toBe(true);
    });

    dispatch({ type: "LOAD", preferredVoice: "Male 2" });
    await vi.waitFor(() => {
      expect(postedMessages.filter((message) => message.type === "READY")).toHaveLength(2);
    });

    dispatch({
      type: "GENERATE",
      text: "Bad voice.",
      voice: "Unknown",
      speed: 1,
      quality: 5,
    });

    await vi.waitFor(() => expect(postedMessages.at(-1)).toMatchObject({
      type: "ERROR",
      message: "Unknown voice: Unknown",
      scope: "generate",
    }));
  });

  it("falls back to whole text when chunking returns no chunks", async () => {
    const pipelineCalls: Array<{ text: string | string[]; options: Record<string, unknown> }> = [];
    const instance = createPipelineInstance([createRawAudio(), createRawAudio()], pipelineCalls);
    const { dispatch, postedMessages } = await loadWorkerModule({
      chunkTexts: [],
      pipelineInstances: [instance],
    });

    dispatch({ type: "LOAD" });
    await vi.waitFor(() => {
      expect(postedMessages.some((message) => message.type === "READY")).toBe(true);
    });

    dispatch({
      type: "GENERATE",
      text: "Fallback text.",
      voice: "Female",
      speed: 1,
      quality: 5,
      pauseOverridesSec: { none: 0.2 },
    });

    await vi.waitFor(() => {
      expect(postedMessages.some((message) => message.type === "GENERATION_COMPLETE")).toBe(true);
    });
    expect(postedMessages.find((message) => message.type === "AUDIO_CHUNK")).toMatchObject({
      text: "Fallback text.",
      pauseAfterSec: 0,
    });
  });

  it("falls back from a failed batch to single chunk generation", async () => {
    const pipelineCalls: Array<{ text: string | string[]; options: Record<string, unknown> }> = [];
    const instance = createPipelineInstance([
      createRawAudio(),
      createRawAudio(),
      createRawAudio(),
      createRawAudio(),
      createRawAudio(),
    ], pipelineCalls);
    const { dispatch, postedMessages } = await loadWorkerModule({
      chunkTexts: ["First.", "Second.", "Third."],
      pipelineInstances: [instance],
    });

    dispatch({ type: "LOAD" });
    await vi.waitFor(() => {
      expect(postedMessages.some((message) => message.type === "READY")).toBe(true);
    });

    dispatch({
      type: "GENERATE",
      text: "First. Second. Third.",
      voice: "Female",
      speed: 1,
      quality: 5,
    });

    await vi.waitFor(() => {
      expect(postedMessages.some((message) => message.type === "GENERATION_COMPLETE")).toBe(true);
    });

    expect(Array.isArray(pipelineCalls[2]?.text)).toBe(true);
    expect(postedMessages.filter((message) => message.type === "AUDIO_CHUNK")).toHaveLength(3);
  });

  it("reports skipped chunk and empty-output generation failures", async () => {
    const failingCalls: Array<{ text: string | string[]; options: Record<string, unknown> }> = [];
    const failingInstance = createPipelineInstance([createRawAudio(), new Error("chunk failed")], failingCalls);
    const failing = await loadWorkerModule({
      chunkTexts: ["Only chunk."],
      pipelineInstances: [failingInstance],
    });

    failing.dispatch({ type: "LOAD" });
    await vi.waitFor(() => {
      expect(failing.postedMessages.some((message) => message.type === "READY")).toBe(true);
    });
    failing.dispatch({
      type: "GENERATE",
      text: "Only chunk.",
      voice: "Female",
      speed: 1,
      quality: 5,
    });
    await vi.waitFor(() => expect(failing.postedMessages.at(-1)).toMatchObject({
      type: "ERROR",
      message: expect.stringContaining("Generation completed with skipped segments"),
      scope: "generate",
    }));

    const emptyInstance = createPipelineInstance([createRawAudio()], []);
    const empty = await loadWorkerModule({
      chunkTexts: ["   "],
      pipelineInstances: [emptyInstance],
    });
    empty.dispatch({ type: "LOAD" });
    await vi.waitFor(() => {
      expect(empty.postedMessages.some((message) => message.type === "READY")).toBe(true);
    });
    empty.dispatch({
      type: "GENERATE",
      text: "   ",
      voice: "Female",
      speed: 1,
      quality: 5,
    });
    await vi.waitFor(() => expect(empty.postedMessages.at(-1)).toMatchObject({
      type: "ERROR",
      message: "Model returned no audio chunks.",
      scope: "generate",
    }));
  });

  it("reports disabled remote downloads during voice preload", async () => {
    const instance = createPipelineInstance([createRawAudio()], []);
    const { dispatch, postedMessages } = await loadWorkerModule({
      allowRemoteModels: false,
      pipelineInstances: [instance],
    });

    dispatch({ type: "LOAD" });
    await vi.waitFor(() => expect(postedMessages.at(-1)).toMatchObject({
      type: "ERROR",
      message: expect.stringContaining("Remote model downloads are disabled"),
      scope: "load",
    }));
  });
});
