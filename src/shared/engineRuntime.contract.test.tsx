import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalTtsAudioChunkEvent, LocalTtsGenerateResult } from "../electron";
import { useQwen3Runtime } from "../contexts/Qwen3RuntimeContext";
import { useAudio8Runtime } from "../hooks/useAudio8Runtime";
import type { UseAudioPlayerReturn } from "../hooks/useAudioPlayer";
import { useBrowserEngineRuntimes } from "../hooks/useBrowserEngineRuntimes";
import { useQwen3LocalRuntime } from "../hooks/useQwen3LocalRuntime";
import { useSupertonic3Runtime } from "../hooks/useSupertonic3Runtime";
import { PlaybackClock } from "../lib/playbackClock";
import type { LocalBrowserSupport } from "../lib/browserSupport";
import type { SurfaceEngineId } from "../models/registry";
import type { WorkerInMessage, WorkerOutMessage } from "../types";
import type { EngineRuntime, Qwen3SynthesisSettings, SynthesisChunk } from "./engineRuntime";

// Every engine runtime must honour the same `synthesize` contract. Each harness
// below drives one runtime's real hook against a fake transport; the suite at
// the bottom runs the same assertions against all of them. (Supertonic 2 runs
// beside Kokoro without driving a surface, so it has no surface to keep idle.)

vi.mock("../contexts/Qwen3RuntimeContext", () => ({ useQwen3Runtime: vi.fn() }));

const TEXT = "A short request, long enough to speak.";
const TUNING = { speed: 1, quality: 5 };

function createPlayer() {
  const methods = {
    scheduleChunk: vi.fn(async () => undefined),
    beginStream: vi.fn(),
    endStream: vi.fn(),
    reset: vi.fn(),
    stopAll: vi.fn(),
    getAudioChunkCount: vi.fn(() => 0),
    getContentEpoch: vi.fn(() => 0),
    truncateAudioChunks: vi.fn(),
  };
  const player = {
    ...methods,
    isPlaying: false,
    clock: new PlaybackClock(),
    getCurrentTime: () => 0,
    totalDuration: 0,
    segments: [],
  } as unknown as UseAudioPlayerReturn;
  return { player, methods };
}

interface Harness {
  /** The runtime under test, as currently rendered. */
  runtime: () => Pick<EngineRuntime, "id" | "canGenerate" | "modelState">;
  /** Calls the runtime's `synthesize` with a request for this engine. */
  synthesize: (signal?: AbortSignal) => AsyncIterable<SynthesisChunk>;
  /** Transport requests started so far (bridge calls, or GENERATE posts). */
  started: () => number;
  /** Finishes the newest transport request with one chunk of audio. */
  complete: () => void;
  /** Fails the newest transport request. */
  fail: (message: string) => void;
  /** How many times the transport was told to stop a request. */
  stops: () => number;
  /** Makes the surface able to generate, for the `canGenerate` checks. */
  ready: () => Promise<void>;
  unmount: () => void;
  playerMethods: ReturnType<typeof createPlayer>["methods"];
  setShowPlayer: ReturnType<typeof vi.fn>;
}

/** A module worker fake: loads at once and records what it is asked to generate. */
class ScriptedWorker extends EventTarget {
  static instances: ScriptedWorker[] = [];
  generations: string[] = [];
  aborts: string[] = [];
  terminate = vi.fn();
  onmessage: ((event: MessageEvent<WorkerOutMessage>) => void) | null = null;
  readonly url: string;

  constructor(url: URL | string = "") {
    super();
    this.url = String(url);
    ScriptedWorker.instances.push(this);
  }

  postMessage(message: WorkerInMessage) {
    if (message.type === "LOAD") {
      queueMicrotask(() => this.emit({ type: "READY", voices: ["af_heart"], backend: "wasm" }));
    } else if (message.type === "GENERATE" && message.generationId) {
      this.generations.push(message.generationId);
    } else if (message.type === "ABORT" && message.generationId) {
      // Like the real worker, which answers once the aborted inference settles.
      const { generationId } = message;
      this.aborts.push(generationId);
      queueMicrotask(() => this.emit({ type: "ABORTED", generationId }));
    }
  }

  emit(message: WorkerOutMessage) {
    const event = new MessageEvent("message", { data: message });
    this.onmessage?.(event);
    this.dispatchEvent(event);
  }

  completeLatest() {
    const generationId = this.generations.at(-1);
    this.emit({ type: "AUDIO_CHUNK", generationId, audio: new Float32Array(8), samplingRate: 24_000, text: TEXT, index: 1, total: 1 });
    this.emit({ type: "GENERATION_COMPLETE", generationId });
  }

  failLatest(message: string) {
    this.emit({ type: "ERROR", message, scope: "generate", generationId: this.generations.at(-1) });
  }
}

function deferredBridgeCalls<Result>() {
  const calls: Array<{ request: { requestId: string }; resolve: (value: Result) => void; reject: (error: unknown) => void }> = [];
  const call = vi.fn((request: { requestId: string }) => new Promise<Result>((resolve, reject) => {
    calls.push({ request, resolve, reject });
  }));
  return { calls, call };
}

function audio8Harness(): Harness {
  const generate = deferredBridgeCalls<{ sampleRate: number; elapsedSec: number; audio: ArrayBuffer }>();
  const bridge = {
    load: vi.fn(async () => ({ sampleRate: 24_000 })),
    generate: generate.call,
    cancel: vi.fn(async () => ({ cancelled: true })),
    getCacheInfo: vi.fn(async () => ({ path: "/cache", exists: true, sizeBytes: 1 })),
    clearCache: vi.fn(),
    subscribeProgress: vi.fn(() => () => undefined),
  };
  Object.defineProperty(window, "electron", { value: { isElectron: true, audio8: bridge }, configurable: true });
  const { player, methods } = createPlayer();
  const setShowPlayer = vi.fn();
  const view = renderHook(() => useAudio8Runtime({
    active: true,
    text: TEXT,
    voice: "clara",
    generationSettings: TUNING,
    player,
    setShowPlayer,
  }));
  return {
    runtime: () => view.result.current,
    synthesize: (signal) => view.result.current.synthesize({ text: TEXT, settings: { voice: "clara" }, tuning: TUNING, signal }),
    started: () => generate.calls.length,
    complete: () => generate.calls.at(-1)?.resolve({ sampleRate: 24_000, elapsedSec: 0.1, audio: new Float32Array(8).buffer }),
    fail: (message) => generate.calls.at(-1)?.reject(new Error(message)),
    stops: () => bridge.cancel.mock.calls.length,
    ready: () => waitFor(() => expect(view.result.current.modelState.ready).toBe(true)),
    unmount: view.unmount,
    playerMethods: methods,
    setShowPlayer,
  };
}

function qwen3Harness(): Harness {
  const listeners = new Set<(event: LocalTtsAudioChunkEvent) => void>();
  const generate = deferredBridgeCalls<LocalTtsGenerateResult>();
  const bridge = {
    probe: vi.fn(async () => ({ ready: true, message: "Ready", runtime: "rust" })),
    generate: generate.call,
    cancel: vi.fn(async () => ({ cancelled: true })),
    subscribeProgress: vi.fn(() => () => undefined),
    subscribeAudioChunk: vi.fn((listener: (event: LocalTtsAudioChunkEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  Object.defineProperty(window, "electron", { value: { isElectron: true, localTts: bridge }, configurable: true });
  const settings: Qwen3SynthesisSettings = {
    profile: { repo: "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice", revision: "r", mode: "customVoice", parameters: "1.7B", provider: "mlx", label: "CustomVoice" },
    modelPath: "/models/qwen3",
    speaker: "Aiden",
    language: "English",
    instruct: "",
    temperature: 0.9,
    topK: 50,
    maxNewTokens: 384,
    seed: null,
    referenceAudioSignature: "",
    referenceText: "",
    referenceAudioBase64: null,
  };
  vi.mocked(useQwen3Runtime).mockReturnValue({
    ...settings,
    readiness: "verified",
    available: true,
    setupBusy: false,
    error: null,
    refreshSetup: vi.fn(async () => undefined),
  } as never);
  const { player, methods } = createPlayer();
  const setShowPlayer = vi.fn();
  const view = renderHook(() => useQwen3LocalRuntime({ enabled: true, text: TEXT, allowLongText: true, player, setShowPlayer }));
  const latest = () => generate.calls.at(-1);
  return {
    runtime: () => view.result.current,
    synthesize: (signal) => view.result.current.synthesize({ text: TEXT, settings, tuning: TUNING, signal }),
    started: () => generate.calls.length,
    complete: () => {
      const call = latest();
      if (!call) return;
      const event: LocalTtsAudioChunkEvent = {
        requestId: call.request.requestId,
        model: "qwen3",
        index: 0,
        total: 1,
        sampleRate: 24_000,
        sampleCount: 8,
        silenceAfterSamples: 0,
        audio: new Float32Array(8).buffer,
      };
      for (const listener of [...listeners]) listener(event);
      call.resolve({
        sampleRate: 24_000,
        modelRepo: settings.profile.repo,
        durationSec: 1,
        elapsedSec: 1,
        audioTransport: "websocket-binary",
        audioChunkCount: 1,
        phaseTimingsSec: {},
      });
    },
    fail: (message) => latest()?.reject(new Error(message)),
    stops: () => bridge.cancel.mock.calls.length,
    ready: () => waitFor(() => expect(view.result.current.modelState.ready).toBe(true)),
    unmount: view.unmount,
    playerMethods: methods,
    setShowPlayer,
  };
}

function supertonic3Harness(): Harness {
  const { player, methods } = createPlayer();
  const setShowPlayer = vi.fn();
  const createWorker = () => new ScriptedWorker() as unknown as Worker;
  // Not on a surface: a request starts and loads the worker on its own.
  const view = renderHook((props: { active: boolean }) => useSupertonic3Runtime({
    available: true,
    active: props.active,
    createWorker,
    text: TEXT,
    voice: "M1",
    language: "en",
    generationSettings: TUNING,
    player,
    setShowPlayer,
  }), { initialProps: { active: false } });
  const worker = () => ScriptedWorker.instances.at(-1);
  return {
    runtime: () => view.result.current,
    synthesize: (signal) => view.result.current.synthesize({ text: TEXT, settings: { voice: "M2", language: "ko" }, tuning: TUNING, signal }),
    started: () => ScriptedWorker.instances.reduce((count, instance) => count + instance.generations.length, 0),
    complete: () => worker()?.completeLatest(),
    fail: (message) => worker()?.failLatest(message),
    stops: () => ScriptedWorker.instances.reduce((count, instance) => count + instance.terminate.mock.calls.length + instance.aborts.length, 0),
    ready: async () => {
      view.rerender({ active: true });
      await waitFor(() => expect(view.result.current.modelState.ready).toBe(true));
    },
    unmount: view.unmount,
    playerMethods: methods,
    setShowPlayer,
  };
}

const BROWSER_SUPPORT: LocalBrowserSupport = {
  isSupported: true,
  isIOS: false,
  message: null,
  supportedModels: ["kokoro", "supertonic"],
  unsupportedModelMessages: {},
};

function browserHarness(engine: "kokoro" | "supertonic"): Harness {
  vi.stubGlobal("Worker", ScriptedWorker);
  const { player, methods } = createPlayer();
  const setShowPlayer = vi.fn();
  // Kokoro is the surface's engine; Supertonic 2 is not selected at all, so
  // its requests also prove the worker loads on demand.
  const view = renderHook(() => useBrowserEngineRuntimes({
    activeModel: "kokoro",
    active: true,
    retain: true,
    browserSupport: BROWSER_SUPPORT,
    text: TEXT,
    savedVoices: {
      kokoro: "af_heart",
      supertonic: "Female",
      kitten: "Bella",
      paradee: "heart",
      piper: "en_US-kristin-medium",
    },
    generationSettings: TUNING,
    player,
    setShowPlayer,
  }));
  const worker = () => ScriptedWorker.instances.filter((instance) => instance.url.includes(`/${engine}.worker`)).at(-1);
  return {
    runtime: () => view.result.current.runtimes[engine],
    synthesize: (signal) => (engine === "kokoro"
      ? view.result.current.runtimes.kokoro.synthesize({ text: TEXT, settings: { voice: "af_heart" }, tuning: TUNING, signal })
      : view.result.current.runtimes.supertonic.synthesize({
          text: TEXT,
          settings: { voice: "Female", language: "en" },
          tuning: TUNING,
          signal,
        })),
    started: () => ScriptedWorker.instances.reduce((count, instance) => count + instance.generations.length, 0),
    complete: () => worker()?.completeLatest(),
    fail: (message) => worker()?.failLatest(message),
    stops: () => ScriptedWorker.instances.reduce((count, instance) => count + instance.terminate.mock.calls.length + instance.aborts.length, 0),
    ready: () => waitFor(() => expect(view.result.current.runtimes.kokoro.modelState.ready).toBe(true)),
    unmount: view.unmount,
    playerMethods: methods,
    setShowPlayer,
  };
}

const HARNESSES: Array<[SurfaceEngineId, () => Harness]> = [
  ["kokoro", () => browserHarness("kokoro")],
  ["supertonic", () => browserHarness("supertonic")],
  ["audio8", audio8Harness],
  ["supertonic3", supertonic3Harness],
  ["qwen3", qwen3Harness],
];

/** Collects a request's chunks, or its rejection, without throwing. */
function track(iterable: AsyncIterable<SynthesisChunk>) {
  const chunks: SynthesisChunk[] = [];
  let error: unknown;
  let done = false;
  const finished = (async () => {
    try {
      for await (const chunk of iterable) chunks.push(chunk);
    } catch (cause) {
      error = cause;
    } finally {
      done = true;
    }
  })();
  return { chunks, finished, error: () => error, done: () => done };
}

describe.each(HARNESSES)("%s EngineRuntime contract", (engine, createHarness) => {
  let harness: Harness;

  beforeEach(() => {
    ScriptedWorker.instances = [];
    harness = createHarness();
  });

  afterEach(() => {
    harness.unmount();
    vi.unstubAllGlobals();
    delete window.electron;
  });

  it("identifies itself and renders a request without touching the shared player", async () => {
    expect(harness.runtime().id).toBe(engine);
    // Mounting may reset the player (a runtime clears stale audio it owns);
    // only what the request does counts here.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    for (const method of Object.values(harness.playerMethods)) method.mockClear();
    harness.setShowPlayer.mockClear();
    const request = track(harness.synthesize());

    await waitFor(() => expect(harness.started()).toBe(1));
    act(() => harness.complete());
    await request.finished;

    expect(request.error()).toBeUndefined();
    expect(request.chunks.length).toBeGreaterThan(0);
    expect(request.chunks[0].audio).toBeInstanceOf(Float32Array);
    expect(request.chunks[0].samplingRate).toBe(24_000);
    for (const method of Object.values(harness.playerMethods)) expect(method).not.toHaveBeenCalled();
    expect(harness.setShowPlayer).not.toHaveBeenCalled();
  });

  it("runs requests one at a time, in the order they were made", async () => {
    const first = track(harness.synthesize());
    const second = track(harness.synthesize());

    await waitFor(() => expect(harness.started()).toBe(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(harness.started()).toBe(1);
    expect(second.done()).toBe(false);

    act(() => harness.complete());
    await first.finished;
    await waitFor(() => expect(harness.started()).toBe(2));
    expect(second.done()).toBe(false);
    act(() => harness.complete());
    await second.finished;

    expect(first.error()).toBeUndefined();
    expect(second.error()).toBeUndefined();
  });

  it("stops a running request when its signal aborts, then serves the next", async () => {
    const controller = new AbortController();
    const running = track(harness.synthesize(controller.signal));
    const next = track(harness.synthesize());
    await waitFor(() => expect(harness.started()).toBe(1));
    const stopsBefore = harness.stops();

    act(() => controller.abort(new Error("Preview closed.")));
    await running.finished;

    expect(running.error()).toEqual(new Error("Preview closed."));
    expect(harness.stops()).toBeGreaterThan(stopsBefore);
    await waitFor(() => expect(harness.started()).toBe(2));
    act(() => harness.complete());
    await next.finished;
    expect(next.error()).toBeUndefined();
  });

  it.skipIf(!["kokoro", "supertonic", "supertonic3"].includes(engine))(
    "aborts a stopped request on its worker without closing the worker or reloading the model",
    async () => {
      const controller = new AbortController();
      const running = track(harness.synthesize(controller.signal));
      await waitFor(() => expect(harness.started()).toBe(1));

      act(() => controller.abort(new Error("Preview closed.")));
      await running.finished;

      const workers = ScriptedWorker.instances;
      expect(workers.flatMap((worker) => worker.aborts)).toHaveLength(1);
      expect(workers.flatMap((worker) => worker.terminate.mock.calls)).toHaveLength(0);
      const count = workers.length;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(ScriptedWorker.instances).toHaveLength(count);
    },
  );

  it("drops a queued request whose signal aborts before its turn", async () => {
    const controller = new AbortController();
    const running = track(harness.synthesize());
    const queued = track(harness.synthesize(controller.signal));
    await waitFor(() => expect(harness.started()).toBe(1));

    controller.abort(new Error("Not needed."));
    await queued.finished;
    expect(queued.error()).toEqual(new Error("Not needed."));

    act(() => harness.complete());
    await running.finished;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(harness.started()).toBe(1);
  });

  it("fails only the request that failed", async () => {
    const failing = track(harness.synthesize());
    const healthy = track(harness.synthesize());
    await waitFor(() => expect(harness.started()).toBe(1));

    act(() => harness.fail("The voice could not be rendered."));
    await failing.finished;
    expect(failing.error()).toBeInstanceOf(Error);
    expect((failing.error() as Error).message).toContain("The voice could not be rendered.");

    await waitFor(() => expect(harness.started()).toBe(2));
    act(() => harness.complete());
    await healthy.finished;
    expect(healthy.error()).toBeUndefined();
  });

  it.skipIf(engine === "supertonic")("keeps the surface from generating while a request runs", async () => {
    await harness.ready();
    await waitFor(() => expect(harness.runtime().canGenerate).toBe(true));

    const request = track(harness.synthesize());
    await waitFor(() => expect(harness.runtime().canGenerate).toBe(false));
    await waitFor(() => expect(harness.started()).toBe(1));

    act(() => harness.complete());
    await request.finished;
    await waitFor(() => expect(harness.runtime().canGenerate).toBe(true));
  });

  it("aborts every pending request when the engine unmounts", async () => {
    const running = track(harness.synthesize());
    const queued = track(harness.synthesize());
    await waitFor(() => expect(harness.started()).toBe(1));

    harness.unmount();
    await Promise.all([running.finished, queued.finished]);

    expect(running.error()).toBeInstanceOf(DOMException);
    expect(queued.error()).toBeInstanceOf(DOMException);
    harness.unmount = () => undefined;
  });
});
