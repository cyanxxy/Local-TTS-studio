import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GenerationTuningSettings, WorkerInMessage, WorkerOutMessage } from "../types";
import { useGenerationControl } from "./useGenerationControl";
import type { AudioSegment, UseAudioPlayerReturn } from "./useAudioPlayer";
import type { UseTTSReturn } from "./useTTS";

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
    currentTime: 0,
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
    reset: vi.fn(),
    stopAll: vi.fn(),
    ...overrides,
  };
}

function createTtsMock(
  overrides: Partial<Pick<UseTTSReturn, "cancel" | "generate" | "isGenerating">> = {},
): Pick<UseTTSReturn, "cancel" | "generate" | "isGenerating"> {
  return {
    cancel: vi.fn(),
    generate: vi.fn(),
    isGenerating: false,
    ...overrides,
  };
}

const BASE_SETTINGS: GenerationTuningSettings = {
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

describe("useGenerationControl", () => {
  it("cancels TTS only when forced or currently generating", () => {
    const worker = new MockWorker();
    const player = createPlayerMock();
    const tts = createTtsMock({ isGenerating: false });
    const setShowPlayer = vi.fn();
    const kokoroWorker = { current: worker as unknown as Worker };
    const supertonicWorker = { current: null as Worker | null };

    const { result } = renderHook(() =>
      useGenerationControl({
        activeModel: "kokoro",
        canGenerate: true,
        generationSettings: BASE_SETTINGS,
        kokoroWorker,
        supertonicWorker,
        player,
        setShowPlayer,
        text: "Hello world",
        tts,
        voice: "af_heart",
      }),
    );

    act(() => {
      result.current.cancelActiveGeneration();
    });
    expect(tts.cancel).not.toHaveBeenCalled();

    act(() => {
      result.current.cancelActiveGeneration(true);
    });
    expect(tts.cancel).toHaveBeenCalledTimes(1);
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
        kokoroWorker,
        supertonicWorker,
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
      sentenceSpeedVariance: BASE_SETTINGS.sentenceSpeedVariance,
      emphasisStrength: BASE_SETTINGS.emphasisStrength,
    });

    act(() => {
      worker.emit({
        type: "AUDIO_CHUNK",
        audio: new Float32Array([0.1, 0.2]),
        samplingRate: 4,
        text: segment.text,
        index: 1,
        total: 2,
      });
      worker.emit({
        type: "AUDIO_CHUNK",
        audio: new Float32Array([0.3, 0.4]),
        samplingRate: 4,
        text: segment.text,
        index: 2,
        total: 2,
      });
      worker.emit({ type: "GENERATION_COMPLETE" });
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
        kokoroWorker,
        supertonicWorker,
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
});
