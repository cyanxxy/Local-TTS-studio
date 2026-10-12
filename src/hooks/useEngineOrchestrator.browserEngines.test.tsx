import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalBrowserSupport } from "../lib/browserSupport";
import { PlaybackClock } from "../lib/playbackClock";
import { BROWSER_ENGINE_IDS, type BrowserEngineId } from "../models/registry";
import type { EngineRuntime, SynthesisChunk } from "../shared/engineRuntime";
import type { WorkerInMessage, WorkerOutMessage } from "../types";
import type { UseAudioPlayerReturn } from "./useAudioPlayer";
import { useEngineOrchestrator, type OrchestratedEngineSettings } from "./useEngineOrchestrator";

// Kitten, Paradee and Piper run through the real browser worker pool, surface
// generation path and synthesize queue behind the real orchestrator. Only the
// module workers (scripted below) and the desktop/native runtimes are faked.

vi.mock("./useAudio8Runtime", () => ({ useAudio8Runtime: () => ({ id: "audio8", cancelActiveGeneration: vi.fn(), resetGeneratedAudio: vi.fn() }) }));
vi.mock("./useSupertonic3Runtime", () => ({ useSupertonic3Runtime: () => ({ id: "supertonic3", cancelActiveGeneration: vi.fn(), resetGeneratedAudio: vi.fn() }) }));
vi.mock("./useQwen3LocalRuntime", () => ({ useQwen3LocalRuntime: () => ({ id: "qwen3", cancelActiveGeneration: vi.fn(), resetGeneratedAudio: vi.fn() }) }));
vi.mock("../contexts/Qwen3RuntimeContext", () => ({
  useQwen3Runtime: () => ({ available: false, profile: { mode: "customVoice" }, speaker: "Aiden" }),
}));

const TEXT = "A sentence long enough for every engine to speak aloud.";
const TUNING = { speed: 1.1, quality: 5 };
const SUPPORT: LocalBrowserSupport = {
  isSupported: true,
  isIOS: false,
  message: null,
  supportedModels: BROWSER_ENGINE_IDS,
  unsupportedModelMessages: {},
};

const NEW_ENGINES = ["kitten", "paradee", "piper"] as const satisfies readonly BrowserEngineId[];
type NewEngine = (typeof NEW_ENGINES)[number];

/** The voice each engine is set to speak, and what its worker reports at LOAD. */
const SETUP: Record<NewEngine, { voice: string; samplingRate: number; reported: string[]; backend: "wasm" | "webgpu" }> = {
  kitten: { voice: "Luna", samplingRate: 24_000, reported: ["Bella", "Luna"], backend: "webgpu" },
  paradee: { voice: "heart", samplingRate: 24_000, reported: ["heart"], backend: "wasm" },
  piper: { voice: "en_US-libritts-high#12", samplingRate: 22_050, reported: ["en_US-libritts-high"], backend: "wasm" },
};

const ENGINE_SETTINGS: OrchestratedEngineSettings = {
  kokoro: { voice: "af_heart" },
  supertonic: { voice: "Female", language: "en" },
  kitten: { voice: SETUP.kitten.voice },
  paradee: { voice: SETUP.paradee.voice },
  piper: { voice: SETUP.piper.voice },
  audio8: { voice: "clara" },
  supertonic3: { voice: "M1", language: "en" },
};

class ScriptedWorker extends EventTarget {
  static instances: ScriptedWorker[] = [];
  posted: WorkerInMessage[] = [];
  terminate = vi.fn();
  onmessage: ((event: MessageEvent<WorkerOutMessage>) => void) | null = null;
  readonly engine: string;

  constructor(url: URL | string) {
    super();
    this.engine = /\/(\w+)\.worker/.exec(String(url))?.[1] ?? "unknown";
    ScriptedWorker.instances.push(this);
  }

  postMessage(message: WorkerInMessage) {
    this.posted.push(message);
    if (message.type === "LOAD") {
      const setup = SETUP[this.engine as NewEngine];
      queueMicrotask(() => this.emit({
        type: "READY",
        voices: setup?.reported ?? ["af_heart"],
        backend: setup?.backend ?? "wasm",
      }));
    } else if (message.type === "ABORT") {
      const { generationId } = message;
      queueMicrotask(() => this.emit({ type: "ABORTED", generationId }));
    }
  }

  emit(message: WorkerOutMessage) {
    const event = new MessageEvent("message", { data: message });
    this.onmessage?.(event);
    this.dispatchEvent(event);
  }

  get loads() {
    return this.posted.filter((message) => message.type === "LOAD");
  }

  get generations() {
    return this.posted.filter((message) => message.type === "GENERATE");
  }

  /** Answers the newest GENERATE with one passage of audio, then completes it. */
  finishLatest(samplingRate: number) {
    const generationId = this.generations.at(-1)?.generationId;
    this.emit({
      type: "AUDIO_CHUNK",
      generationId,
      audio: new Float32Array(16),
      samplingRate,
      text: TEXT,
      index: 1,
      total: 1,
      textStart: 0,
      textEnd: TEXT.length,
    });
    this.emit({ type: "GENERATION_COMPLETE", generationId });
  }
}

function createPlayer() {
  return {
    scheduleChunk: vi.fn(async () => undefined),
    beginStream: vi.fn(),
    endStream: vi.fn(),
    reset: vi.fn(),
    stopAll: vi.fn(),
    replaceSegment: vi.fn(),
    segments: [],
    clock: new PlaybackClock(),
  } as unknown as UseAudioPlayerReturn;
}

function renderOrchestrator(model: BrowserEngineId) {
  const player = createPlayer();
  const setShowPlayer = vi.fn();
  const view = renderHook(() => useEngineOrchestrator({
    surface: "studio",
    desktopRuntimesAvailable: false,
    enableDesktopRuntimes: false,
    browserSupport: SUPPORT,
    debugProfiling: false,
    initialState: { model, desktopModels: { studio: null, reader: null } },
    text: TEXT,
    engineSettings: ENGINE_SETTINGS,
    generationSettings: TUNING,
    player,
    setShowPlayer,
    beforeReaderAudioChange: vi.fn(),
    onEngineChange: vi.fn(),
  }));
  const worker = (engine: string) => ScriptedWorker.instances.filter((instance) => instance.engine === engine).at(-1);
  return { ...view, player, setShowPlayer, worker };
}

async function collect(iterable: AsyncIterable<SynthesisChunk>) {
  const chunks: SynthesisChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

describe("Kitten, Paradee and Piper through the engine orchestrator", () => {
  beforeEach(() => {
    ScriptedWorker.instances = [];
    vi.stubGlobal("Worker", ScriptedWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe.each(NEW_ENGINES)("%s", (engine) => {
    const { voice, samplingRate, reported, backend } = SETUP[engine];

    it("loads its worker with its saved voice and reports the voices the model has", async () => {
      const { result, worker } = renderOrchestrator(engine);

      await waitFor(() => expect(result.current.runtimes[engine].modelState.ready).toBe(true));

      expect(worker(engine)?.loads).toHaveLength(1);
      // Piper downloads the voice it will speak first; the others have one model to fetch.
      expect(worker(engine)?.loads[0]).toMatchObject(engine === "piper" ? { preferredVoice: voice } : {});
      expect(result.current.runtimes[engine].modelState.backend).toBe(backend);
      expect(result.current.browser.voices[engine]).toEqual(reported);
      expect(result.current.surfaceEngineSettings[engine]).toEqual({ voice });
      expect(ScriptedWorker.instances.filter((instance) => instance.engine !== engine)).toHaveLength(0);
    });

    it("generates the surface's audio into the shared player with its voice and the Creator tuning", async () => {
      const { result, player, setShowPlayer, worker } = renderOrchestrator(engine);
      await waitFor(() => expect(result.current.runtimes[engine].canGenerate).toBe(true));

      act(() => result.current.runtimes[engine].handleGenerate());

      expect(player.beginStream).toHaveBeenCalledOnce();
      expect(setShowPlayer).toHaveBeenCalledWith(true);
      await waitFor(() => expect(worker(engine)?.generations).toHaveLength(1));
      expect(worker(engine)?.generations[0]).toMatchObject({ text: TEXT, voice, speed: 1.1 });
      expect(result.current.runtimes[engine].isGenerating).toBe(true);

      act(() => worker(engine)?.finishLatest(samplingRate));

      await waitFor(() => expect(result.current.runtimes[engine].isGenerating).toBe(false));
      expect(player.scheduleChunk).toHaveBeenCalledWith(expect.objectContaining({
        samplingRate,
        text: TEXT,
        textStart: 0,
        textEnd: TEXT.length,
      }));
      expect(player.endStream).toHaveBeenCalledWith({ completed: true });
      expect(result.current.runtimes[engine].error).toBeNull();
    });

    it("synthesizes a request with the request's own voice, leaving the player alone", async () => {
      const { result, player, worker } = renderOrchestrator(engine);
      await waitFor(() => expect(result.current.runtimes[engine].modelState.ready).toBe(true));
      const runtime = result.current.runtimes[engine] as EngineRuntime<NewEngine>;
      const otherVoice = engine === "kitten" ? "Leo" : engine === "piper" ? "en_GB-cori-high" : "heart";
      vi.mocked(player.beginStream).mockClear();

      const pending = collect(runtime.synthesize({ text: TEXT, settings: { voice: otherVoice }, tuning: TUNING }));
      await waitFor(() => expect(worker(engine)?.generations).toHaveLength(1));
      expect(worker(engine)?.generations[0]).toMatchObject({ text: TEXT, voice: otherVoice, speed: 1.1 });
      act(() => worker(engine)?.finishLatest(samplingRate));

      const chunks = await pending;
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({ samplingRate, text: TEXT, index: 1, total: 1 });
      expect(player.beginStream).not.toHaveBeenCalled();
      expect(player.scheduleChunk).not.toHaveBeenCalled();
    });

    it("becomes the surface's engine when the picker selects it", async () => {
      const { result, worker } = renderOrchestrator("kokoro");
      await waitFor(() => expect(result.current.runtimes.kokoro.modelState.ready).toBe(true));
      expect(worker(engine)).toBeUndefined();

      act(() => result.current.selectBrowserModel("studio", engine));

      expect(result.current.activeModel).toBe(engine);
      expect(result.current.engineIds.studio).toBe(engine);
      await waitFor(() => expect(result.current.runtimes[engine].modelState.ready).toBe(true));
      expect(worker(engine)?.loads).toHaveLength(1);
    });
  });

  it("downloads a Piper voice the user switches to, and shows that download on the model", async () => {
    const { result, worker } = renderOrchestrator("piper");
    await waitFor(() => expect(result.current.runtimes.piper.modelState.ready).toBe(true));

    act(() => worker("piper")?.emit({ type: "LOAD_PROGRESS", percent: 40 }));
    expect(result.current.runtimes.piper.modelState).toMatchObject({ ready: true, loading: true, downloadProgress: 40, backend: "wasm" });

    act(() => worker("piper")?.emit({ type: "LOAD_PROGRESS", percent: 100 }));
    expect(result.current.runtimes.piper.modelState).toMatchObject({ ready: true, loading: false, downloadProgress: 100, backend: "wasm" });
  });
});
