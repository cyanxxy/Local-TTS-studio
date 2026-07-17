import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIO_PLAYER_MAX_BUFFER_SECONDS } from "../constants";
import * as audioExportClientModule from "../lib/audioExportClient";
import * as exportAudioModule from "../lib/exportAudio";
import { useAudioPlayer } from "./useAudioPlayer";

class MockAudioBuffer {
  public readonly duration: number;
  private readonly channelData: Float32Array;

  constructor(length: number, sampleRate: number) {
    this.duration = length / sampleRate;
    this.channelData = new Float32Array(length);
  }

  getChannelData(channel: number): Float32Array {
    void channel;
    return this.channelData;
  }
}

class MockAudioBufferSourceNode {
  public buffer: MockAudioBuffer | null = null;
  public playbackRate = { value: 1 };
  public onended: (() => void) | null = null;
  public startedWith: Array<number | undefined> | null = null;
  public stopped = false;

  connect(): void {}

  disconnect(): void {}

  start(when?: number, offset?: number): void {
    this.startedWith = [when, offset];
  }

  stop(): void {
    this.stopped = true;
  }
}

class MockAudioContext {
  static instances: MockAudioContext[] = [];
  static resumeError: Error | null = null;
  static resumeGate: Promise<void> | null = null;

  public currentTime = 0;
  public state: "running" | "suspended" | "closed" = "suspended";
  public readonly destination = {};
  public readonly createdSources: MockAudioBufferSourceNode[] = [];
  public readonly resume = vi.fn(async () => {
    if (MockAudioContext.resumeError) {
      throw MockAudioContext.resumeError;
    }
    if (MockAudioContext.resumeGate) await MockAudioContext.resumeGate;
    this.state = "running";
  });
  public readonly suspend = vi.fn(async () => {
    this.state = "suspended";
  });
  public readonly close = vi.fn(async () => {
    this.state = "closed";
  });

  constructor() {
    MockAudioContext.instances.push(this);
  }

  createBuffer(_channels: number, length: number, sampleRate: number): MockAudioBuffer {
    return new MockAudioBuffer(length, sampleRate);
  }

  createBufferSource(): MockAudioBufferSourceNode {
    const source = new MockAudioBufferSourceNode();
    this.createdSources.push(source);
    return source;
  }
}

function makeChunk(text: string, length: number, samplingRate: number) {
  return {
    audio: new Float32Array(length),
    samplingRate,
    text,
  };
}

describe("useAudioPlayer", () => {
  let animationFrameCallbacks: FrameRequestCallback[];

  const flushNextAnimationFrame = (timestamp = 0) => {
    act(() => {
      animationFrameCallbacks.shift()?.(timestamp);
    });
  };

  beforeEach(() => {
    animationFrameCallbacks = [];
    MockAudioContext.instances = [];
    MockAudioContext.resumeError = null;
    MockAudioContext.resumeGate = null;
    vi.stubGlobal("AudioContext", MockAudioContext as unknown as typeof AudioContext);
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      animationFrameCallbacks.push(callback);
      return animationFrameCallbacks.length;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    MockAudioContext.instances = [];
    MockAudioContext.resumeError = null;
    MockAudioContext.resumeGate = null;
  });

  it("does not resume playback when paused and new chunks keep streaming", async () => {
    const { result } = renderHook(() => useAudioPlayer());

    await act(async () => {
      await result.current.scheduleChunk(makeChunk("First", 4, 4));
    });

    const ctx = MockAudioContext.instances[0];
    expect(result.current.isPlaying).toBe(true);
    expect(result.current.error).toBeNull();
    expect(ctx.resume).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.togglePlay();
    });

    expect(result.current.isPlaying).toBe(false);
    expect(ctx.suspend).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.scheduleChunk(makeChunk("Second", 4, 4));
    });

    expect(ctx.resume).toHaveBeenCalledTimes(1);
    expect(result.current.isPlaying).toBe(false);
  });

  it("retains full history for long sessions instead of dropping old chunks", async () => {
    const { result } = renderHook(() => useAudioPlayer());

    await act(async () => {
      await result.current.scheduleChunk(makeChunk("First section", 500, 1));
      await result.current.scheduleChunk(makeChunk("Second section", 450, 1));
    });

    expect(result.current.segments).toHaveLength(0);
    flushNextAnimationFrame();

    expect(result.current.segments).toHaveLength(2);
    expect(result.current.totalDuration).toBe(950);
    expect(result.current.segments[0]?.startSec).toBe(0);
    expect(result.current.segments[1]?.startSec).toBe(500);
  });

  it("can roll back streamed chunks to a section checkpoint", async () => {
    const { result } = renderHook(() => useAudioPlayer());

    await act(async () => {
      await result.current.scheduleChunk(makeChunk("Completed", 4, 4));
      await result.current.scheduleChunk(makeChunk("Failed partial A", 4, 4));
      await result.current.scheduleChunk(makeChunk("Failed partial B", 4, 4));
    });
    expect(result.current.getAudioChunkCount()).toBe(3);

    act(() => result.current.truncateAudioChunks(1));

    expect(result.current.getAudioChunkCount()).toBe(1);
    expect(result.current.totalDuration).toBe(1);
    expect(result.current.segments).toHaveLength(1);
    expect(result.current.segments[0]?.text).toBe("Completed");
  });

  it("serializes and restores cached PCM with timeline metadata and resume position", async () => {
    const { result } = renderHook(() => useAudioPlayer());
    await act(async () => {
      await result.current.scheduleChunk({
        audio: new Float32Array([0.25, -0.5, 0.75, 0]),
        samplingRate: 4,
        text: "Cached chapter",
        index: 0,
        total: 1,
        textStart: 10,
        textEnd: 24,
      });
    });
    const snapshot = result.current.getAudioCacheSnapshot();
    expect([...new Float32Array(snapshot[0].audio)]).toEqual([0.25, -0.5, 0.75, 0]);

    act(() => {
      result.current.reset();
      result.current.restoreAudioCache(snapshot, { currentTime: 0.5, playbackRate: 1.5 });
    });

    expect(result.current.totalDuration).toBe(1);
    expect(result.current.currentTime).toBe(0.5);
    expect(result.current.playbackRate).toBe(1.5);
    expect(result.current.segments[0]).toMatchObject({
      text: "Cached chapter",
      textStart: 10,
      textEnd: 24,
      startSec: 0,
      endSec: 1,
    });
    expect(result.current.isPlaying).toBe(false);
  });

  it("keeps seeking paused when playback is not active", async () => {
    const { result } = renderHook(() => useAudioPlayer());

    await act(async () => {
      await result.current.scheduleChunk(makeChunk("Only section", 4, 4));
      await result.current.togglePlay();
    });

    expect(result.current.isPlaying).toBe(false);

    await act(async () => {
      result.current.seekTo(0.25);
      await Promise.resolve();
    });

    expect(result.current.isPlaying).toBe(false);
    expect(result.current.currentTime).toBeCloseTo(0.25, 6);
  });

  it("limits queued sources to the playback buffer window", async () => {
    const { result } = renderHook(() => useAudioPlayer());

    await act(async () => {
      for (let index = 0; index < 20; index += 1) {
        await result.current.scheduleChunk(makeChunk(`Section ${index + 1}`, 100, 1));
      }
    });

    const ctx = MockAudioContext.instances[0];
    const expectedMaxSources = Math.ceil(AUDIO_PLAYER_MAX_BUFFER_SECONDS / 100);
    expect(ctx.createdSources.length).toBeLessThanOrEqual(expectedMaxSources);
  });

  it("excludes trailing synthetic silence from exported captions", async () => {
    const downloadBlobSpy = vi.spyOn(exportAudioModule, "downloadBlob").mockImplementation(() => {});
    const { result } = renderHook(() => useAudioPlayer());

    await act(async () => {
      await result.current.scheduleChunk({
        audio: new Float32Array([0.1, 0.2, 0, 0]),
        samplingRate: 4,
        text: "Spoken words",
        pauseAfterSec: 0.5,
      });
    });

    act(() => {
      result.current.downloadCaptions("srt");
    });

    expect(downloadBlobSpy).toHaveBeenCalledOnce();
    const [blob, filename] = downloadBlobSpy.mock.calls[0] as [Blob, string];
    expect(filename).toBe("tts-captions.srt");
    await expect(blob.text()).resolves.toContain("00:00:00,000 --> 00:00:00,500");
  });

  it("supports seeks, skips, segment jumps, rate clamps, replacement, stop, reset, and cleanup", async () => {
    const { result, unmount } = renderHook(() => useAudioPlayer());

    await act(async () => {
      await result.current.scheduleChunk(makeChunk("First", 10, 10));
      await result.current.scheduleChunk(makeChunk("Second", 10, 10));
      await result.current.togglePlay();
    });

    flushNextAnimationFrame();

    expect(result.current.isPlaying).toBe(false);
    expect(result.current.totalDuration).toBe(2);

    await act(async () => {
      result.current.seek(0.5);
      await Promise.resolve();
    });
    expect(result.current.currentTime).toBeCloseTo(1, 6);
    expect(result.current.activeSegmentId).toBe("segment-2");

    await act(async () => {
      result.current.skip(-0.5);
      await Promise.resolve();
    });
    expect(result.current.currentTime).toBeCloseTo(0.5, 6);

    await act(async () => {
      result.current.jumpToSegment("missing");
      await Promise.resolve();
    });
    expect(result.current.currentTime).toBeCloseTo(0.5, 6);

    await act(async () => {
      result.current.jumpToSegment("segment-2");
      await Promise.resolve();
    });
    expect(result.current.currentTime).toBeCloseTo(1, 6);

    act(() => {
      result.current.setPlaybackRate(3);
      result.current.setPlaybackRate(2.0001);
      result.current.setPlaybackRate(0.5);
    });
    expect(result.current.playbackRate).toBe(0.75);

    act(() => {
      result.current.replaceSegment("missing", makeChunk("No-op", 5, 10));
    });
    expect(result.current.totalDuration).toBe(2);

    act(() => {
      result.current.replaceSegment("segment-1", makeChunk("Long replacement", 20, 10));
    });
    expect(result.current.totalDuration).toBe(3);
    expect(result.current.segments[1]).toMatchObject({
      id: "segment-2",
      startSec: 2,
      endSec: 3,
    });

    act(() => {
      result.current.stopAll();
    });
    expect(result.current.isPlaying).toBe(false);
    expect(result.current.currentTime).toBe(0);
    expect(result.current.activeSegmentId).toBeNull();

    act(() => {
      result.current.reset();
    });
    expect(result.current.segments).toHaveLength(0);
    expect(result.current.totalDuration).toBe(0);

    const ctx = MockAudioContext.instances[0];
    unmount();
    expect(ctx.close).toHaveBeenCalledTimes(1);
  });

  it("downloads audio and VTT/JSON captions, while empty downloads are no-ops", async () => {
    const downloadAudioSpy = vi.spyOn(audioExportClientModule, "downloadAudioChunks").mockResolvedValue();
    const downloadBlobSpy = vi.spyOn(exportAudioModule, "downloadBlob").mockImplementation(() => {});
    const { result } = renderHook(() => useAudioPlayer());

    await act(async () => {
      await result.current.download();
      result.current.downloadCaptions("vtt");
    });
    expect(downloadAudioSpy).not.toHaveBeenCalled();
    expect(downloadBlobSpy).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.scheduleChunk(makeChunk("Caption text", 12, 12));
      await result.current.download({
        format: "wav-f32",
        sampleRate: "source",
        bitrateKbps: 192,
        mastering: {
          enabled: false,
          targetLufs: -16,
          truePeakDb: -1,
        },
      });
      result.current.downloadCaptions("vtt");
      result.current.downloadCaptions("json");
    });

    expect(downloadAudioSpy).toHaveBeenCalledWith([
      { audio: expect.any(Float32Array), samplingRate: 12 },
    ], {
      format: "wav-f32",
      sampleRate: "source",
      bitrateKbps: 192,
      mastering: {
        enabled: false,
        targetLufs: -16,
        truePeakDb: -1,
      },
    });
    expect(downloadBlobSpy).toHaveBeenCalledTimes(2);
    expect(downloadBlobSpy.mock.calls[0]?.[1]).toBe("tts-captions.vtt");
    expect(downloadBlobSpy.mock.calls[1]?.[1]).toBe("tts-timestamps.json");
  });

  it("stays stopped when AudioContext resume fails", async () => {
    MockAudioContext.resumeError = new Error("resume blocked");
    const { result } = renderHook(() => useAudioPlayer());

    await act(async () => {
      await result.current.scheduleChunk(makeChunk("Blocked", 4, 4));
    });

    expect(result.current.isPlaying).toBe(false);
    expect(result.current.error).toContain("Audio playback was blocked");
    expect(MockAudioContext.instances[0].resume).toHaveBeenCalledTimes(1);
  });

  it("does not revive playback when Stop wins a pending AudioContext resume", async () => {
    let releaseResume = () => {};
    MockAudioContext.resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    const { result } = renderHook(() => useAudioPlayer());
    let pendingSchedule: Promise<void> | undefined;

    act(() => {
      pendingSchedule = result.current.scheduleChunk(makeChunk("Pending", 4, 4));
    });
    const ctx = MockAudioContext.instances[0];
    expect(ctx.createdSources).toHaveLength(1);

    act(() => {
      result.current.stopAll();
    });
    releaseResume();
    await act(async () => {
      await pendingSchedule;
    });

    expect(result.current.isPlaying).toBe(false);
    expect(result.current.currentTime).toBe(0);
    expect(ctx.createdSources[0]?.stopped).toBe(true);
  });

  it("replaces every transport chunk in a semantic segment and preserves the later position", async () => {
    const { result } = renderHook(() => useAudioPlayer());
    const firstSection = {
      text: "First section",
      index: 1,
      total: 2,
      textStart: 0,
      textEnd: 13,
    };

    await act(async () => {
      await result.current.scheduleChunk({ ...makeChunk("First section", 10, 10), ...firstSection });
      await result.current.scheduleChunk({ ...makeChunk("First section", 10, 10), ...firstSection });
      await result.current.scheduleChunk({
        ...makeChunk("Second section", 10, 10),
        index: 2,
        total: 2,
        textStart: 13,
        textEnd: 27,
      });
      await result.current.togglePlay();
    });
    flushNextAnimationFrame();

    await act(async () => {
      result.current.seekTo(2.5);
      await Promise.resolve();
    });
    act(() => {
      result.current.replaceSegment("segment-1", {
        ...makeChunk("First retake", 10, 10),
        index: 1,
        total: 2,
        textStart: 0,
        textEnd: 13,
      });
    });

    expect(result.current.totalDuration).toBe(2);
    expect(result.current.currentTime).toBeCloseTo(1.5, 6);
    expect(result.current.segments).toEqual([
      expect.objectContaining({ id: "segment-1", text: "First retake", startSec: 0, endSec: 1 }),
      expect.objectContaining({ id: "segment-2", text: "Second section", startSec: 1, endSec: 2 }),
    ]);
    expect(result.current.getAudioCacheSnapshot()).toHaveLength(2);
  });

  it("restarts from the beginning when toggled at the end", async () => {
    const { result } = renderHook(() => useAudioPlayer());

    await act(async () => {
      await result.current.scheduleChunk(makeChunk("Only", 4, 4));
      await result.current.togglePlay();
      result.current.seekTo(1);
      await Promise.resolve();
      await result.current.togglePlay();
    });

    expect(result.current.isPlaying).toBe(true);
    expect(result.current.currentTime).toBe(0);
  });

  it("keeps playback open at the generated buffer edge until streaming completes", async () => {
    const { result } = renderHook(() => useAudioPlayer());

    act(() => {
      result.current.beginStream();
    });

    await act(async () => {
      await result.current.scheduleChunk(makeChunk("First", 4, 4));
    });

    flushNextAnimationFrame();

    const ctx = MockAudioContext.instances[0];
    ctx.currentTime = 1.3;

    flushNextAnimationFrame();

    expect(result.current.currentTime).toBe(1);
    expect(result.current.isPlaying).toBe(true);

    ctx.createdSources[0]?.onended?.();

    await act(async () => {
      await result.current.scheduleChunk(makeChunk("Second", 4, 4));
    });

    const resumedSource = ctx.createdSources.at(-1);
    expect(resumedSource?.startedWith?.[0]).toBeGreaterThanOrEqual(ctx.currentTime);

    act(() => {
      result.current.endStream();
    });

    ctx.currentTime = 2.4;
    flushNextAnimationFrame();

    expect(result.current.currentTime).toBe(2);
    expect(result.current.isPlaying).toBe(false);
  });
});
