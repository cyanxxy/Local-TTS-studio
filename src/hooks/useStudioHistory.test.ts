import { act, render, renderHook, waitFor } from "@testing-library/react";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { createElement, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGenerationHistoryStore, type GenerationHistoryStore } from "../lib/history/generationHistory";
import type { SynthesisSession } from "../shared/useSynthesisSessionState";
import { createStudioHarness, pcmChunk } from "./studioSession.testkit";
import { useAudioPlayer, type UseAudioPlayerReturn } from "./useAudioPlayer";
import { useGenerationHistory, type UseGenerationHistoryReturn } from "./useGenerationHistory";
import { useStudioAudioKeeper } from "./useStudioAudioKeeper";
import { useStudioHistory } from "./useStudioHistory";

const downloadAudioChunks = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../lib/audioExportClient", () => ({ downloadAudioChunks }));

const qwen3 = vi.hoisted(() => ({
  setSpeaker: vi.fn(),
  setLanguage: vi.fn(),
  setInstruct: vi.fn(),
  setSeed: vi.fn(),
}));
vi.mock("../contexts/Qwen3RuntimeContext", () => ({ useQwen3Runtime: () => qwen3 }));

describe("useStudioHistory", () => {
  let store: GenerationHistoryStore;

  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    downloadAudioChunks.mockClear();
    Object.values(qwen3).forEach((mock) => mock.mockClear());
    let ids = 0;
    store = createGenerationHistoryStore({ createId: () => `gen-${++ids}` });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function setup(initial: Parameters<typeof createStudioHarness>[0] = {}, limited: GenerationHistoryStore = store) {
    const harness = createStudioHarness({ cacheSnapshot: [pcmChunk(400)], ...initial });
    const hook = renderHook(() => {
      const history = useGenerationHistory(limited);
      return { history, studio: useStudioHistory({ session: harness.session(), history }) };
    });
    return { harness, ...hook };
  }

  async function finishGeneration(harness: ReturnType<typeof createStudioHarness>, rerender: () => void) {
    harness.state.isSynthesisComplete = true;
    rerender();
  }

  it("saves a generation that completes, with its text, engine, voice, settings and audio", async () => {
    const { harness, result, rerender } = setup();
    await waitFor(() => expect(result.current.history.loading).toBe(false));

    await finishGeneration(harness, rerender);

    await waitFor(() => expect(result.current.history.entries).toHaveLength(1));
    const [entry] = result.current.history.entries;
    expect(entry).toMatchObject({
      text: "Hello from the studio.",
      engineId: "kokoro",
      voice: { engineId: "kokoro", voiceId: "af_heart" },
      settings: { speed: 1, quality: 8 },
      completed: true,
      chunkCount: 1,
    });
    expect(await result.current.history.loadAudio(entry.id)).toHaveLength(1);
    expect(result.current.history.usage.entryCount).toBe(1);
  });

  it("records the seed of a seeded engine", async () => {
    const { harness, result, rerender } = setup({ engineId: "qwen3" });
    await waitFor(() => expect(result.current.history.loading).toBe(false));
    await finishGeneration(harness, rerender);
    await waitFor(() => expect(result.current.history.entries).toHaveLength(1));
    expect(result.current.history.entries[0]).toMatchObject({ engineId: "qwen3", voice: { voiceId: "Ryan" } });
  });

  it("does not save audio that was already complete, or audio it just restored", async () => {
    const { harness, result, rerender } = setup({ isSynthesisComplete: true });
    await waitFor(() => expect(result.current.history.loading).toBe(false));
    rerender();
    expect(result.current.history.entries).toHaveLength(0);

    const saved = await result.current.history.saveGeneration({
      text: "Saved earlier.", engineId: "kokoro", voice: { engineId: "kokoro", voiceId: "af_heart", settings: {} }, chunks: [pcmChunk(100)],
    });
    harness.state.isSynthesisComplete = false;
    rerender();
    await act(async () => { await result.current.studio.replay(saved.id); });
    harness.state.isSynthesisComplete = true;
    rerender();

    await waitFor(() => expect(result.current.history.entries).toHaveLength(1));
    expect(result.current.history.entries.map((entry) => entry.text)).toEqual(["Saved earlier."]);
  });

  it("saves the text and voice the generation started with, not later edits", async () => {
    const { harness, result, rerender } = setup();
    await waitFor(() => expect(result.current.history.loading).toBe(false));

    harness.state.isGenerating = true;
    rerender();
    harness.state.text = "Edited while it was generating.";
    harness.state.isGenerating = false;
    harness.state.isSynthesisComplete = true;
    rerender();

    await waitFor(() => expect(result.current.history.entries).toHaveLength(1));
    expect(result.current.history.entries[0].text).toBe("Hello from the studio.");
  });

  it("drops a pending reuse whose engine never became active", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { harness, result, rerender } = setup({ engineId: "supertonic" });
      await waitFor(() => expect(result.current.history.loading).toBe(false));
      const saved = await result.current.history.saveGeneration({
        text: "Kokoro script.", engineId: "kokoro", voice: { engineId: "kokoro", voiceId: "bm_george", settings: {} }, chunks: [pcmChunk(100)],
      });
      await act(async () => { await result.current.studio.reuse(saved.id); });
      await act(async () => { await vi.advanceTimersByTimeAsync(6000); });

      harness.state.engineId = "kokoro";
      rerender();
      expect(harness.calls.changeText).not.toHaveBeenCalled();
      expect(harness.calls.changeVoice).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("replays stored audio into the player and starts it", async () => {
    const { harness, result } = setup();
    await waitFor(() => expect(result.current.history.loading).toBe(false));
    const saved = await result.current.history.saveGeneration({
      text: "Replay me.", engineId: "kokoro", voice: { engineId: "kokoro", voiceId: "af_heart", settings: {} }, chunks: [pcmChunk(100)],
    });

    await act(async () => { await result.current.studio.replay(saved.id); });

    expect(harness.calls.cancelActiveGeneration).toHaveBeenCalled();
    expect(harness.calls.restoreAudioCache).toHaveBeenCalledWith([expect.objectContaining({ samplingRate: 100 })], { synthesisComplete: true });
    expect(harness.calls.setShow).toHaveBeenCalledWith(true);
    expect(harness.calls.togglePlay).toHaveBeenCalled();
    expect(result.current.studio.error).toBeNull();

    await act(async () => { await result.current.studio.replay("missing"); });
    expect(result.current.studio.error).toMatch(/no longer stored/);
  });

  it("downloads through the export path with the Creator export settings", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.history.loading).toBe(false));
    const saved = await result.current.history.saveGeneration({
      text: "Export me.", engineId: "kokoro", voice: { engineId: "kokoro", voiceId: "af_heart", settings: {} }, chunks: [pcmChunk(100)],
    });

    await act(async () => { await result.current.studio.download(saved); });

    expect(downloadAudioChunks).toHaveBeenCalledWith(
      [expect.objectContaining({ samplingRate: 100 })],
      expect.objectContaining({ format: "wav-pcm16" }),
      { fileName: expect.stringMatching(/^open-tts-\d{4}-\d{2}-\d{2}-\d{4}-export-me$/) },
    );
  });

  it("reuses text, voice and tuning on the current engine", async () => {
    const { harness, result } = setup();
    await waitFor(() => expect(result.current.history.loading).toBe(false));
    const saved = await result.current.history.saveGeneration({
      text: "Reuse this script.",
      engineId: "kokoro",
      voice: { engineId: "kokoro", voiceId: "bf_emma", settings: { speed: 1.2 } },
      chunks: [pcmChunk(100)],
    });

    await act(async () => { await result.current.studio.reuse(saved.id); });

    expect(harness.calls.changeText).toHaveBeenCalledWith("Reuse this script.");
    expect(harness.calls.changeVoice).toHaveBeenCalledWith("bf_emma");
    expect(harness.calls.onSpeedChange).toHaveBeenCalledWith(1.2);
    expect(harness.calls.changeModel).not.toHaveBeenCalled();
  });

  it("explains when the saved desktop engine is not available on this device", async () => {
    const { harness, result } = setup();
    await waitFor(() => expect(result.current.history.loading).toBe(false));
    const saved = await result.current.history.saveGeneration({
      text: "Other engine.",
      engineId: "supertonic3",
      voice: { engineId: "supertonic3", voiceId: "F2", settings: { language: "fr", quality: 5 } },
      chunks: [pcmChunk(100)],
    });

    await act(async () => { await result.current.studio.reuse(saved.id); });
    expect(harness.calls.changeModel).not.toHaveBeenCalled();
    expect(harness.calls.changeText).not.toHaveBeenCalled();
    expect(harness.calls.selectDesktop).not.toHaveBeenCalled();
    expect(result.current.studio.error).toMatch(/not available on this device/);
  });

  it("switches a browser engine, then applies the saved settings", async () => {
    const { harness, result, rerender } = setup({ engineId: "supertonic" });
    await waitFor(() => expect(result.current.history.loading).toBe(false));
    const saved = await result.current.history.saveGeneration({
      text: "Kokoro script.",
      engineId: "kokoro",
      voice: { engineId: "kokoro", voiceId: "bm_george", settings: { speed: 0.9 } },
      chunks: [pcmChunk(100)],
    });

    await act(async () => { await result.current.studio.reuse(saved.id); });
    expect(harness.calls.changeModel).toHaveBeenCalledWith("kokoro");
    expect(harness.calls.changeVoice).not.toHaveBeenCalled();

    harness.state.engineId = "kokoro";
    rerender();
    expect(harness.calls.changeText).toHaveBeenCalledWith("Kokoro script.");
    expect(harness.calls.changeVoice).toHaveBeenCalledWith("bm_george");
    expect(harness.calls.onSpeedChange).toHaveBeenCalledWith(0.9);
  });

  it("selects an available desktop engine and refuses an unavailable one", async () => {
    const { harness, result, rerender } = setup();
    harness.desktopEngines = ["qwen3"];
    await waitFor(() => expect(result.current.history.loading).toBe(false));
    const qwenEntry = await result.current.history.saveGeneration({
      text: "Seeded.",
      engineId: "qwen3",
      voice: { engineId: "qwen3", voiceId: "Aiden", settings: { language: "German", instruction: "calm" } },
      seed: 1234,
      chunks: [pcmChunk(100)],
    });
    const audio8Entry = await result.current.history.saveGeneration({
      text: "Audio eight.", engineId: "audio8", voice: { engineId: "audio8", voiceId: "narrator", settings: {} }, chunks: [pcmChunk(100)],
    });

    await act(async () => { await result.current.studio.reuse(qwenEntry.id); });
    expect(harness.calls.selectDesktop).toHaveBeenCalledWith("qwen3");
    harness.state.engineId = "qwen3";
    rerender();
    expect(qwen3.setSpeaker).toHaveBeenCalledWith("Aiden");
    expect(qwen3.setLanguage).toHaveBeenCalledWith("German");
    expect(qwen3.setInstruct).toHaveBeenCalledWith("calm");
    expect(qwen3.setSeed).toHaveBeenCalledWith(1234);

    await act(async () => { await result.current.studio.reuse(audio8Entry.id); });
    expect(result.current.studio.error).toMatch(/not available/);
  });

  it("keeps history within its count limit and protects favorites when saving", async () => {
    const limited = createGenerationHistoryStore({ createId: (() => { let n = 0; return () => `lim-${++n}`; })(), maxEntries: 2, maxFavoriteEntries: 1 });
    const { harness, result, rerender } = setup({}, limited);
    await waitFor(() => expect(result.current.history.loading).toBe(false));

    const save = async (text: string) => {
      harness.state.text = text;
      harness.state.isSynthesisComplete = false;
      rerender();
      harness.state.isSynthesisComplete = true;
      rerender();
    };
    await save("First take of the day.");
    await waitFor(() => expect(result.current.history.entries).toHaveLength(1));
    await act(async () => { await result.current.history.setFavorite(result.current.history.entries[0].id, true); });
    await save("Second take of the day.");
    await waitFor(() => expect(result.current.history.entries).toHaveLength(2));
    await save("Third take of the day.");
    await waitFor(() => expect(result.current.history.entries.map((entry) => entry.text)).toEqual([
      "Third take of the day.",
      "First take of the day.",
    ]));
    expect(result.current.history.usage).toMatchObject({ entryCount: 2, favoriteCount: 1 });

    await act(async () => { await result.current.history.clear({ keepFavorites: true }); });
    await waitFor(() => expect(result.current.history.entries.map((entry) => entry.text)).toEqual(["First take of the day."]));
  });
});

// Web Audio stand-ins for the real player, as in useAudioPlayer.test.ts.
class MockAudioBuffer {
  public readonly duration: number;
  private readonly channelData: Float32Array;
  constructor(length: number, sampleRate: number) {
    this.duration = length / sampleRate;
    this.channelData = new Float32Array(length);
  }
  getChannelData(): Float32Array {
    return this.channelData;
  }
}
class MockAudioBufferSourceNode {
  public buffer: MockAudioBuffer | null = null;
  public playbackRate = { value: 1 };
  public onended: (() => void) | null = null;
  connect(): void {}
  disconnect(): void {}
  start(): void {}
  stop(): void {}
}
class MockAudioContext {
  public currentTime = 0;
  public state: "running" | "suspended" | "closed" = "running";
  public readonly destination = {};
  public baseLatency = 0;
  resume = vi.fn(async () => { this.state = "running"; });
  suspend = vi.fn(async () => { this.state = "suspended"; });
  close = vi.fn(async () => { this.state = "closed"; });
  addEventListener(): void {}
  removeEventListener(): void {}
  createBuffer(_channels: number, length: number, sampleRate: number) {
    return new MockAudioBuffer(length, sampleRate);
  }
  createBufferSource() {
    return new MockAudioBufferSourceNode();
  }
}

describe("useStudioHistory with the shared player across a Reader visit", () => {
  beforeEach(() => {
    vi.stubGlobal("AudioContext", MockAudioContext as unknown as typeof AudioContext);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16) as unknown as number);
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not save Studio's audio a second time when it is put back after Studio -> Reader -> Studio", async () => {
    let ids = 0;
    const store = createGenerationHistoryStore({ createId: () => `gen-${++ids}` });
    const handles: { player?: UseAudioPlayerReturn; keep?: () => void; history?: UseGenerationHistoryReturn } = {};

    // StudioSurface: mounted only while Studio is the page.
    function Studio({ session }: { session: SynthesisSession }) {
      const history = useGenerationHistory(store);
      useStudioHistory({ session, history });
      handles.history = history;
      return null;
    }
    // The session provider: the one player and the keeper.
    function App({ page }: { page: "studio" | "reader" }) {
      const player = useAudioPlayer();
      const [, setShow] = useState(false);
      const keeper = useStudioAudioKeeper({ isStudioPage: page === "studio", player, setShowPlayer: setShow });
      handles.player = player;
      handles.keep = keeper.keepStudioAudio;
      const session = {
        player: { state: player, setShow, isPutBackStudioAudio: keeper.isPutBackStudioAudio },
        studio: { text: "Hello from the studio.", engineId: "kokoro", runtime: { isGenerating: false } },
        engines: { surfaceEngineSettings: { kokoro: { voice: "af_heart" } } },
        creator: { generationSettings: { speed: 1, quality: 8 } },
      } as unknown as SynthesisSession;
      return page === "studio" ? createElement(Studio, { session }) : null;
    }

    const view = render(createElement(App, { page: "studio" }));
    await waitFor(() => expect(handles.history?.loading).toBe(false));

    // A Studio generation streams and completes: saved once.
    await act(async () => {
      handles.player!.beginStream();
      await handles.player!.scheduleChunk({ audio: new Float32Array(100).fill(0.2), samplingRate: 100, text: "Hello from the studio.", index: 1, total: 1 });
      handles.player!.endStream({ completed: true });
    });
    await waitFor(() => expect(handles.history?.entries).toHaveLength(1));

    // The Reader keeps Studio's audio and empties the player for its section.
    view.rerender(createElement(App, { page: "reader" }));
    act(() => {
      handles.keep!();
      handles.player!.reset();
    });

    // Back to Studio: the keeper puts Studio's audio back, complete.
    view.rerender(createElement(App, { page: "studio" }));
    await waitFor(() => expect(handles.player!.isSynthesisComplete).toBe(true));
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 200)));
    await act(async () => { await handles.history!.refresh(); });

    expect(handles.history!.entries).toHaveLength(1);

    // A generation made after the visit is still saved.
    act(() => handles.player!.reset());
    await act(async () => {
      handles.player!.beginStream();
      await handles.player!.scheduleChunk({ audio: new Float32Array(100).fill(0.3), samplingRate: 100, text: "Hello from the studio.", index: 1, total: 1 });
      handles.player!.endStream({ completed: true });
    });
    await waitFor(() => expect(handles.history?.entries).toHaveLength(2));
  });
});
