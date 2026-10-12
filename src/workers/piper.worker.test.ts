// @vitest-environment node

import { createHash } from "node:crypto";
import type * as Ort from "onnxruntime-web";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EspeakPhonemize } from "../lib/espeakPhonemizer";
import { pinnedAssetUrl } from "../lib/pinnedModelAssets";
import type { PinnedAssetManifest } from "../lib/pinnedModelFetch";
import type { PiperVoiceEntry } from "../lib/piperVoices";
import type { StyleTtsOutMessage } from "../lib/styleTtsRuntime";
import { piperEngine } from "../models/piper";
import type { WorkerInMessage } from "../types";

const PREVIEW_TEXT = [
  "Chapter One",
  "",
  "The first paragraph has a few sentences. It keeps going, with a comma here; and a clause there.",
  "",
  "A second paragraph follows after a blank line, long enough that every chunker has to make a decision about where to cut it into passages for synthesis. And a third sentence closes it out.",
].join("\n");

function voiceConfig(speakers: Record<string, number> = {}) {
  return JSON.stringify({
    audio: { sample_rate: 22_050 },
    espeak: { voice: "en-us" },
    inference: { noise_scale: 0.6, length_scale: 1, noise_w: 0.8 },
    num_speakers: Math.max(1, Object.keys(speakers).length),
    speaker_id_map: speakers,
    phoneme_id_map: { _: [0], "^": [1], $: [2], " ": [3], ",": [4], ".": [5], "?": [6], ...Object.fromEntries(Array.from("abcdefghijklmnopqrstuvwxyz", (letter, index) => [letter, [10 + index]])) },
  });
}

function fileOf(path: string, content: string) {
  const bytes = new TextEncoder().encode(content);
  return { path, content, byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

const SINGLE = "en_US-kristin-medium";
const MULTI = "en_GB-vctk-medium";
const FILES = [
  fileOf(`en/en_US/kristin/medium/${SINGLE}.onnx`, "kristin graph"),
  fileOf(`en/en_US/kristin/medium/${SINGLE}.onnx.json`, voiceConfig()),
  fileOf(`en/en_GB/vctk/medium/${MULTI}.onnx`, "vctk graph"),
  fileOf(`en/en_GB/vctk/medium/${MULTI}.onnx.json`, voiceConfig({ p1: 0, p2: 1, p3: 2 })),
];
const voice = (id: string, locale: string, speaker: string, numSpeakers: number): PiperVoiceEntry => ({
  id,
  name: speaker,
  locale,
  language: "en",
  quality: "medium",
  sampleRate: 22_050,
  numSpeakers,
  espeakVoice: "en-us",
  model: `en/${locale}/${speaker}/medium/${id}.onnx`,
  config: `en/${locale}/${speaker}/medium/${id}.onnx.json`,
  license: { id: "CC0-1.0", url: null },
  datasetUrl: null,
  attribution: `${speaker}: test voice.`,
});
const CATALOG = {
  repo: "test/piper-voices",
  revision: "0123456789abcdef0123456789abcdef01234567",
  license: "mit",
  files: Object.fromEntries(FILES.map((file) => [file.path, { byteLength: file.byteLength, sha256: file.sha256 }])),
  voices: [voice(SINGLE, "en_US", "kristin", 1), voice(MULTI, "en_GB", "vctk", 3)],
} satisfies PinnedAssetManifest & { voices: PiperVoiceEntry[] };
const fileUrl = (path: string) => pinnedAssetUrl(CATALOG, path);

/** Letters are valid phonemes in the test map, so this stands in for eSpeak. */
const phonemize: EspeakPhonemize = async (text) => [text.toLowerCase().replace(/[^a-z ]/g, "")];

interface Setup {
  serve?: Record<string, string>;
  caches?: unknown;
  /** Files whose download never finishes by itself and only ends when its request is aborted. */
  stall?: string[];
}

async function startWorker({ serve = {}, caches, stall = [] }: Setup = {}) {
  vi.resetModules();
  const messages: StyleTtsOutMessage[] = [];
  const scope = {
    onmessage: null as ((event: MessageEvent<WorkerInMessage>) => void) | null,
    postMessage: vi.fn((message: StyleTtsOutMessage) => messages.push(message)),
    close: vi.fn(),
  };
  vi.stubGlobal("self", scope);
  vi.stubGlobal("caches", caches);
  const contentByUrl = new Map(FILES.map((file) => [fileUrl(file.path), file.content]));
  const stalled = new Set(stall.map(fileUrl));
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (stalled.has(url)) {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
    }
    return new Response(serve[url] ?? contentByUrl.get(url) ?? "", { status: contentByUrl.has(url) ? 200 : 404 });
  });
  vi.stubGlobal("fetch", fetchMock);

  const sessions: Array<{ providers: unknown; model: string; run: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }> = [];
  vi.doMock("onnxruntime-web", async (importOriginal) => {
    const actual = await importOriginal<typeof Ort>();
    const create = vi.fn(async (model: Uint8Array, options: Ort.InferenceSession.SessionOptions) => {
      const run = vi.fn(async (feeds: Record<string, Ort.Tensor>) => {
        const samples = new Float32Array(feeds.input.dims[1] * 100).fill(0.25);
        return { output: new actual.Tensor("float32", samples, [1, 1, 1, samples.length]) };
      });
      const session = { providers: options.executionProviders, model: new TextDecoder().decode(model), run, release: vi.fn(async () => undefined) };
      sessions.push(session);
      return session;
    });
    return { ...actual, env: { wasm: {} }, InferenceSession: { create } };
  });
  const loadEspeakPhonemizer = vi.fn(async () => phonemize);
  vi.doMock("../lib/espeakPhonemizer", async (importOriginal) => ({
    ...await importOriginal<typeof import("../lib/espeakPhonemizer")>(),
    loadEspeakPhonemizer,
  }));
  vi.doMock("../lib/onnxWasmAssets", () => ({
    TRANSFORMERS_ONNX_WASM_ASSETS: { asyncify: { mjs: "/ort.mjs", wasm: "/ort.wasm" } },
    PHONEMIZER_MODULE_URL: "/assets/phonemizer.js",
  }));
  vi.doMock("./manifests/piperVoices", () => ({ PIPER_CATALOG: CATALOG }));

  await import("./piper.worker");
  return {
    messages,
    scope,
    sessions,
    fetchMock,
    loadEspeakPhonemizer,
    send: (message: WorkerInMessage) => scope.onmessage?.({ data: message } as MessageEvent<WorkerInMessage>),
    ofType: <T extends StyleTtsOutMessage["type"]>(type: T) =>
      messages.filter((message) => message.type === type) as Array<Extract<StyleTtsOutMessage, { type: T }>>,
  };
}

type Worker = Awaited<ReturnType<typeof startWorker>>;

async function settledLoad(worker: Worker, preferredVoice?: string) {
  worker.send({ type: "LOAD", preferredVoice });
  await vi.waitFor(() => expect(worker.ofType("READY").length + worker.ofType("ERROR").length).toBeGreaterThan(0));
}

async function generate(worker: Worker, voiceId: string, text = "Hello there.", generationId = "g1") {
  const settled = () => worker.ofType("GENERATION_COMPLETE").length + worker.ofType("ERROR").length;
  const before = settled();
  worker.send({ type: "GENERATE", generationId, text, voice: voiceId, speed: 1, quality: 5 });
  await vi.waitFor(() => expect(settled()).toBeGreaterThan(before));
}

function fetchedPaths(worker: Worker): string[] {
  return worker.fetchMock.mock.calls.map(([url]) => decodeURIComponent(String(url).split(`/${CATALOG.revision}/`)[1])).sort();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("piper.worker", () => {
  it("downloads only the default voice, opens it on WASM and warms it up", async () => {
    const worker = await startWorker();

    await settledLoad(worker);

    expect(worker.ofType("READY")).toEqual([{ type: "READY", voices: [SINGLE, MULTI], backend: "wasm" }]);
    expect(fetchedPaths(worker)).toEqual([FILES[0].path, FILES[1].path]);
    expect(worker.loadEspeakPhonemizer).toHaveBeenCalledWith("/assets/phonemizer.js");
    expect(worker.sessions.map(({ providers, model }) => ({ providers, model }))).toEqual([{ providers: ["wasm"], model: "kristin graph" }]);
    expect(worker.sessions[0].run).toHaveBeenCalledOnce();
    const percents = worker.ofType("LOAD_PROGRESS").map((message) => message.percent);
    expect(percents[0]).toBe(0);
    expect(percents.at(-1)).toBe(100);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
  });

  it("downloads the preferred voice instead when LOAD names one", async () => {
    const worker = await startWorker();

    await settledLoad(worker, MULTI);

    expect(fetchedPaths(worker)).toEqual([FILES[2].path, FILES[3].path]);
    expect(worker.sessions.map(({ model }) => model)).toEqual(["vctk graph"]);
  });

  it("generates 22.05 kHz chunks with exact offsets and rendered pauses", async () => {
    const worker = await startWorker();
    await settledLoad(worker);
    const text = "Hello there. How are you?";

    worker.send({ type: "GENERATE", generationId: "g1", text, voice: SINGLE, speed: 1, quality: 5, finalPauseSec: 0.5 });
    await vi.waitFor(() => expect(worker.ofType("GENERATION_COMPLETE")).toHaveLength(1));

    const chunks = worker.ofType("AUDIO_CHUNK");
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.samplingRate).toBe(22_050);
      expect(text.slice(chunk.textStart, chunk.textEnd)).toBe(chunk.text);
      expect(chunk).not.toHaveProperty("wordTimings");
    }
    const last = chunks.at(-1)!;
    expect(last.pauseAfterSec).toBe(0.5);
    expect(Array.from(last.audio.subarray(-11_025)).every((sample) => sample === 0)).toBe(true);
  });

  it("emits the passages the Piper engine previews for the Reader", async () => {
    const worker = await startWorker();
    await settledLoad(worker);

    await generate(worker, SINGLE, PREVIEW_TEXT);

    const preview = piperEngine.previewChunks(PREVIEW_TEXT, { settings: { voice: SINGLE }, backend: "wasm", quality: 5 });
    expect(preview.length).toBeGreaterThan(1);
    expect(worker.ofType("AUDIO_CHUNK").map(({ text, textStart, textEnd }) => ({ text, start: textStart, end: textEnd })))
      .toEqual(preview.map(({ text, start, end }) => ({ text, start, end })));
  });

  it("switches to another voice on demand, selecting the speaker and releasing the previous session", async () => {
    const worker = await startWorker();
    await settledLoad(worker);

    await generate(worker, `${MULTI}#p3`);
    await generate(worker, `${MULTI}#1`, "Again.", "g2");

    expect(fetchedPaths(worker)).toEqual([...FILES.map((file) => file.path)].sort());
    expect(worker.sessions.map(({ model }) => model)).toEqual(["kristin graph", "vctk graph"]);
    expect(worker.sessions[0].release).toHaveBeenCalledOnce();
    expect(worker.sessions[1].release).not.toHaveBeenCalled();
    const sids = worker.sessions[1].run.mock.calls.map(([feeds]) => Array.from(feeds.sid.data as BigInt64Array));
    // Warm-up on speaker 0, then the named speaker p3 (id 2) and the numeric speaker 1.
    expect(sids).toEqual([[0n], [2n], [1n]]);
    expect(worker.ofType("AUDIO_CHUNK").map((chunk) => chunk.generationId)).toEqual(["g1", "g2"]);
  });

  it("reports the download of a voice switched to inside GENERATE like a LOAD", async () => {
    const worker = await startWorker();
    await settledLoad(worker);
    const loadMessages = worker.ofType("LOAD_PROGRESS").length;

    await generate(worker, SINGLE);
    expect(worker.ofType("LOAD_PROGRESS")).toHaveLength(loadMessages);
    await generate(worker, MULTI, "Switch.", "g2");

    const percents = worker.ofType("LOAD_PROGRESS").slice(loadMessages).map((message) => message.percent);
    expect(percents.length).toBeGreaterThan(0);
    expect(percents.at(-1)).toBe(100);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
    expect(worker.ofType("GENERATION_COMPLETE")).toHaveLength(2);
  });

  it("stops a voice download on ABORT, keeps the loaded voice and answers ABORTED", async () => {
    const worker = await startWorker({ stall: [FILES[2].path] });
    await settledLoad(worker);

    worker.send({ type: "GENERATE", generationId: "g1", text: "Switch.", voice: MULTI, speed: 1, quality: 5 });
    await vi.waitFor(() => expect(fetchedPaths(worker)).toContain(FILES[2].path));
    worker.send({ type: "ABORT", generationId: "g1" });

    await vi.waitFor(() => expect(worker.ofType("ABORTED")).toEqual([{ type: "ABORTED", generationId: "g1" }]));
    expect(worker.ofType("ERROR")).toHaveLength(0);
    expect(worker.sessions).toHaveLength(1);
    expect(worker.sessions[0].release).not.toHaveBeenCalled();
    await generate(worker, SINGLE, "Still here.", "g2");
    expect(worker.ofType("GENERATION_COMPLETE")).toEqual([{ type: "GENERATION_COMPLETE", generationId: "g2" }]);
  });

  it("stops a voice download when a newer GENERATE supersedes it, or on CANCEL", async () => {
    const worker = await startWorker({ stall: [FILES[2].path] });
    await settledLoad(worker);

    worker.send({ type: "GENERATE", generationId: "g1", text: "Switch.", voice: MULTI, speed: 1, quality: 5 });
    await vi.waitFor(() => expect(fetchedPaths(worker)).toContain(FILES[2].path));
    worker.send({ type: "GENERATE", generationId: "g2", text: "Stay.", voice: SINGLE, speed: 1, quality: 5 });
    await vi.waitFor(() => expect(worker.ofType("GENERATION_COMPLETE")).toEqual([{ type: "GENERATION_COMPLETE", generationId: "g2" }]));
    expect(worker.ofType("ERROR")).toHaveLength(0);

    worker.send({ type: "GENERATE", generationId: "g3", text: "Switch.", voice: MULTI, speed: 1, quality: 5 });
    await vi.waitFor(() => expect(worker.fetchMock.mock.calls.filter(([url]) => url === fileUrl(FILES[2].path))).toHaveLength(2));
    worker.send({ type: "CANCEL" });
    await vi.waitFor(() => expect(worker.ofType("CANCELLED")).toHaveLength(1));
    expect(worker.ofType("ERROR")).toHaveLength(0);
    expect(worker.sessions).toHaveLength(1);
  });

  it("falls back to the default voice for a voice id from another model", async () => {
    const worker = await startWorker();
    await settledLoad(worker);

    await generate(worker, "af_heart");

    expect(worker.ofType("AUDIO_CHUNK")).toHaveLength(1);
    expect(worker.sessions).toHaveLength(1);
  });

  it("refuses a voice that fails digest verification before creating a session", async () => {
    const worker = await startWorker({ serve: { [fileUrl(FILES[0].path)]: "kristin GRAPH" } });

    await settledLoad(worker);

    expect(worker.ofType("ERROR")).toEqual([{
      type: "ERROR",
      scope: "load",
      message: `Piper ${FILES[0].path} failed integrity verification.`,
    }]);
    expect(worker.sessions).toHaveLength(0);
  });

  it("reports a voice that cannot be downloaded when it is first asked for, and keeps working", async () => {
    const worker = await startWorker({ serve: { [fileUrl(FILES[3].path)]: FILES[3].content.replace("p1", "q1") } });
    await settledLoad(worker);

    await generate(worker, MULTI);
    await generate(worker, SINGLE, "Still here.", "g2");

    expect(worker.ofType("ERROR")).toEqual([{
      type: "ERROR",
      scope: "generate",
      generationId: "g1",
      message: `Piper ${FILES[3].path} failed integrity verification.`,
    }]);
    expect(worker.ofType("GENERATION_COMPLETE")).toEqual([{ type: "GENERATION_COMPLETE", generationId: "g2" }]);
    expect(worker.sessions[0].release).not.toHaveBeenCalled();
  });

  it("clears its cache on a forced reload", async () => {
    const storage = { open: vi.fn(async () => { throw new Error("blocked"); }), delete: vi.fn(async () => true) };
    const worker = await startWorker({ caches: storage });
    await settledLoad(worker);

    worker.send({ type: "LOAD", forceReload: true });
    await vi.waitFor(() => expect(worker.ofType("READY")).toHaveLength(2));

    expect(storage.delete).toHaveBeenCalledWith("transformers-cache-piper-v1");
    expect(worker.sessions[0].release).toHaveBeenCalledOnce();
  });

  it("closes on CANCEL", async () => {
    const worker = await startWorker();

    worker.send({ type: "CANCEL" });

    expect(worker.ofType("CANCELLED")).toHaveLength(1);
    expect(worker.scope.close).toHaveBeenCalledOnce();
  });
});
