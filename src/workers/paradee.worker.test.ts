// @vitest-environment node

import { createHash } from "node:crypto";
import type * as Ort from "onnxruntime-web";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EspeakPhonemize } from "../lib/espeakPhonemizer";
import { pinnedAssetUrl } from "../lib/pinnedModelAssets";
import type { PinnedAssetManifest } from "../lib/pinnedModelFetch";
import type { StyleTtsOutMessage } from "../lib/styleTtsRuntime";
import { paradeeEngine } from "../models/paradee";
import type { AnyEngineDescriptor } from "../models/types";
import type { WorkerInMessage } from "../types";

function pinnedFile(content: string, path: string) {
  const bytes = new TextEncoder().encode(content);
  return { path, content, byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

const PREVIEW_TEXT = [
  "Chapter One",
  "",
  "The first paragraph has a few sentences. It keeps going, with a comma here; and a clause there.",
  "",
  "A second paragraph follows after a blank line, long enough that every chunker has to make a decision about where to cut it into passages for synthesis. And a third sentence closes it out.",
].join("\n");

const VOCAB = { ",": 3, ".": 4, "!": 5, "?": 6, " ": 16, ...Object.fromEntries(Array.from("abcdefghijklmnopqrstuvwxyz", (letter, index) => [letter, 43 + index])) };
const FILES = {
  PARADEE_INT8_MODEL: pinnedFile("paradee graph", "onnx/paradee_int8.onnx"),
  PARADEE_CONFIG_FILE: pinnedFile(JSON.stringify({ sample_rate: 24_000, vocab: VOCAB }), "config.json"),
};
const MANIFEST = {
  repo: "test/paradee",
  revision: "0123456789abcdef0123456789abcdef01234567",
  files: Object.fromEntries(Object.values(FILES).map((file) => [file.path, { byteLength: file.byteLength, sha256: file.sha256 }])),
} satisfies PinnedAssetManifest;
const fileUrl = (file: { path: string }) => pinnedAssetUrl(MANIFEST, file.path);

/** Lower-cased letters are in the test vocabulary, so this stands in for eSpeak. */
const phonemize: EspeakPhonemize = async (text) => [text.toLowerCase()];

interface Setup {
  serve?: Record<string, string>;
  createError?: Error;
  runError?: Error;
}

async function startWorker({ serve = {}, createError, runError }: Setup = {}) {
  vi.resetModules();
  const messages: StyleTtsOutMessage[] = [];
  const scope = {
    onmessage: null as ((event: MessageEvent<WorkerInMessage>) => void) | null,
    postMessage: vi.fn((message: StyleTtsOutMessage) => messages.push(message)),
    close: vi.fn(),
  };
  vi.stubGlobal("self", scope);
  vi.stubGlobal("caches", undefined);
  const contentByUrl = new Map(Object.values(FILES).map((file) => [fileUrl(file), file.content]));
  const fetchMock = vi.fn(async (url: string) => new Response(serve[url] ?? contentByUrl.get(url) ?? "", { status: contentByUrl.has(url) ? 200 : 404 }));
  vi.stubGlobal("fetch", fetchMock);

  const sessions: Array<{ providers: unknown; model: string; run: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }> = [];
  vi.doMock("onnxruntime-web", async (importOriginal) => {
    const actual = await importOriginal<typeof Ort>();
    const create = vi.fn(async (model: Uint8Array, options: Ort.InferenceSession.SessionOptions) => {
      if (createError) throw createError;
      const run = vi.fn(async (feeds: Record<string, Ort.Tensor>) => {
        if (runError) throw runError;
        const samples = new Float32Array(feeds.input_ids.dims[1] * 100).fill(0.25);
        return { waveform: new actual.Tensor("float32", samples, [1, samples.length]) };
      });
      const session = { providers: options.executionProviders, model: new TextDecoder().decode(model), run, release: vi.fn(async () => undefined) };
      sessions.push(session);
      return session;
    });
    return { ...actual, env: { wasm: {} }, InferenceSession: { create } };
  });
  vi.doMock("../lib/espeakPhonemizer", async (importOriginal) => ({
    ...await importOriginal<typeof import("../lib/espeakPhonemizer")>(),
    loadEspeakPhonemizer: vi.fn(async () => phonemize),
  }));
  vi.doMock("../lib/onnxWasmAssets", () => ({
    TRANSFORMERS_ONNX_WASM_ASSETS: { asyncify: { mjs: "/ort.mjs", wasm: "/ort.wasm" } },
    PHONEMIZER_MODULE_URL: "/assets/phonemizer.js",
  }));
  const canInitializeWebGPU = vi.fn(async () => true);
  vi.doMock("../lib/webgpu", () => ({ canInitializeWebGPU }));
  vi.doMock("./manifests/paradee", () => ({ PARADEE_ASSETS: MANIFEST }));

  await import("./paradee.worker");
  return {
    messages,
    scope,
    sessions,
    fetchMock,
    canInitializeWebGPU,
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("paradee.worker", () => {
  it("loads the verified int8 graph on WASM without probing WebGPU and warms it up", async () => {
    const worker = await startWorker();

    await settledLoad(worker);

    expect(worker.ofType("READY")).toEqual([{ type: "READY", voices: ["heart"], backend: "wasm" }]);
    expect(worker.fetchMock.mock.calls.map(([url]) => url).sort()).toEqual(Object.values(FILES).map(fileUrl).sort());
    expect(worker.sessions.map(({ providers, model }) => ({ providers, model }))).toEqual([{ providers: ["wasm"], model: "paradee graph" }]);
    expect(worker.sessions[0].run).toHaveBeenCalledOnce();
    expect(worker.canInitializeWebGPU).not.toHaveBeenCalled();
    expect(worker.ofType("LOAD_PROGRESS").at(-1)).toEqual({ type: "LOAD_PROGRESS", percent: 100 });
  });

  it("generates 24 kHz chunks with exact offsets and rendered pauses, without word timings", async () => {
    const worker = await startWorker();
    await settledLoad(worker);
    const text = "Hello there. How are you?";

    worker.send({ type: "GENERATE", generationId: "g1", text, voice: "heart", speed: 1, quality: 5, finalPauseSec: 0.5 });
    await vi.waitFor(() => expect(worker.ofType("GENERATION_COMPLETE")).toHaveLength(1));

    const chunks = worker.ofType("AUDIO_CHUNK");
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.samplingRate).toBe(24_000);
      expect(text.slice(chunk.textStart, chunk.textEnd)).toBe(chunk.text);
      expect(chunk).not.toHaveProperty("wordTimings");
    }
    const last = chunks.at(-1)!;
    expect(last.pauseAfterSec).toBe(0.5);
    expect(Array.from(last.audio.subarray(-12_000)).every((sample) => sample === 0)).toBe(true);
  });

  it("emits the passages the Paradee engine previews for the Reader", async () => {
    const worker = await startWorker();
    await settledLoad(worker);

    worker.send({ type: "GENERATE", generationId: "g1", text: PREVIEW_TEXT, voice: "heart", speed: 1, quality: 5 });
    await vi.waitFor(() => expect(worker.ofType("GENERATION_COMPLETE")).toHaveLength(1));

    const preview = (paradeeEngine as AnyEngineDescriptor).previewChunks(PREVIEW_TEXT, { settings: paradeeEngine.defaultSettings, backend: "wasm", quality: 5 });
    expect(preview.length).toBeGreaterThan(1);
    expect(worker.ofType("AUDIO_CHUNK").map(({ text, textStart, textEnd }) => ({ text, start: textStart, end: textEnd })))
      .toEqual(preview.map(({ text, start, end }) => ({ text, start, end })));
  });

  it("refuses a model that fails digest verification", async () => {
    const worker = await startWorker({ serve: { [fileUrl(FILES.PARADEE_INT8_MODEL)]: "paradee GRAPH" } });

    await settledLoad(worker);

    expect(worker.ofType("ERROR")).toEqual([{
      type: "ERROR",
      scope: "load",
      message: "Paradee onnx/paradee_int8.onnx failed integrity verification.",
    }]);
    expect(worker.sessions).toHaveLength(0);
  });

  it("releases the session when the warm-up fails, and reports session errors", async () => {
    const warmUp = await startWorker({ runError: new Error("bad graph") });
    await settledLoad(warmUp);
    expect(warmUp.ofType("ERROR")).toEqual([{ type: "ERROR", scope: "load", message: "bad graph" }]);
    expect(warmUp.sessions[0].release).toHaveBeenCalledOnce();

    const create = await startWorker({ createError: new Error("no wasm") });
    await settledLoad(create);
    expect(create.ofType("ERROR")).toEqual([{ type: "ERROR", scope: "load", message: "no wasm" }]);
  });

  it("closes on CANCEL", async () => {
    const worker = await startWorker();

    worker.send({ type: "CANCEL" });

    expect(worker.ofType("CANCELLED")).toHaveLength(1);
    expect(worker.scope.close).toHaveBeenCalledOnce();
  });
});
