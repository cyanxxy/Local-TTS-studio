import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalBrowserSupport } from "../lib/browserSupport";
import { createPronunciationDictionary } from "../lib/pronunciation/dictionary";
import type { SurfaceEngineId } from "../models/registry";
import type { SpeechPipelineChoices } from "../shared/speechPipelineRuntime";
import type { UseAudioPlayerReturn } from "./useAudioPlayer";
import { useAudio8Runtime } from "./useAudio8Runtime";
import { useBrowserEngineRuntimes } from "./useBrowserEngineRuntimes";
import { useEngineOrchestrator, type Surface } from "./useEngineOrchestrator";
import { useQwen3LocalRuntime } from "./useQwen3LocalRuntime";
import { useSupertonic3Runtime } from "./useSupertonic3Runtime";

const mock = vi.hoisted(() => {
  const readyState = { ready: true, loading: false, downloadProgress: 100, error: null, backend: null };
  const runtime = (id: string) => ({
    id,
    modelState: readyState,
    canGenerate: true,
    isGenerating: false,
    generationProgress: 0,
    stats: { firstLatency: null, processingTime: 0, charsPerSec: 0, rtf: 0, totalDuration: 0, currentDuration: 0 },
    error: null,
    handleGenerate: vi.fn(),
    handleStop: vi.fn(),
    retryLoad: vi.fn(),
    cancelActiveGeneration: vi.fn(),
    resetGeneratedAudio: vi.fn(),
    synthesize: vi.fn(),
  });
  return {
    runtime,
    readyState,
    runtimes: {} as Record<string, ReturnType<typeof runtime>>,
    qwen3Available: true,
  };
});

vi.mock("./useBrowserEngineRuntimes", () => ({
  useBrowserEngineRuntimes: vi.fn(() => ({
    runtimes: { kokoro: mock.runtimes.kokoro, supertonic: mock.runtimes.supertonic },
    voicesInUse: { kokoro: "af_heart", supertonic: "Female" },
    states: { kokoro: mock.readyState, supertonic: mock.readyState },
    voices: { kokoro: [], supertonic: [] },
    loadModel: vi.fn(),
    isRetakingSegment: false,
    handleRetakeSegment: vi.fn(),
    cacheBusy: false,
    cacheStatus: null,
    clearCache: vi.fn(),
    redownloadActiveModel: vi.fn(),
  })),
}));
vi.mock("./useAudio8Runtime", () => ({ useAudio8Runtime: vi.fn(() => mock.runtimes.audio8) }));
vi.mock("./useSupertonic3Runtime", () => ({ useSupertonic3Runtime: vi.fn(() => mock.runtimes.supertonic3) }));
vi.mock("./useQwen3LocalRuntime", () => ({ useQwen3LocalRuntime: vi.fn(() => mock.runtimes.qwen3) }));
vi.mock("../contexts/Qwen3RuntimeContext", () => ({
  useQwen3Runtime: () => ({ available: mock.qwen3Available, profile: { mode: "customVoice" }, speaker: "Aiden" }),
}));

const BROWSER_SUPPORT: LocalBrowserSupport = {
  isSupported: true,
  isIOS: false,
  message: null,
  supportedModels: ["kokoro", "supertonic"],
  unsupportedModelMessages: {},
};

const ENGINE_SETTINGS = {
  kokoro: { voice: "af_heart" },
  supertonic: { voice: "Female", language: "en" },
  audio8: { voice: "clara" },
  supertonic3: { voice: "M1", language: "en" },
};

interface RenderOptions {
  surface?: Surface | null;
  studio?: "audio8" | "supertonic3" | "qwen3" | null;
  reader?: "audio8" | "supertonic3" | "qwen3" | null;
  text?: string;
  speech?: SpeechPipelineChoices;
  player?: UseAudioPlayerReturn;
}

const PLAIN_SPEECH: SpeechPipelineChoices = { dictionaries: [], normalize: false, cleanup: false };

function renderOrchestrator(initial: RenderOptions = {}) {
  const beforeReaderAudioChange = vi.fn();
  const onEngineChange = vi.fn();
  const view = renderHook(({ surface }: { surface: Surface | null }) => useEngineOrchestrator({
    surface,
    desktopRuntimesAvailable: true,
    createSupertonic3Worker: () => ({}) as Worker,
    enableDesktopRuntimes: true,
    browserSupport: BROWSER_SUPPORT,
    debugProfiling: false,
    initialState: { model: "kokoro", desktopModels: { studio: initial.studio ?? null, reader: initial.reader ?? null } },
    text: initial.text ?? "Enough text to speak aloud.",
    engineSettings: ENGINE_SETTINGS,
    generationSettings: { speed: 1, quality: 5, pronunciationRules: [{ from: "GIF", to: "jif" }] },
    speech: initial.speech ?? PLAIN_SPEECH,
    player: initial.player ?? ({} as UseAudioPlayerReturn),
    setShowPlayer: vi.fn(),
    beforeReaderAudioChange,
    onEngineChange,
  }), { initialProps: { surface: initial.surface === undefined ? "studio" : initial.surface } });
  return { ...view, beforeReaderAudioChange, onEngineChange };
}

const ALL_ENGINES: SurfaceEngineId[] = ["kokoro", "supertonic", "audio8", "supertonic3", "qwen3"];

describe("useEngineOrchestrator", () => {
  beforeEach(() => {
    mock.qwen3Available = true;
    mock.runtimes = Object.fromEntries(ALL_ENGINES.map((id) => [id, mock.runtime(id)]));
    vi.clearAllMocks();
  });

  it("keys every engine's runtime by id and gives each surface its own", () => {
    const { result } = renderOrchestrator({ studio: "audio8" });

    expect(Object.keys(result.current.runtimes).sort()).toEqual([...ALL_ENGINES].sort());
    // The runtimes are wrapped (to run the speech pipeline), but every surface field is theirs.
    for (const id of ALL_ENGINES) {
      expect(result.current.runtimes[id]).toEqual({ ...mock.runtimes[id], synthesize: expect.any(Function) });
      expect(result.current.runtimes[id].handleGenerate).toBe(mock.runtimes[id].handleGenerate);
    }
    expect(result.current.engineIds).toEqual({ studio: "audio8", reader: "kokoro" });
    expect(result.current.visibleEngineId).toBe("audio8");
  });

  it("retains the Qwen3 model for as long as either surface selects it and the engine is available", () => {
    const { rerender } = renderOrchestrator({ studio: "qwen3", reader: null });
    expect(vi.mocked(useQwen3LocalRuntime).mock.calls.at(-1)?.[0]).toMatchObject({ enabled: true, retain: true });

    // Qwen3 stays selected by Studio while the Reader is on screen.
    rerender({ surface: "reader" });
    expect(vi.mocked(useQwen3LocalRuntime).mock.calls.at(-1)?.[0]).toMatchObject({ enabled: false, retain: true });

    mock.qwen3Available = false;
    rerender({ surface: "reader" });
    expect(vi.mocked(useQwen3LocalRuntime).mock.calls.at(-1)?.[0]).toMatchObject({ retain: false });
  });

  it("activates engines for the visible surface and keeps loaded ones the other surface selects", () => {
    const { rerender } = renderOrchestrator({ studio: "supertonic3", reader: null });

    expect(vi.mocked(useBrowserEngineRuntimes).mock.calls.at(-1)?.[0]).toMatchObject({ active: false, retain: true });
    expect(vi.mocked(useSupertonic3Runtime).mock.calls.at(-1)?.[0]).toMatchObject({ active: true, retain: true });
    expect(vi.mocked(useAudio8Runtime).mock.calls.at(-1)?.[0]).toMatchObject({ active: false });
    expect(vi.mocked(useQwen3LocalRuntime).mock.calls.at(-1)?.[0]).toMatchObject({ enabled: false });

    rerender({ surface: "reader" });
    expect(vi.mocked(useBrowserEngineRuntimes).mock.calls.at(-1)?.[0]).toMatchObject({ active: true, retain: true });
    expect(vi.mocked(useSupertonic3Runtime).mock.calls.at(-1)?.[0]).toMatchObject({ active: false, retain: true });

    // Pages that synthesize nothing leave the browser model as it was.
    rerender({ surface: null });
    expect(vi.mocked(useBrowserEngineRuntimes).mock.calls.at(-1)?.[0]).toMatchObject({ active: true });
  });

  it("stops the generation of the engine the visible surface leaves, and only that one", () => {
    const { rerender } = renderOrchestrator({ studio: "audio8", reader: "qwen3" });

    rerender({ surface: "reader" });
    expect(mock.runtimes.audio8.cancelActiveGeneration).toHaveBeenCalledOnce();
    expect(mock.runtimes.qwen3.cancelActiveGeneration).not.toHaveBeenCalled();
    expect(mock.runtimes.kokoro.cancelActiveGeneration).not.toHaveBeenCalled();

    rerender({ surface: "reader" });
    rerender({ surface: null });
    expect(mock.runtimes.qwen3.cancelActiveGeneration).toHaveBeenCalledOnce();
    expect(mock.runtimes.audio8.cancelActiveGeneration).toHaveBeenCalledOnce();
  });

  it("retires every runtime's audio, cancelling all before resetting any", () => {
    const { result } = renderOrchestrator();
    const order: string[] = [];
    for (const id of ALL_ENGINES) {
      mock.runtimes[id].cancelActiveGeneration.mockImplementation(() => order.push(`cancel:${id}`));
      mock.runtimes[id].resetGeneratedAudio.mockImplementation(() => order.push(`reset:${id}`));
    }

    act(() => result.current.retireAllAudio());

    expect(order).toHaveLength(ALL_ENGINES.length * 2);
    expect(order.slice(0, ALL_ENGINES.length).every((entry) => entry.startsWith("cancel:"))).toBe(true);
  });

  it("switches a surface to the browser model, saving Reader audio first", () => {
    const { result, beforeReaderAudioChange, onEngineChange } = renderOrchestrator({ studio: "audio8", reader: "qwen3" });

    act(() => result.current.selectBrowserModel("reader", "supertonic"));

    expect(beforeReaderAudioChange).toHaveBeenCalledOnce();
    expect(mock.runtimes.qwen3.resetGeneratedAudio).toHaveBeenCalled();
    expect(result.current.activeModel).toBe("supertonic");
    expect(result.current.engineIds).toEqual({ studio: "audio8", reader: "supertonic" });
    expect(result.current.chosenDesktopModels).toEqual({ studio: "audio8", reader: null });
    expect(onEngineChange).toHaveBeenCalledOnce();

    // Choosing what is already selected changes nothing.
    vi.clearAllMocks();
    act(() => result.current.selectBrowserModel("reader", "supertonic"));
    expect(mock.runtimes.kokoro.resetGeneratedAudio).not.toHaveBeenCalled();
    expect(onEngineChange).not.toHaveBeenCalled();
  });

  it("selects a desktop engine per surface and offers each surface its own options", () => {
    const { result } = renderOrchestrator();

    act(() => result.current.desktopModelOptions.studio.find((option) => option.key === "qwen3")?.onSelect());

    expect(result.current.engineIds).toEqual({ studio: "qwen3", reader: "kokoro" });
    expect(result.current.desktopModelOptions.studio.find((option) => option.key === "qwen3")?.selected).toBe(true);
    expect(result.current.desktopModelOptions.reader.every((option) => !option.selected)).toBe(true);
    expect(mock.runtimes.audio8.resetGeneratedAudio).toHaveBeenCalled();
  });

  it("falls back to the browser model while a saved desktop engine is unavailable, keeping the choice", () => {
    mock.qwen3Available = false;
    const { result } = renderOrchestrator({ studio: "qwen3" });

    expect(result.current.engineIds.studio).toBe("kokoro");
    expect(result.current.desktopModels.studio).toBeNull();
    expect(result.current.chosenDesktopModels.studio).toBe("qwen3");
    expect(result.current.desktopModelOptions.studio.map((option) => option.key)).not.toContain("qwen3");
  });

  it("clears only the visible engine's audio when one of its inputs changes", () => {
    const { result, rerender, beforeReaderAudioChange } = renderOrchestrator({ studio: "audio8" });
    const apply = vi.fn();

    act(() => result.current.changeEngineInput("supertonic3", apply));
    expect(apply).toHaveBeenCalledOnce();
    expect(mock.runtimes.supertonic3.resetGeneratedAudio).not.toHaveBeenCalled();

    act(() => result.current.changeEngineInput("audio8", apply));
    expect(mock.runtimes.audio8.cancelActiveGeneration).toHaveBeenCalledOnce();
    expect(mock.runtimes.audio8.resetGeneratedAudio).toHaveBeenCalledOnce();
    expect(beforeReaderAudioChange).not.toHaveBeenCalled();

    rerender({ surface: "reader" });
    act(() => result.current.changeEngineInput("kokoro", apply));
    expect(beforeReaderAudioChange).toHaveBeenCalledOnce();
    expect(mock.runtimes.kokoro.resetGeneratedAudio).toHaveBeenCalledOnce();
  });

  describe("spoken-text pipeline", () => {
    const BREAKS = 'GIF files are small.<break time="1s"/>The end.';
    const speech: SpeechPipelineChoices = {
      dictionaries: [createPronunciationDictionary({ name: "Quick", rules: [{ type: "alias", from: "GIF", to: "jif" }] })],
      normalize: false,
      cleanup: false,
    };
    const lastCall = <T,>(hook: unknown) => (hook as { mock: { calls: T[][] } }).mock.calls.at(-1)![0];

    function fakePlayer() {
      const scheduleChunk = vi.fn(async () => {});
      const beginStream = vi.fn();
      return { player: { scheduleChunk, beginStream, marker: "real" } as unknown as UseAudioPlayerReturn, scheduleChunk, beginStream };
    }

    it("leaves the script, the tuning's player and the engines' text alone when it has nothing to do", () => {
      const { player } = fakePlayer();
      renderOrchestrator({ player });

      const options = lastCall<{ text: string; player: UseAudioPlayerReturn }>(useBrowserEngineRuntimes);
      expect(options.text).toBe("Enough text to speak aloud.");
      expect(options.player).toBe(player);
    });

    it("hands the engines the spoken text and clears their own copy of the pronunciation rules", () => {
      renderOrchestrator({ text: BREAKS, speech });

      const browser = lastCall<{ text: string; generationSettings: { pronunciationRules: unknown[] } }>(useBrowserEngineRuntimes);
      expect(browser.text).toBe("jif files are small.\n\nThe end.");
      expect(browser.generationSettings.pronunciationRules).toEqual([]);
      expect(lastCall<{ text: string }>(useSupertonic3Runtime).text).toBe(browser.text);
      expect(lastCall<{ text: string }>(useAudio8Runtime).text).toBe(browser.text);
      expect(lastCall<{ text: string }>(useQwen3LocalRuntime).text).toBe(browser.text);
    });

    it("splits Qwen3 requests at a pause mark instead of a blank line", () => {
      renderOrchestrator({ text: BREAKS, speech, studio: "qwen3" });

      const text = lastCall<{ text: string }>(useQwen3LocalRuntime).text;
      expect(text).toMatch(/^jif files are small\.[\ue000-\ue3e8]The end\.$/u);
      expect(text.charCodeAt("jif files are small.".length)).toBe(0xe000 + 100);
    });

    it("gives the engines a player that reports chunks against the written script", async () => {
      const { player, scheduleChunk, beginStream } = fakePlayer();
      renderOrchestrator({ text: BREAKS, speech, player });
      const { player: engineFacing } = lastCall<{ player: UseAudioPlayerReturn }>(useBrowserEngineRuntimes);

      engineFacing.beginStream();
      expect(beginStream).toHaveBeenCalledOnce();
      await engineFacing.scheduleChunk({
        audio: new Float32Array(100),
        samplingRate: 100,
        text: "jif files are small.",
        index: 1,
        total: 2,
        textStart: 0,
        textEnd: 20,
        pauseAfterSec: 0.44,
      });

      expect(scheduleChunk).toHaveBeenCalledOnce();
      const [forwarded] = scheduleChunk.mock.calls[0] as unknown as [{ audio: Float32Array; text: string; textEnd: number; pauseAfterSec: number }];
      expect(forwarded.text).toBe("GIF files are small.");
      expect(forwarded.textEnd).toBe(20);
      expect(forwarded.pauseAfterSec).toBe(1);
      expect(forwarded.audio).toHaveLength(100 - 44 + 100);
    });

    it("maps a running generation's chunks with the script it started from", async () => {
      const { player, scheduleChunk } = fakePlayer();
      const options: RenderOptions = { text: BREAKS, speech, player };
      const { rerender } = renderOrchestrator(options);
      const engineFacing = () => lastCall<{ player: UseAudioPlayerReturn }>(useBrowserEngineRuntimes).player;

      engineFacing().beginStream();
      const started = engineFacing();
      // The dictionary changes while the first generation is still streaming.
      options.speech = PLAIN_SPEECH;
      rerender({ surface: "studio" });
      expect(lastCall<{ text: string }>(useBrowserEngineRuntimes).text).toBe("GIF files are small.\n\nThe end.");

      await started.scheduleChunk({
        audio: new Float32Array(10), samplingRate: 100, text: "jif files are small.", index: 1, total: 2, textStart: 0, textEnd: 20,
      });
      await engineFacing().scheduleChunk({
        audio: new Float32Array(10), samplingRate: 100, text: "GIF files are small.", index: 1, total: 2, textStart: 0, textEnd: 20,
      });

      const forwarded = scheduleChunk.mock.calls.map(([chunk]) => (chunk as { text: string }).text);
      // The running generation still maps through its own plan; the next one maps through the new text.
      expect(forwarded).toEqual(["GIF files are small.", "GIF files are small."]);
    });

    it("regenerates a retaken passage from what the engine spoke for it", () => {
      renderOrchestrator({ text: BREAKS, speech });
      const { retakeText } = lastCall<{ retakeText: (segment: { text: string; textStart?: number; textEnd?: number }) => string }>(useBrowserEngineRuntimes);

      expect(retakeText({ text: "GIF files are small.", textStart: 0, textEnd: 20 })).toBe("jif files are small.");
      expect(retakeText({ text: "kept", textStart: undefined, textEnd: undefined })).toBe("kept");
    });

    it("runs every synthesize request through the pipeline, for each engine", async () => {
      const seen: Array<{ text: string; rules: unknown }> = [];
      mock.runtimes.kokoro.synthesize.mockImplementation(((request: { text: string; tuning: { pronunciationRules: unknown } }) => {
        seen.push({ text: request.text, rules: request.tuning.pronunciationRules });
        return (async function* () {
          yield { audio: new Float32Array(10), samplingRate: 100, text: "x", index: 1, total: 1, textStart: 0, textEnd: 20, pauseAfterSec: 0 };
        })();
      }) as never);
      const { result } = renderOrchestrator({ speech });

      const chunks = [];
      for await (const chunk of result.current.runtimes.kokoro.synthesize({
        text: BREAKS,
        settings: { voice: "af_heart" },
        tuning: { speed: 1, quality: 5, pronunciationRules: [{ from: "GIF", to: "jif" }] },
      })) chunks.push(chunk);

      expect(seen).toEqual([{ text: "jif files are small.\n\nThe end.", rules: [] }]);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({ text: "GIF files are small.", pauseAfterSec: 1 });
      expect(result.current.runtimes.audio8.id).toBe("audio8");
    });
  });
});
