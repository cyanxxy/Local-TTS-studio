import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalBrowserSupport } from "../lib/browserSupport";
import { PlaybackClock } from "../lib/playbackClock";
import type { SynthesisChunk } from "../shared/engineRuntime";
import type { WorkerInMessage, WorkerOutMessage } from "../types";
import type { AudioSegment, UseAudioPlayerReturn } from "./useAudioPlayer";
import { useBrowserEngineRuntimes } from "./useBrowserEngineRuntimes";

class LoadingWorker extends EventTarget {
  static instances: LoadingWorker[] = [];
  posted: WorkerInMessage[] = [];
  terminate = vi.fn();
  onmessage: ((event: MessageEvent<WorkerOutMessage>) => void) | null = null;
  readonly url: string;

  constructor(url: URL) {
    super();
    this.url = String(url);
    LoadingWorker.instances.push(this);
  }

  postMessage(message: WorkerInMessage) {
    this.posted.push(message);
    if (message.type === "LOAD") {
      queueMicrotask(() => this.emit({ type: "READY", voices: ["af_heart", "af_bella"], backend: "webgpu" }));
    }
  }

  emit(message: WorkerOutMessage) {
    const event = new MessageEvent("message", { data: message });
    this.onmessage?.(event);
    this.dispatchEvent(event);
  }

  get generations() {
    return this.posted.filter((message) => message.type === "GENERATE");
  }
}

const SEGMENT: AudioSegment = { id: "seg-1", text: "Retake me please.", startSec: 0, endSec: 1, index: 1, total: 1 };

function createPlayer() {
  return {
    scheduleChunk: vi.fn(async () => undefined),
    beginStream: vi.fn(),
    endStream: vi.fn(),
    reset: vi.fn(),
    stopAll: vi.fn(),
    replaceSegment: vi.fn(),
    segments: [SEGMENT],
    clock: new PlaybackClock(),
  } as unknown as UseAudioPlayerReturn;
}

const SUPPORT: LocalBrowserSupport = {
  isSupported: true,
  isIOS: false,
  message: null,
  supportedModels: ["kokoro", "supertonic"],
  unsupportedModelMessages: {},
};

function renderRuntimes(savedKokoroVoice = "af_heart") {
  const player = createPlayer();
  const setShowPlayer = vi.fn();
  const view = renderHook(() => useBrowserEngineRuntimes({
    activeModel: "kokoro",
    active: true,
    retain: true,
    browserSupport: SUPPORT,
    text: "Enough text for the surface to speak.",
    savedVoices: { kokoro: savedKokoroVoice, supertonic: "Female", kitten: "Bella", paradee: "heart", piper: "en_US-kristin-medium", chatterbox: "chatterbox-default" },
    generationSettings: { speed: 1, quality: 5 },
    player,
    setShowPlayer,
  }));
  return { ...view, player, setShowPlayer };
}

const kokoroWorker = () => LoadingWorker.instances.find((worker) => worker.url.includes("/kokoro.worker"));

describe("useBrowserEngineRuntimes", () => {
  beforeEach(() => {
    LoadingWorker.instances = [];
    vi.stubGlobal("Worker", LoadingWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("drives the surface through the active engine only, and leaves the other idle", async () => {
    const { result, player } = renderRuntimes();
    await waitFor(() => expect(result.current.runtimes.kokoro.canGenerate).toBe(true));
    const { supertonic } = result.current.runtimes;

    expect(supertonic).toMatchObject({ id: "supertonic", canGenerate: false, isGenerating: false, error: null });
    act(() => {
      supertonic.handleGenerate();
      supertonic.cancelActiveGeneration();
      supertonic.resetGeneratedAudio();
    });
    expect(player.reset).not.toHaveBeenCalled();
    expect(kokoroWorker()?.generations).toHaveLength(0);

    act(() => result.current.runtimes.kokoro.handleGenerate());
    expect(player.beginStream).toHaveBeenCalledOnce();
    expect(kokoroWorker()?.generations).toHaveLength(1);
    expect(result.current.runtimes.kokoro.isGenerating).toBe(true);
  });

  it("speaks a voice the loaded model actually has", async () => {
    const { result } = renderRuntimes("af_retired");
    expect(result.current.voicesInUse.kokoro).toBe("af_retired");

    await waitFor(() => expect(result.current.voices.kokoro).toEqual(["af_heart", "af_bella"]));
    expect(result.current.voicesInUse).toMatchObject({ kokoro: "af_heart", supertonic: "Female" });
  });

  it("refuses to start a generation or a retake while a request renders on the same worker", async () => {
    const { result, player } = renderRuntimes();
    await waitFor(() => expect(result.current.runtimes.kokoro.canGenerate).toBe(true));
    const chunks: SynthesisChunk[] = [];
    const request = (async () => {
      for await (const chunk of result.current.runtimes.kokoro.synthesize({
        text: "A preview of the voice.",
        settings: { voice: "af_bella" },
        tuning: { speed: 1, quality: 5 },
      })) chunks.push(chunk);
    })();
    await waitFor(() => expect(kokoroWorker()?.generations).toHaveLength(1));
    expect(result.current.runtimes.kokoro.canGenerate).toBe(false);

    act(() => {
      result.current.runtimes.kokoro.handleGenerate();
      result.current.handleRetakeSegment(SEGMENT.id);
    });
    expect(kokoroWorker()?.generations).toHaveLength(1);
    expect(player.beginStream).not.toHaveBeenCalled();

    const [generation] = kokoroWorker()!.generations as Array<Extract<WorkerInMessage, { type: "GENERATE" }>>;
    expect(generation).toMatchObject({ text: "A preview of the voice.", voice: "af_bella" });
    act(() => {
      kokoroWorker()!.emit({ type: "AUDIO_CHUNK", generationId: generation.generationId, audio: new Float32Array(4), samplingRate: 24_000, text: "A preview of the voice.", index: 1, total: 1 });
      kokoroWorker()!.emit({ type: "GENERATION_COMPLETE", generationId: generation.generationId });
    });
    await request;
    expect(chunks).toHaveLength(1);

    await waitFor(() => expect(result.current.runtimes.kokoro.canGenerate).toBe(true));
    act(() => result.current.handleRetakeSegment(SEGMENT.id));
    expect(kokoroWorker()?.generations).toHaveLength(2);
    expect(result.current.isRetakingSegment).toBe(true);
  });

  it("speaks a Supertonic 2 request in its own language", async () => {
    const { result } = renderRuntimes();
    const request = (async () => {
      for await (const chunk of result.current.runtimes.supertonic.synthesize({
        text: "Bonjour à tous.",
        settings: { voice: "Male", language: "fr" },
        tuning: { speed: 1, quality: 5, language: "en" },
      })) void chunk;
    })();
    const supertonicWorker = () => LoadingWorker.instances.find((worker) => worker.url.includes("/supertonic.worker"));
    await waitFor(() => expect(supertonicWorker()?.generations).toHaveLength(1));

    const [generation] = supertonicWorker()!.generations as Array<Extract<WorkerInMessage, { type: "GENERATE" }>>;
    expect(generation).toMatchObject({ voice: "Male", language: "fr" });
    act(() => supertonicWorker()!.emit({ type: "GENERATION_COMPLETE", generationId: generation.generationId }));
    await request;
  });
});
