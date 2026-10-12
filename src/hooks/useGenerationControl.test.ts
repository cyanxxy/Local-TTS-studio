import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GenerationTuningSettings, ModelType, WorkerInMessage, WorkerOutMessage } from "../types";
import { useGenerationControl } from "./useGenerationControl";
import { WORKER_ABORT_TIMEOUT_MS } from "./workerGeneration";
import type { AudioSegment, UseAudioPlayerReturn } from "./useAudioPlayer";
import type { UseTTSReturn } from "./useTTS";
import { PlaybackClock } from "../lib/playbackClock";

class MockWorker {
  public postedMessages: WorkerInMessage[] = [];
  private listeners = new Set<(event: MessageEvent<WorkerOutMessage>) => void>();

  addEventListener(type: string, listener: EventListener): void {
    if (type !== "message") return;
    this.listeners.add(listener as (event: MessageEvent<WorkerOutMessage>) => void);
  }

  removeEventListener(type: string, listener: EventListener): void {
    if (type !== "message") return;
    this.listeners.delete(listener as (event: MessageEvent<WorkerOutMessage>) => void);
  }

  postMessage(message: WorkerInMessage): void {
    this.postedMessages.push(message);
  }

  emit(message: WorkerOutMessage): void {
    const event = { data: message } as MessageEvent<WorkerOutMessage>;
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function createPlayerMock(overrides: Partial<UseAudioPlayerReturn> = {}): UseAudioPlayerReturn {
  return {
    isPlaying: false,
    isSynthesisComplete: false,
    error: null,
    clock: new PlaybackClock(),
    getCurrentTime: () => 0,
    totalDuration: 0,
    playbackRate: 1,
    segments: [],
    activeSegmentId: null,
    scheduleChunk: vi.fn(async () => {}),
    togglePlay: vi.fn(),
    seek: vi.fn(),
    seekTo: vi.fn(),
    skip: vi.fn(),
    jumpToSegment: vi.fn(),
    setPlaybackRate: vi.fn(),
    download: vi.fn(async () => {}),
    downloadCaptions: vi.fn(),
    replaceSegment: vi.fn(),
    getAudioChunkCount: vi.fn(() => 0),
    getContentEpoch: vi.fn(() => 0),
    truncateAudioChunks: vi.fn(),
    getAudioCacheSnapshot: vi.fn(() => []),
    getPlaybackSnapshot: vi.fn(() => ({ playbackRate: 1, totalDuration: 0, synthesisComplete: false })),
    restoreAudioCache: vi.fn(),
    beginStream: vi.fn(),
    endStream: vi.fn(),
    reset: vi.fn(),
    stopAll: vi.fn(),
    ...overrides,
  };
}

type TtsMock = Pick<UseTTSReturn, "abort" | "cancel" | "generate" | "isGenerating">;

function createTtsMock(overrides: Partial<TtsMock> = {}): TtsMock {
  return {
    abort: vi.fn(),
    cancel: vi.fn(),
    generate: vi.fn(),
    isGenerating: false,
    ...overrides,
  };
}

const BASE_SETTINGS: GenerationTuningSettings = {
  language: "fr",
  speed: 1,
  quality: 5,
  sentenceSpeedVariance: 0.15,
  pauseOverridesSec: {
    none: 0,
    comma: 0.1,
    sentence: 0.2,
    paragraph: 0.3,
  },
  pronunciationRules: [],
  emphasisStrength: 0.35,
};

function makeSegment(overrides: Partial<AudioSegment> = {}): AudioSegment {
  return {
    id: "segment-1",
    text: "Segment one",
    startSec: 0,
    endSec: 1,
    index: 1,
    total: 1,
    ...overrides,
  };
}


/** A `getWorker` over per-engine worker refs, read at call time. */
function workerLookup(refs: Record<ModelType, { current: Worker | null }>) {
  return (model: ModelType) => refs[model].current;
}

describe("useGenerationControl", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function render(options: {
    tts: TtsMock;
    worker?: MockWorker | null;
    hardRestartModel?: () => void;
    getWorker?: (model: ModelType) => Worker | null;
  }) {
    const kokoroWorker = { current: (options.worker ?? null) as unknown as Worker | null };
    return renderHook(() =>
      useGenerationControl({
        activeModel: "kokoro",
        canGenerate: true,
        generationSettings: BASE_SETTINGS,
        getWorker: options.getWorker ?? workerLookup({ kokoro: kokoroWorker, supertonic: { current: null } }),
        hardRestartModel: options.hardRestartModel ?? vi.fn(),
        player: createPlayerMock(),
        setShowPlayer: vi.fn(),
        text: "Hello world",
        tts: options.tts,
        voice: "af_heart",
      }),
    );
  }

  it("does nothing to the worker when nothing is generating", () => {
    const tts = createTtsMock({ isGenerating: false });
    const hardRestartModel = vi.fn();
    const { result } = render({ tts, hardRestartModel });

    act(() => result.current.cancelActiveGeneration());

    expect(tts.abort).not.toHaveBeenCalled();
    expect(tts.cancel).not.toHaveBeenCalled();
    expect(hardRestartModel).not.toHaveBeenCalled();
  });

  it("aborts a running generation softly, keeping the model loaded", () => {
    const worker = new MockWorker();
    const tts = createTtsMock({ isGenerating: true });
    const hardRestartModel = vi.fn();
    const { result } = render({ tts, worker, hardRestartModel });

    act(() => result.current.handleStop());

    expect(tts.abort).toHaveBeenCalledTimes(1);
    expect(tts.cancel).not.toHaveBeenCalled();
    expect(hardRestartModel).not.toHaveBeenCalled();
  });

  it("replaces a worker that never answered the abort, unless it was replaced already", () => {
    const worker = new MockWorker();
    const replacement = new MockWorker();
    const current = { value: worker as unknown as Worker };
    const tts = createTtsMock({ isGenerating: true });
    const hardRestartModel = vi.fn();
    const { result } = render({ tts, hardRestartModel, getWorker: () => current.value });
    act(() => result.current.cancelActiveGeneration());
    const onUnresponsive = vi.mocked(tts.abort).mock.calls[0][0];

    onUnresponsive(worker as unknown as Worker);
    expect(hardRestartModel).toHaveBeenCalledExactlyOnceWith("kokoro");

    hardRestartModel.mockClear();
    current.value = replacement as unknown as Worker;
    onUnresponsive(worker as unknown as Worker);
    expect(hardRestartModel).not.toHaveBeenCalled();
  });

  it("closes the worker and loads the model again only when the cancel is forced", () => {
    const tts = createTtsMock({ isGenerating: false });
    const hardRestartModel = vi.fn();
    const { result } = render({ tts, hardRestartModel });

    act(() => result.current.cancelActiveGeneration(true));

    expect(tts.cancel).toHaveBeenCalledTimes(1);
    expect(tts.abort).not.toHaveBeenCalled();
    expect(hardRestartModel).toHaveBeenCalledWith("kokoro");
  });

  it("stops playback without reloading the model when nothing is generating", () => {
    const player = createPlayerMock();
    const tts = createTtsMock({ isGenerating: false });
    const hardRestartModel = vi.fn();
    const { result } = renderHook(() =>
      useGenerationControl({
        activeModel: "kokoro",
        canGenerate: true,
        generationSettings: BASE_SETTINGS,
        getWorker: workerLookup({ kokoro: { current: null }, supertonic: { current: null } }),
        hardRestartModel,
        player,
        setShowPlayer: vi.fn(),
        text: "Hello world",
        tts,
        voice: "af_heart",
      }),
    );

    act(() => result.current.handleStop());

    expect(player.stopAll).toHaveBeenCalledOnce();
    expect(tts.cancel).not.toHaveBeenCalled();
    expect(hardRestartModel).not.toHaveBeenCalled();
  });

  it("retakes a segment and replaces it with merged audio on completion", () => {
    const worker = new MockWorker();
    const segment = makeSegment({ pauseAfterSec: 0.5 });
    const replaceSegment = vi.fn();
    const player = createPlayerMock({
      segments: [segment],
      replaceSegment,
    });
    const tts = createTtsMock();
    const setShowPlayer = vi.fn();
    const kokoroWorker = { current: worker as unknown as Worker };
    const supertonicWorker = { current: null as Worker | null };

    const { result } = renderHook(() =>
      useGenerationControl({
        activeModel: "kokoro",
        canGenerate: true,
        generationSettings: BASE_SETTINGS,
        getWorker: workerLookup({ kokoro: kokoroWorker, supertonic: supertonicWorker }),
        hardRestartModel: vi.fn(),
        player,
        setShowPlayer,
        text: "Hello world",
        tts,
        voice: "af_heart",
      }),
    );

    act(() => {
      result.current.handleRetakeSegment(segment.id);
    });

    expect(result.current.isRetakingSegment).toBe(true);
    expect(worker.postedMessages).toHaveLength(1);
    expect(worker.postedMessages[0]).toMatchObject({
      type: "GENERATE",
      text: segment.text,
      voice: "af_heart",
      speed: BASE_SETTINGS.speed,
      quality: BASE_SETTINGS.quality,
      language: BASE_SETTINGS.language,
      sentenceSpeedVariance: BASE_SETTINGS.sentenceSpeedVariance,
      emphasisStrength: BASE_SETTINGS.emphasisStrength,
      finalPauseSec: segment.pauseAfterSec,
    });
    const generationId = worker.postedMessages[0].type === "GENERATE"
      ? worker.postedMessages[0].generationId
      : undefined;
    expect(generationId).toMatch(/^retake-/);

    act(() => {
      worker.emit({
        type: "AUDIO_CHUNK",
        generationId,
        audio: new Float32Array([0.1, 0.2]),
        samplingRate: 4,
        text: segment.text,
        index: 1,
        total: 2,
      });
      worker.emit({
        type: "AUDIO_CHUNK",
        generationId,
        audio: new Float32Array([0.3, 0.4, 0, 0]),
        samplingRate: 4,
        text: segment.text,
        index: 2,
        total: 2,
      });
      worker.emit({ type: "GENERATION_COMPLETE", generationId });
    });

    expect(replaceSegment).toHaveBeenCalledTimes(1);
    const [, replacement] = replaceSegment.mock.calls[0] as [string, { audio: Float32Array; samplingRate: number }];
    expect(replacement.samplingRate).toBe(4);
    const values = Array.from(replacement.audio);
    expect(values).toHaveLength(6);
    expect(values[0]).toBeCloseTo(0.1, 6);
    expect(values[1]).toBeCloseTo(0.2, 6);
    expect(values[2]).toBeCloseTo(0.3, 6);
    expect(values[3]).toBeCloseTo(0.4, 6);
    expect(values[4]).toBe(0);
    expect(values[5]).toBe(0);
    expect(result.current.isRetakingSegment).toBe(false);
    expect(setShowPlayer).toHaveBeenCalledWith(true);
  });

  it("does not start retake when generation is already in progress", () => {
    const worker = new MockWorker();
    const segment = makeSegment();
    const player = createPlayerMock({ segments: [segment] });
    const tts = createTtsMock({ isGenerating: true });
    const setShowPlayer = vi.fn();
    const kokoroWorker = { current: worker as unknown as Worker };
    const supertonicWorker = { current: null as Worker | null };

    const { result } = renderHook(() =>
      useGenerationControl({
        activeModel: "kokoro",
        canGenerate: true,
        generationSettings: BASE_SETTINGS,
        getWorker: workerLookup({ kokoro: kokoroWorker, supertonic: supertonicWorker }),
        hardRestartModel: vi.fn(),
        player,
        setShowPlayer,
        text: "Hello world",
        tts,
        voice: "af_heart",
      }),
    );

    act(() => {
      result.current.handleRetakeSegment(segment.id);
    });

    expect(worker.postedMessages).toHaveLength(0);
    expect(result.current.isRetakingSegment).toBe(false);
  });

  it("aborts a cancelled retake softly and replaces its worker only if it stays silent", () => {
    vi.useFakeTimers();
    const worker = new MockWorker();
    const segment = makeSegment();
    const hardRestartModel = vi.fn();
    const { result } = renderHook(() =>
      useGenerationControl({
        activeModel: "kokoro",
        canGenerate: true,
        generationSettings: BASE_SETTINGS,
        hardRestartModel,
        getWorker: workerLookup({ kokoro: { current: worker as unknown as Worker }, supertonic: { current: null } }),
        player: createPlayerMock({ segments: [segment] }),
        setShowPlayer: vi.fn(),
        text: "Hello world",
        tts: createTtsMock(),
        voice: "af_heart",
      }),
    );
    act(() => result.current.handleRetakeSegment(segment.id));

    const generationId = (worker.postedMessages[0] as { generationId: string }).generationId;

    act(() => result.current.cancelRetake(true));

    expect(worker.postedMessages.at(-1)).toEqual({ type: "ABORT", generationId });
    expect(hardRestartModel).not.toHaveBeenCalled();
    expect(result.current.isRetakingSegment).toBe(false);
    act(() => vi.advanceTimersByTime(WORKER_ABORT_TIMEOUT_MS));
    expect(hardRestartModel).toHaveBeenCalledExactlyOnceWith("kokoro");
  });

  it("keeps the model loaded when the worker answers a retake's abort", () => {
    vi.useFakeTimers();
    const worker = new MockWorker();
    const segment = makeSegment();
    const hardRestartModel = vi.fn();
    const { result } = renderHook(() =>
      useGenerationControl({
        activeModel: "kokoro",
        canGenerate: true,
        generationSettings: BASE_SETTINGS,
        hardRestartModel,
        getWorker: workerLookup({ kokoro: { current: worker as unknown as Worker }, supertonic: { current: null } }),
        player: createPlayerMock({ segments: [segment] }),
        setShowPlayer: vi.fn(),
        text: "Hello world",
        tts: createTtsMock(),
        voice: "af_heart",
      }),
    );
    act(() => result.current.handleRetakeSegment(segment.id));
    const generationId = (worker.postedMessages[0] as { generationId: string }).generationId;
    act(() => result.current.cancelRetake(true));

    act(() => worker.emit({ type: "ABORTED", generationId }));
    act(() => vi.advanceTimersByTime(WORKER_ABORT_TIMEOUT_MS * 2));

    expect(hardRestartModel).not.toHaveBeenCalled();
  });
});
