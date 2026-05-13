import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationTuningSettings, WorkerInMessage, WorkerOutMessage } from "../types";
import { useTTS } from "./useTTS";

class MockWorker {
  public postedMessages: WorkerInMessage[] = [];
  private listeners = new Set<(event: MessageEvent<WorkerOutMessage>) => void>();

  addEventListener(type: string, listener: EventListener): void {
    if (type === "message") {
      this.listeners.add(listener as (event: MessageEvent<WorkerOutMessage>) => void);
    }
  }

  removeEventListener(type: string, listener: EventListener): void {
    if (type === "message") {
      this.listeners.delete(listener as (event: MessageEvent<WorkerOutMessage>) => void);
    }
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

  listenerCount(): number {
    return this.listeners.size;
  }
}

const SETTINGS: GenerationTuningSettings = {
  speed: 1.05,
  quality: 7,
  pauseOverridesSec: { none: 0, comma: 0.1, sentence: 0.2, paragraph: 0.3 },
  sentenceSpeedVariance: 0.2,
  pronunciationRules: [{ from: "GIF", to: "jif" }],
  emphasisStrength: 0.5,
};

describe("useTTS", () => {
  let now = 0;

  beforeEach(() => {
    now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
  });

  it("posts generate settings to the active worker and tracks chunk progress", () => {
    const kokoroWorker = new MockWorker();
    const onAudioChunk = vi.fn();
    const onComplete = vi.fn();

    const { result } = renderHook(() => useTTS({
      kokoroWorker: { current: kokoroWorker as unknown as Worker },
      supertonicWorker: { current: null },
      onAudioChunk,
      onComplete,
    }));

    act(() => {
      result.current.generate("Hello world", "kokoro", "af_heart", SETTINGS);
    });

    expect(result.current.isGenerating).toBe(true);
    expect(kokoroWorker.postedMessages).toEqual([{
      type: "GENERATE",
      text: "Hello world",
      voice: "af_heart",
      speed: 1.05,
      quality: 7,
      pauseOverridesSec: SETTINGS.pauseOverridesSec,
      sentenceSpeedVariance: 0.2,
      pronunciationRules: SETTINGS.pronunciationRules,
      emphasisStrength: 0.5,
    }]);

    act(() => {
      now = 1000;
      kokoroWorker.emit({
        type: "AUDIO_CHUNK",
        audio: new Float32Array(4),
        samplingRate: 4,
        text: "Hello",
        index: 1,
        total: 2,
      });
    });

    expect(onAudioChunk).toHaveBeenCalledOnce();
    expect(result.current.stats).toMatchObject({
      firstLatency: 1,
      processingTime: 1,
      charsPerSec: 5,
      rtf: 1,
      totalDuration: 1,
      currentDuration: 1,
    });
    expect(result.current.generationProgress).toBe(50);

    act(() => {
      kokoroWorker.emit({ type: "GENERATION_COMPLETE" });
    });

    expect(result.current.isGenerating).toBe(false);
    expect(result.current.generationProgress).toBe(100);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(kokoroWorker.listenerCount()).toBe(0);
  });

  it("uses character progress for unknown totals and cleans up on errors", () => {
    const worker = new MockWorker();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const { result } = renderHook(() => useTTS({
      kokoroWorker: { current: null },
      supertonicWorker: { current: worker as unknown as Worker },
      onAudioChunk: vi.fn(),
      onComplete: vi.fn(),
    }));

    act(() => {
      result.current.generate("abcdef", "supertonic", "Female", SETTINGS);
    });
    act(() => {
      worker.emit({
        type: "AUDIO_CHUNK",
        audio: new Float32Array(2),
        samplingRate: 4,
        text: "abc",
        index: 1,
        total: 0,
      });
    });

    expect(result.current.generationProgress).toBe(50);

    act(() => {
      worker.emit({ type: "ERROR", message: "failed", scope: "generate" });
    });

    expect(result.current.error).toBe("failed");
    expect(result.current.isGenerating).toBe(false);
    expect(worker.listenerCount()).toBe(0);
    expect(consoleError).toHaveBeenCalledWith("Worker error:", "failed");
  });

  it("ignores missing workers and can cancel an active generation", () => {
    const worker = new MockWorker();
    const { result } = renderHook(() => useTTS({
      kokoroWorker: { current: worker as unknown as Worker },
      supertonicWorker: { current: null },
      onAudioChunk: vi.fn(),
      onComplete: vi.fn(),
    }));

    act(() => {
      result.current.generate("No worker", "supertonic", "Female", SETTINGS);
    });
    expect(result.current.isGenerating).toBe(false);

    act(() => {
      result.current.generate("Hello", "kokoro", "af_heart", SETTINGS);
      result.current.cancel();
    });

    expect(worker.postedMessages.at(-1)).toEqual({ type: "CANCEL" });
    expect(result.current.isGenerating).toBe(false);
    expect(worker.listenerCount()).toBe(0);
  });
});
