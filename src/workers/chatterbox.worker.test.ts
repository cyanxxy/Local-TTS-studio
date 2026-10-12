import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatterboxWorkerInMessage } from "../lib/chatterboxProtocol";
import { getChatterboxTokenBudget, type ChatterboxConditioning, type ChatterboxRuntime, type ChatterboxSynthesisResult } from "../lib/chatterboxRuntime";
import { encodeWavPcm16 } from "../lib/wavCodec";
import { chatterboxEngine } from "../models/chatterbox";
import type { AnyEngineDescriptor } from "../models/types";

type Posted = Record<string, unknown> & { type: string };

interface LoadOptions {
  canUseWebGPU?: boolean;
  loadError?: Error;
  synthesize?: ChatterboxRuntime["synthesize"];
  guardError?: boolean;
}

function referenceClip(seconds: number, rate: number, amplitude = 0.3): Float32Array {
  const samples = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < samples.length; i += 1) {
    const t = i / rate;
    samples[i] = amplitude * (0.6 + (0.4 * Math.sin(2 * Math.PI * 3 * t))) * Math.sin(2 * Math.PI * 200 * t);
  }
  return samples;
}

function wavBuffer(): ArrayBuffer {
  const wav = encodeWavPcm16(referenceClip(5, 24_000), 24_000);
  return wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function loadWorker(options: LoadOptions = {}) {
  vi.resetModules();
  const posted: Posted[] = [];
  const worker = {
    onmessage: null as ((event: MessageEvent<ChatterboxWorkerInMessage>) => void) | null,
    postMessage: vi.fn((message: Posted) => {
      posted.push(message);
    }),
    close: vi.fn(),
    fetch: vi.fn(),
  };
  vi.stubGlobal("self", worker);

  const conditioning = (tag: string) => ({ tag }) as unknown as ChatterboxConditioning;
  let encodes = 0;
  const runtime = {
    backend: "webgpu" as const,
    dtype: { embed_tokens: "fp32", speech_encoder: "q4", language_model: "q4", conditional_decoder: "q4" } as const,
    sampleRate: 24_000,
    encodeReference: vi.fn(async () => conditioning(`c${++encodes}`)),
    synthesize: vi.fn<ChatterboxRuntime["synthesize"]>(options.synthesize ?? (async () => ({
      audio: new Float32Array(2_400).fill(0.1),
      reachedStop: true,
      speechTokens: 60,
    }))),
    dispose: vi.fn(async () => undefined),
  } satisfies ChatterboxRuntime;
  const loadChatterboxRuntime = vi.fn(async () => {
    if (options.loadError) throw options.loadError;
    return runtime;
  });
  const guardOptions: Array<{ onProgress?: (file: string, loaded: number) => void; onError?: (file: string, error: unknown) => void }> = [];
  const env = { backends: { onnx: { wasm: {} } } } as Record<string, unknown>;

  // The real runtime module is only imported for its pure helpers, so the library needs placeholder classes.
  class Placeholder {}
  class PlaceholderModel extends Placeholder {
    async generate() {
      return undefined;
    }
  }
  vi.doMock("@huggingface/transformers", () => ({
    env,
    AutoTokenizer: Placeholder,
    ChatterboxModel: class extends PlaceholderModel {},
    LogitsProcessor: Placeholder,
    LogitsProcessorList: Placeholder,
    StoppingCriteria: Placeholder,
    StoppingCriteriaList: Placeholder,
    Tensor: Placeholder,
    random: {},
  }));
  vi.doMock("../lib/webgpu", () => ({ canInitializeWebGPU: async () => options.canUseWebGPU ?? true }));
  vi.doMock("../lib/onnxWasmAssets", () => ({ TRANSFORMERS_ONNX_WASM_ASSETS: { asyncify: { mjs: "m.mjs", wasm: "m.wasm" } } }));
  vi.doMock("../lib/transformersCache", () => ({
    getTransformersModelCache: async () => ({ match: async () => undefined, put: async () => undefined }),
  }));
  vi.doMock("../lib/chatterboxRuntime", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../lib/chatterboxRuntime")>()),
    loadChatterboxRuntime,
  }));
  vi.doMock("../lib/chatterboxAssets", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../lib/chatterboxAssets")>()),
    loadVerifiedAsset: vi.fn(async (_url: string, _file: string, _integrity: unknown, _fetch: unknown, _cache: unknown, onProgress?: (loaded: number) => void) => {
      const buffer = wavBuffer();
      onProgress?.(buffer.byteLength);
      return buffer;
    }),
    createChatterboxAssetGuard: vi.fn((guardConfig: (typeof guardOptions)[number]) => {
      guardOptions.push(guardConfig);
      return { fetch: vi.fn(), cache: { match: vi.fn(), put: vi.fn() } };
    }),
  }));

  await import("./chatterbox.worker");
  const dispatch = (data: ChatterboxWorkerInMessage) => worker.onmessage?.({ data } as MessageEvent<ChatterboxWorkerInMessage>);
  const ofType = (type: string) => posted.filter((message) => message.type === type);
  const waitFor = async (predicate: () => boolean) => {
    for (let i = 0; i < 200 && !predicate(); i += 1) await flush();
    expect(predicate()).toBe(true);
  };
  if (options.guardError) {
    // Simulates the asset guard reporting a failed download before the load throws.
    loadChatterboxRuntime.mockImplementationOnce(async () => {
      guardOptions[0]?.onError?.("onnx/x.onnx", new Error("Chatterbox Turbo onnx/x.onnx failed integrity verification."));
      throw new Error("Failed to load model");
    });
  }
  const load = async () => {
    dispatch({ type: "LOAD" });
    await waitFor(() => ofType("READY").length + ofType("ERROR").length > 0);
  };
  return { worker, posted, runtime, loadChatterboxRuntime, dispatch, ofType, waitFor, load, env, guardOptions };
}

describe("chatterbox.worker", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  describe("LOAD", () => {
    it("loads the pinned model on WebGPU, warms up with the default voice and reports capabilities", async () => {
      const { load, ofType, runtime, loadChatterboxRuntime, env } = await loadWorker();
      await load();

      expect(loadChatterboxRuntime).toHaveBeenCalledWith({
        backend: "webgpu",
        dtype: { embed_tokens: "fp32", speech_encoder: "q4", language_model: "q4", conditional_decoder: "q4" },
      });
      expect(runtime.encodeReference).toHaveBeenCalledTimes(1);
      expect(runtime.synthesize).toHaveBeenCalledWith(
        "Hello.",
        expect.anything(),
        expect.objectContaining({ maxNewTokens: 8, sampling: expect.objectContaining({ temperature: 0 }) }),
      );
      expect(env).toMatchObject({ allowLocalModels: false, allowRemoteModels: true, useCustomCache: true, useBrowserCache: false });

      const [ready] = ofType("READY");
      expect(ready).toMatchObject({
        backend: "webgpu",
        voices: ["chatterbox-default"],
        defaultReferenceId: "chatterbox-default",
        controls: { temperature: true, seed: true, exaggeration: false, cfg: false },
      });
      expect(ready.tags).toContain("[laugh]");
      expect((ready.dtype as Record<string, string>).embed_tokens).toBe("fp32");
    });

    it("posts load progress that only rises and ends at 100", async () => {
      const { load, ofType } = await loadWorker();
      await load();
      const percents = ofType("LOAD_PROGRESS").map((message) => message.percent as number);
      expect(percents.length).toBeGreaterThan(1);
      expect(percents.every((value, index) => index === 0 || value >= percents[index - 1])).toBe(true);
      expect(percents.at(-1)).toBe(100);
    });

    it("weighs download progress by pinned bytes", async () => {
      const { load, ofType, guardOptions } = await loadWorker();
      await load();
      const before = ofType("LOAD_PROGRESS").length;
      guardOptions[0].onProgress?.("onnx/language_model_q4.onnx_data", 1);
      // Progress after the load settled is ignored.
      expect(ofType("LOAD_PROGRESS")).toHaveLength(before);
    });

    it("answers a repeated LOAD from the resident model and reloads on forceReload", async () => {
      const { load, dispatch, waitFor, ofType, loadChatterboxRuntime, runtime } = await loadWorker();
      await load();
      dispatch({ type: "LOAD" });
      await waitFor(() => ofType("READY").length === 2);
      expect(loadChatterboxRuntime).toHaveBeenCalledTimes(1);

      dispatch({ type: "LOAD", forceReload: true });
      await waitFor(() => ofType("READY").length === 3);
      expect(loadChatterboxRuntime).toHaveBeenCalledTimes(2);
      expect(runtime.dispose).toHaveBeenCalledTimes(1);
    });

    it("explains that WebGPU is required when the device is unavailable", async () => {
      const { load, ofType, loadChatterboxRuntime } = await loadWorker({ canUseWebGPU: false });
      await load();
      expect(loadChatterboxRuntime).not.toHaveBeenCalled();
      expect(ofType("ERROR")).toEqual([
        expect.objectContaining({ scope: "load", message: expect.stringContaining("Chatterbox Turbo needs WebGPU") }),
      ]);
    });

    it("reports a failed download as is, not as a WebGPU problem", async () => {
      const { load, ofType } = await loadWorker({ guardError: true });
      await load();
      const [error] = ofType("ERROR");
      expect(error.scope).toBe("load");
      expect(error.message).toBe("Chatterbox Turbo onnx/x.onnx failed integrity verification.");
    });

    it("reports an out-of-memory load failure with its real cause", async () => {
      const { load, ofType } = await loadWorker({ loadError: new Error("Out of memory") });
      await load();
      const [error] = ofType("ERROR");
      expect(error.message).toBe("Out of memory");
      expect(error.message).not.toContain("needs WebGPU");
    });

    it("disposes a runtime whose warm-up fails and reports the error", async () => {
      const { load, ofType, runtime } = await loadWorker({
        synthesize: async () => ({ audio: new Float32Array(0), reachedStop: true, speechTokens: 0 }),
      });
      await load();
      expect(runtime.dispose).toHaveBeenCalledTimes(1);
      expect(ofType("ERROR")[0].message).toContain("returned no audio");
      expect(ofType("READY")).toHaveLength(0);
    });
  });

  describe("references", () => {
    it("prepares a reference clip without a transcript and reports its digest and duration", async () => {
      const { load, dispatch, waitFor, ofType } = await loadWorker();
      await load();
      dispatch({ type: "SET_REFERENCE", referenceId: "narrator", audio: referenceClip(6, 44_100), samplingRate: 44_100 });
      await waitFor(() => ofType("REFERENCE_READY").length === 1);
      const [ready] = ofType("REFERENCE_READY");
      expect(ready.referenceId).toBe("narrator");
      expect(ready.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(ready.durationSec as number).toBeGreaterThan(5.5);
    });

    it.each([
      ["a reserved id", { referenceId: "chatterbox-default", audio: referenceClip(5, 24_000), samplingRate: 24_000 }, /Invalid reference id/],
      ["an empty id", { referenceId: "", audio: referenceClip(5, 24_000), samplingRate: 24_000 }, /Invalid reference id/],
      ["a clip that is not Float32", { referenceId: "x", audio: [1, 2, 3], samplingRate: 24_000 }, /Float32Array/],
      ["a clip that is too short", { referenceId: "x", audio: referenceClip(1, 24_000), samplingRate: 24_000 }, /at least 3 seconds/],
    ])("reports %s as a reference error", async (_label, message, pattern) => {
      const { load, dispatch, waitFor, ofType } = await loadWorker();
      await load();
      dispatch({ type: "SET_REFERENCE", ...message } as unknown as ChatterboxWorkerInMessage);
      await waitFor(() => ofType("ERROR").length === 1);
      const [error] = ofType("ERROR");
      expect(error.scope).toBe("reference");
      expect(error.message).toMatch(pattern);
    });

    it("encodes each distinct clip once and reuses it across generations and ids", async () => {
      const { load, dispatch, waitFor, ofType, runtime } = await loadWorker();
      await load();
      const clip = referenceClip(5, 24_000);
      dispatch({ type: "SET_REFERENCE", referenceId: "a", audio: clip.slice(), samplingRate: 24_000 });
      dispatch({ type: "SET_REFERENCE", referenceId: "b", audio: clip.slice(), samplingRate: 24_000 });
      await waitFor(() => ofType("REFERENCE_READY").length === 2);
      const encodesAfterLoad = runtime.encodeReference.mock.calls.length;

      for (const [index, referenceId] of ["a", "a", "b"].entries()) {
        dispatch({ type: "GENERATE", generationId: `g${index}`, text: "Hello there.", referenceId });
        await waitFor(() => ofType("GENERATION_COMPLETE").length === index + 1);
      }
      expect(runtime.encodeReference.mock.calls.length - encodesAfterLoad).toBe(1);
    });

    it("forgets a deleted reference", async () => {
      const { load, dispatch, waitFor, ofType } = await loadWorker();
      await load();
      dispatch({ type: "SET_REFERENCE", referenceId: "a", audio: referenceClip(5, 24_000), samplingRate: 24_000 });
      await waitFor(() => ofType("REFERENCE_READY").length === 1);
      dispatch({ type: "DELETE_REFERENCE", referenceId: "a" });
      dispatch({ type: "DELETE_REFERENCE", referenceId: "chatterbox-default" });
      dispatch({ type: "GENERATE", generationId: "g", text: "Hello there.", referenceId: "a" });
      await waitFor(() => ofType("ERROR").length === 1);
      expect(ofType("ERROR")[0]).toMatchObject({ scope: "generate", generationId: "g" });
      expect(ofType("ERROR")[0].message).toContain('Reference voice "a" is not loaded');
      // The built-in voice survives a delete request.
      dispatch({ type: "GENERATE", generationId: "g2", text: "Hello there." });
      await waitFor(() => ofType("GENERATION_COMPLETE").length === 1);
    });
  });

  describe("GENERATE", () => {
    it("streams audio chunks for the default voice and completes", async () => {
      const { load, dispatch, waitFor, ofType, runtime } = await loadWorker();
      await load();
      dispatch({ type: "GENERATE", generationId: "g1", text: "Hello there. How are you today?", seed: 5, temperature: 0.5 });
      await waitFor(() => ofType("GENERATION_COMPLETE").length === 1);

      const chunks = ofType("AUDIO_CHUNK");
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0]).toMatchObject({ generationId: "g1", samplingRate: 24_000, index: 1 });
      expect((chunks[0].audio as Float32Array).length).toBeGreaterThanOrEqual(2_400);
      expect(ofType("GENERATION_COMPLETE")[0]).toEqual({ type: "GENERATION_COMPLETE", generationId: "g1" });
      const call = runtime.synthesize.mock.calls.at(-1)!;
      expect(call[2].sampling).toMatchObject({ temperature: 0.5, seed: 5 + chunks.length - 1 });
    });

    it("emits the passages the Chatterbox engine previews for the Reader, tag-only passages skipped", async () => {
      const text = [
        "Chapter One",
        "",
        "The first paragraph has a few sentences. It keeps going, with a comma here; and a clause there.",
        "",
        "[waves hello]",
        "",
        "A second paragraph follows after a blank line, long enough that the chunker has to decide where to cut it into passages. [laugh] And a third sentence closes it out.",
      ].join("\n");
      const { load, dispatch, waitFor, ofType } = await loadWorker();
      await load();
      dispatch({ type: "GENERATE", generationId: "g1", text });
      await waitFor(() => ofType("GENERATION_COMPLETE").length === 1);

      const preview = (chatterboxEngine as AnyEngineDescriptor).previewChunks(text, { settings: chatterboxEngine.defaultSettings, backend: "webgpu", quality: 5 });
      expect(preview.length).toBeGreaterThan(1);
      expect(ofType("AUDIO_CHUNK").map((chunk) => [chunk.textStart, chunk.textEnd]))
        .toEqual(preview.map((chunk) => [chunk.start, chunk.end]));
    });

    it("sends canonical tags to the model and reports directions it cannot perform", async () => {
      const { load, dispatch, waitFor, ofType, runtime } = await loadWorker();
      await load();
      runtime.synthesize.mockClear();
      dispatch({ type: "GENERATE", generationId: "g1", text: "that is funny [Laughs] [pause 2s] really" });
      await waitFor(() => ofType("GENERATION_COMPLETE").length === 1);

      expect(runtime.synthesize.mock.calls[0][0]).toBe("That is funny [laugh] really.");
      expect(ofType("UNSUPPORTED_TAGS")).toEqual([{ type: "UNSUPPORTED_TAGS", generationId: "g1", tags: ["[pause 2s]"] }]);
    });

    it("gives tag-only text a token budget for the tag and never reads unknown tags aloud", async () => {
      const { load, dispatch, waitFor, ofType, runtime } = await loadWorker();
      await load();
      runtime.synthesize.mockClear();
      dispatch({ type: "GENERATE", generationId: "g1", text: "[laughs]" });
      await waitFor(() => ofType("GENERATION_COMPLETE").length === 1);
      expect(runtime.synthesize.mock.calls[0][0]).toBe("[laugh].");
      expect(runtime.synthesize.mock.calls[0][2].maxNewTokens).toBe(75);

      dispatch({ type: "GENERATE", generationId: "g2", text: "[beep]" });
      await waitFor(() => ofType("ERROR").length === 1);
      expect(ofType("ERROR")[0]).toMatchObject({ scope: "generate", generationId: "g2", message: "There is no speakable text to generate." });
      expect(runtime.synthesize).toHaveBeenCalledTimes(1);
    });

    it("renders the requested final pause as trailing silence", async () => {
      const { load, dispatch, waitFor, ofType } = await loadWorker();
      await load();
      dispatch({ type: "GENERATE", generationId: "g1", text: "Hello there.", finalPauseSec: 1 });
      await waitFor(() => ofType("GENERATION_COMPLETE").length === 1);
      const [chunk] = ofType("AUDIO_CHUNK");
      expect((chunk.audio as Float32Array).length).toBe(2_400 + 24_000);
      expect(chunk.pauseAfterSec).toBe(1);
    });

    it("retries a runaway chunk with a different seed", async () => {
      const { load, dispatch, waitFor, ofType, runtime } = await loadWorker();
      await load();
      runtime.synthesize.mockClear();
      runtime.synthesize.mockResolvedValueOnce({ audio: new Float32Array(100).fill(0.5), reachedStop: false, speechTokens: 1000 });
      dispatch({ type: "GENERATE", generationId: "g1", text: "Hello there.", seed: 9 });
      await waitFor(() => ofType("GENERATION_COMPLETE").length === 1);
      const seeds = runtime.synthesize.mock.calls.map((call) => call[2].sampling.seed);
      expect(seeds).toHaveLength(2);
      expect(seeds[0]).not.toBe(seeds[1]);
    });

    it("does not retry a runaway chunk under greedy decoding, which ignores the seed", async () => {
      const { load, dispatch, waitFor, ofType, runtime } = await loadWorker();
      await load();
      runtime.synthesize.mockClear();
      runtime.synthesize.mockResolvedValue({ audio: new Float32Array(100).fill(0.5), reachedStop: false, speechTokens: 1000 });
      dispatch({ type: "GENERATE", generationId: "g1", text: "Hello there.", seed: 9, temperature: 0 });
      await waitFor(() => ofType("ERROR").length === 1);
      expect(runtime.synthesize).toHaveBeenCalledTimes(1);
    });

    it("gives a digit-heavy chunk a larger token budget than the same count of letters", async () => {
      const { load, dispatch, waitFor, ofType, runtime } = await loadWorker();
      await load();
      runtime.synthesize.mockClear();
      dispatch({ type: "GENERATE", generationId: "g1", text: "Call 0612345678 now." });
      await waitFor(() => ofType("GENERATION_COMPLETE").length === 1);
      const { maxNewTokens } = runtime.synthesize.mock.calls[0][2];
      expect(maxNewTokens).toBeGreaterThan(getChatterboxTokenBudget(14, 0));
    });

    it("skips a chunk that never finishes, completes the rest, then reports the error", async () => {
      const failing: ChatterboxRuntime["synthesize"] = async (text): Promise<ChatterboxSynthesisResult> => ({
        audio: new Float32Array(2_400).fill(0.1),
        reachedStop: !text.startsWith("First"),
        speechTokens: 1,
      });
      const { load, dispatch, waitFor, ofType } = await loadWorker({ synthesize: failing });
      await load();
      dispatch({
        type: "GENERATE",
        generationId: "g1",
        text: `First sentence. ${"Second sentence goes here and is a bit longer than before. ".repeat(6)}`,
      });
      await waitFor(() => ofType("ERROR").length === 1);
      expect(ofType("AUDIO_CHUNK").length).toBeGreaterThan(0);
      expect(ofType("AUDIO_CHUNK").every((chunk) => chunk.total === 0)).toBe(true);
      expect(ofType("ERROR")[0].message).toMatch(/skipped segment\(s\): Chatterbox Turbo did not finish "First sentence/);
      expect(ofType("GENERATION_COMPLETE")).toHaveLength(0);
    });

    it("rejects non-finite audio", async () => {
      const { load, dispatch, waitFor, ofType, runtime } = await loadWorker();
      await load();
      runtime.synthesize.mockResolvedValue({ audio: Float32Array.from([0, Number.NaN]), reachedStop: true, speechTokens: 1 });
      dispatch({ type: "GENERATE", generationId: "g1", text: "Hello there." });
      await waitFor(() => ofType("ERROR").length === 1);
      expect(ofType("ERROR")[0].message).toContain("invalid audio samples");
    });

    it("fails clearly before the model is loaded and on bad input", async () => {
      const { dispatch, waitFor, ofType } = await loadWorker();
      dispatch({ type: "GENERATE", generationId: "g0", text: "Hi." });
      await waitFor(() => ofType("ERROR").length === 1);
      expect(ofType("ERROR")[0]).toMatchObject({ scope: "generate", message: "Chatterbox Turbo is not loaded." });

      dispatch({ type: "LOAD" });
      await waitFor(() => ofType("READY").length === 1);
      dispatch({ type: "GENERATE", generationId: "g1", text: 5 } as unknown as ChatterboxWorkerInMessage);
      await waitFor(() => ofType("ERROR").length === 2);
      expect(ofType("ERROR")[1].message).toBe("GENERATE needs text.");

      dispatch({ type: "GENERATE", generationId: "g2", text: "Hi.", referenceId: "" });
      await waitFor(() => ofType("ERROR").length === 3);
      expect(ofType("ERROR")[2].message).toBe("Invalid reference id.");
    });
  });

  describe("ABORT and CANCEL", () => {
    it("soft-aborts a generation: stops posting, answers ABORTED and stays usable", async () => {
      let release!: () => void;
      let blockNext = false;
      const started = vi.fn();
      const synthesize: ChatterboxRuntime["synthesize"] = async (_text, _conditioning, { shouldStop }) => {
        started(shouldStop);
        if (blockNext) {
          blockNext = false;
          await new Promise<void>((resolve) => { release = resolve; });
        }
        return shouldStop?.()
          ? { audio: new Float32Array(0), reachedStop: false, speechTokens: 0 }
          : { audio: new Float32Array(2_400).fill(0.1), reachedStop: true, speechTokens: 20 };
      };
      const { load, dispatch, waitFor, ofType, posted, worker } = await loadWorker({ synthesize });
      await load();
      started.mockClear();
      blockNext = true;

      dispatch({ type: "GENERATE", generationId: "long", text: `${"A fairly long sentence for the model to read aloud. ".repeat(8)}` });
      await waitFor(() => started.mock.calls.length === 1);
      const shouldStop = started.mock.calls[0][0] as () => boolean;
      expect(shouldStop()).toBe(false);
      dispatch({ type: "ABORT", generationId: "long" });
      expect(shouldStop()).toBe(true);
      release();
      await waitFor(() => ofType("ABORTED").length === 1);

      const abortedAt = posted.findIndex((message) => message.type === "ABORTED");
      expect(posted.slice(abortedAt + 1).filter((message) => message.generationId === "long")).toEqual([]);
      expect(ofType("GENERATION_COMPLETE")).toHaveLength(0);
      expect(ofType("ERROR")).toHaveLength(0);
      expect(worker.close).not.toHaveBeenCalled();

      dispatch({ type: "GENERATE", generationId: "next", text: "Hello there." });
      await waitFor(() => ofType("GENERATION_COMPLETE").length === 1);
      expect(ofType("GENERATION_COMPLETE")[0].generationId).toBe("next");
    });

    it("hard-cancels by posting CANCELLED and closing the worker", async () => {
      const { load, dispatch, ofType, worker } = await loadWorker();
      await load();
      dispatch({ type: "CANCEL" });
      expect(ofType("CANCELLED")).toHaveLength(1);
      expect(worker.close).toHaveBeenCalledTimes(1);
    });
  });
});
