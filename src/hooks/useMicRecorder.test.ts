import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MicRecorderError, type MicRecorder, type MicRecorderOptions, type MicRecording } from "../lib/micRecorder";
import { useMicRecorder } from "./useMicRecorder";

const recording: MicRecording = {
  samples: new Float32Array(10),
  sampleRate: 10,
  durationSec: 1,
  wav: new Uint8Array(0),
  mode: "worklet",
  stoppedBy: "user",
};

function fakeFactory() {
  const created: Array<{ options: MicRecorderOptions; recorder: MicRecorder & Record<"start" | "stop" | "cancel", ReturnType<typeof vi.fn>> }> = [];
  const createRecorder = vi.fn((options: MicRecorderOptions) => {
    const recorder = {
      getState: () => "idle" as const,
      getMode: () => null,
      start: vi.fn(async () => options.onStateChange?.("recording")),
      stop: vi.fn(async () => {
        options.onStateChange?.("idle");
        return recording;
      }),
      cancel: vi.fn(() => options.onStateChange?.("idle")),
    };
    created.push({ options, recorder });
    return recorder;
  });
  return { createRecorder, created };
}

describe("useMicRecorder", () => {
  it("drives a recorder and mirrors its state, level and result", async () => {
    const { createRecorder, created } = fakeFactory();
    const { result } = renderHook(() => useMicRecorder({ createRecorder, deviceId: "mic-1", maxDurationSec: 15 }));
    expect(created[0].options).toMatchObject({ deviceId: "mic-1", maxDurationSec: 15 });

    await act(() => result.current.start());
    expect(result.current.state).toBe("recording");
    act(() => created[0].options.onLevel?.({ peak: 0.5, rms: 0.2, dbfs: -14, elapsedSec: 1 }));
    expect(result.current.level).toMatchObject({ peak: 0.5 });

    let stopped: MicRecording | null = null;
    await act(async () => {
      stopped = await result.current.stop();
    });
    expect(stopped).toBe(recording);
    expect(result.current).toMatchObject({ state: "idle", level: null, recording, error: null });
    act(() => result.current.reset());
    expect(result.current.recording).toBeNull();
  });

  it("reports start and stop failures but not cancellations", async () => {
    const { createRecorder, created } = fakeFactory();
    const { result } = renderHook(() => useMicRecorder({ createRecorder }));
    const recorder = created[0].recorder;

    recorder.start.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    await act(() => result.current.start());
    expect(result.current.error?.code).toBe("permission-denied");

    recorder.start.mockRejectedValueOnce(new MicRecorderError("cancelled", "Recording was cancelled."));
    await act(() => result.current.start());
    expect(result.current.error).toBeNull();

    recorder.stop.mockRejectedValueOnce(new MicRecorderError("empty", "Nothing was recorded."));
    await act(async () => {
      expect(await result.current.stop()).toBeNull();
    });
    expect(result.current.error?.code).toBe("empty");

    recorder.stop.mockRejectedValueOnce(new MicRecorderError("cancelled", "x"));
    await act(async () => {
      await result.current.stop();
    });
    expect(result.current.error?.code).toBe("empty");
  });

  it("surfaces automatic stops", () => {
    const { createRecorder, created } = fakeFactory();
    const { result } = renderHook(() => useMicRecorder({ createRecorder }));
    act(() => created[0].options.onAutoStop?.({ recording: { ...recording, stoppedBy: "max-duration" } }));
    expect(result.current.recording?.stoppedBy).toBe("max-duration");
    act(() => created[0].options.onAutoStop?.({ error: new MicRecorderError("empty", "x") }));
    expect(result.current.error?.code).toBe("empty");
  });

  it("rebuilds on option changes, cancels on demand and on unmount", () => {
    const { createRecorder, created } = fakeFactory();
    const { result, rerender, unmount } = renderHook((props: { deviceId: string }) => useMicRecorder({ createRecorder, ...props }), {
      initialProps: { deviceId: "a" },
    });
    act(() => result.current.cancel());
    expect(created[0].recorder.cancel).toHaveBeenCalledTimes(1);
    rerender({ deviceId: "b" });
    expect(created).toHaveLength(2);
    expect(created[0].recorder.cancel).toHaveBeenCalledTimes(2);
    unmount();
    expect(created[1].recorder.cancel).toHaveBeenCalledTimes(1);
  });

  it("does nothing once the recorder is gone", async () => {
    const { createRecorder } = fakeFactory();
    const { result, unmount } = renderHook(() => useMicRecorder({ createRecorder }));
    const { start, stop, cancel } = result.current;
    unmount();
    await expect(start()).resolves.toBeUndefined();
    await expect(stop()).resolves.toBeNull();
    expect(() => cancel()).not.toThrow();
  });

  it("uses the real recorder by default", () => {
    const { result } = renderHook(() => useMicRecorder());
    expect(result.current.state).toBe("idle");
  });
});
