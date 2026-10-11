import { afterEach, describe, expect, it, vi } from "vitest";
import { MIC_CAPTURE_PROCESSOR_NAME } from "./micCaptureProtocol";
import {
  DEFAULT_MIC_MAX_DURATION_SEC,
  MicRecorderError,
  createMicRecorder,
  measureMicLevel,
  micConstraints,
  toMicRecorderError,
  type MediaRecorderLike,
  type MicAudioContextLike,
  type MicRecorderOptions,
  type MicRecorderState,
} from "./micRecorder";
import { decodeWav } from "./wavCodec";

class FakeTrack {
  onended: (() => void) | null = null;
  stop = vi.fn();
}

function fakeStream(tracks = [new FakeTrack()]): MediaStream & { tracks: FakeTrack[] } {
  return { tracks, getTracks: () => tracks, getAudioTracks: () => tracks } as unknown as MediaStream & { tracks: FakeTrack[] };
}

class FakeNode {
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeWorkletNode extends FakeNode {
  /** Samples the processor still holds when the flush arrives. */
  tail: Float32Array | null = null;
  answersFlush = true;
  port = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: vi.fn((message: { type: string }) => {
      if (message.type !== "flush" || !this.answersFlush) return;
      if (this.tail) this.emit(this.tail);
      this.port.onmessage?.({ data: { type: "flushed" } } as MessageEvent);
    }),
  };

  emit(samples: Float32Array): void {
    this.port.onmessage?.({ data: { type: "samples", samples } } as MessageEvent);
  }
}

class FakeAnalyser extends FakeNode {
  fftSize = 0;
  getFloatTimeDomainData = vi.fn((array: Float32Array) => array.fill(0.25));
}

class FakeContext implements MicAudioContextLike {
  sampleRate = 100;
  state = "suspended";
  destination = new FakeNode();
  source = new FakeNode();
  analyser = new FakeAnalyser();
  audioWorklet?: { addModule: (url: string) => Promise<void> } = { addModule: vi.fn(async () => {}) };
  createMediaStreamSource = vi.fn(() => this.source);
  createAnalyser = vi.fn(() => this.analyser);
  resume = vi.fn(async () => {
    this.state = "running";
  });
  close = vi.fn(async () => {});
}

/** Follows the spec: stop() on an inactive recorder does nothing and fires no event. */
class FakeMediaRecorder implements MediaRecorderLike {
  mimeType = "audio/webm";
  state = "inactive";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: ((event: Event) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  /** Simulates a recorder that never reports stopping. */
  ignoresStop = false;
  data = new Blob([new Uint8Array([1, 2, 3])]);
  start = vi.fn(() => {
    this.state = "recording";
  });
  stop = vi.fn(() => {
    if (this.state === "inactive" || this.ignoresStop) return;
    this.endRecording();
  });

  /** What the browser does when it ends the recording itself, as on device loss. */
  endRecording(): void {
    this.ondataavailable?.({ data: new Blob([]) } as BlobEvent);
    this.ondataavailable?.({ data: this.data } as BlobEvent);
    this.state = "inactive";
    this.onstop?.(new Event("stop"));
  }
}

function setup(overrides: Partial<MicRecorderOptions> = {}) {
  const stream = fakeStream();
  const context = new FakeContext();
  const node = new FakeWorkletNode();
  const mediaRecorder = new FakeMediaRecorder();
  const states: MicRecorderState[] = [];
  const getUserMedia = vi.fn(async (constraints?: MediaStreamConstraints) => {
    void constraints;
    return stream;
  });
  const createWorkletNode = vi.fn(() => node);
  const options: MicRecorderOptions = {
    maxDurationSec: 1,
    mediaDevices: { getUserMedia },
    createAudioContext: () => context,
    createWorkletNode,
    loadWorkletUrl: async () => "/assets/mic-capture.js",
    createMediaRecorder: () => mediaRecorder,
    decodeAudio: vi.fn(async () => ({ channels: [new Float32Array(150).fill(0.2), new Float32Array(150).fill(0.4)], sampleRate: 100 })),
    onStateChange: (state) => states.push(state),
    ...overrides,
  };
  const recorder = createMicRecorder(options);
  return { recorder, stream, context, node, mediaRecorder, states, getUserMedia, createWorkletNode, options };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("mic recorder helpers", () => {
  it("disables browser voice processing and pins a chosen device", () => {
    expect(micConstraints()).toEqual({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
    expect(micConstraints("mic-2").audio).toMatchObject({ deviceId: { exact: "mic-2" } });
  });

  it("measures levels", () => {
    expect(measureMicLevel(new Float32Array([0.5, -0.5, Number.NaN, 0]), 2)).toEqual({ peak: 0.5, rms: Math.sqrt(0.125), dbfs: 20 * Math.log10(Math.sqrt(0.125)), elapsedSec: 2 });
    expect(measureMicLevel(new Float32Array(0), 0)).toEqual({ peak: 0, rms: 0, dbfs: -100, elapsedSec: 0 });
  });

  it("maps capture failures to explainable codes", () => {
    const codes = ["NotAllowedError", "SecurityError", "NotFoundError", "OverconstrainedError", "NotReadableError", "AbortError"]
      .map((name) => toMicRecorderError(new DOMException("x", name)).code);
    expect(codes).toEqual(["permission-denied", "permission-denied", "no-device", "no-device", "device-busy", "device-busy"]);
    expect(toMicRecorderError(new Error("Boom"))).toMatchObject({ code: "capture-failed", message: "Boom" });
    expect(toMicRecorderError(null)).toMatchObject({ code: "capture-failed", message: "Recording failed." });
    const original = new MicRecorderError("empty", "x");
    expect(toMicRecorderError(original)).toBe(original);
    expect(toMicRecorderError(new DOMException("x", "NotAllowedError")).cause).toBeInstanceOf(DOMException);
  });

  it("validates the maximum duration", () => {
    expect(() => createMicRecorder({ maxDurationSec: 0 })).toThrow(RangeError);
    expect(() => createMicRecorder({ maxDurationSec: 601 })).toThrow(/between 0 and 600/);
    expect(DEFAULT_MIC_MAX_DURATION_SEC).toBe(20);
  });
});

describe("worklet capture", () => {
  it("records mono PCM, meters it and releases everything on stop", async () => {
    const onLevel = vi.fn();
    const { recorder, stream, context, node, states, getUserMedia, createWorkletNode } = setup({ onLevel, deviceId: "mic-1" });
    await recorder.start();
    expect(getUserMedia).toHaveBeenCalledWith(micConstraints("mic-1"));
    expect(context.audioWorklet?.addModule).toHaveBeenCalledWith("/assets/mic-capture.js");
    expect(createWorkletNode).toHaveBeenCalledWith(context, MIC_CAPTURE_PROCESSOR_NAME, expect.objectContaining({ channelCount: 1, channelCountMode: "explicit" }));
    expect(context.source.connect).toHaveBeenCalledWith(node);
    expect(node.connect).toHaveBeenCalledWith(context.destination);
    expect(context.resume).toHaveBeenCalled();
    expect(recorder.getState()).toBe("recording");
    expect(recorder.getMode()).toBe("worklet");

    node.emit(new Float32Array(50).fill(0.5));
    // Malformed messages are ignored.
    node.port.onmessage?.({ data: { type: "samples", samples: [1, 2] } } as MessageEvent);
    node.port.onmessage?.({ data: null } as MessageEvent);
    expect(onLevel).toHaveBeenCalledTimes(1);
    expect(onLevel.mock.calls[0][0]).toMatchObject({ peak: 0.5, elapsedSec: 0.5 });

    node.tail = new Float32Array(10).fill(-0.5);
    const recording = await recorder.stop();
    expect(node.port.postMessage).toHaveBeenCalledWith({ type: "flush" });
    expect(recording).toMatchObject({ sampleRate: 100, durationSec: 0.6, mode: "worklet", stoppedBy: "user" });
    expect(recording.samples).toHaveLength(60);
    expect(recording.samples[55]).toBe(-0.5);
    expect(decodeWav(recording.wav).channels[0]).toHaveLength(60);
    expect(stream.tracks[0].stop).toHaveBeenCalled();
    expect(context.close).toHaveBeenCalled();
    expect(context.source.disconnect).toHaveBeenCalled();
    expect(node.disconnect).toHaveBeenCalled();
    expect(node.port.onmessage).toBeNull();
    expect(states).toEqual(["starting", "recording", "stopping", "idle"]);
    expect(recorder.getMode()).toBeNull();
  });

  it("stops by itself at the maximum duration", async () => {
    const onAutoStop = vi.fn();
    const { recorder, node, context } = setup({ onAutoStop });
    context.state = "running";
    await recorder.start();
    expect(context.resume).not.toHaveBeenCalled();
    node.emit(new Float32Array(80).fill(0.1));
    node.emit(new Float32Array(80).fill(0.2));
    await vi.waitFor(() => expect(onAutoStop).toHaveBeenCalled());
    const { recording } = onAutoStop.mock.calls[0][0];
    expect(recording.samples).toHaveLength(100);
    expect(recording.stoppedBy).toBe("max-duration");
    expect(recorder.getState()).toBe("idle");
  });

  it("keeps samples that arrive before recording is reported and drops ones past the limit", async () => {
    const onAutoStop = vi.fn();
    const { recorder, node, context } = setup({ onAutoStop });
    context.resume = vi.fn(async () => {
      node.emit(new Float32Array(120).fill(0.3));
    });
    await recorder.start();
    // The limit was reached while starting; the next batch triggers the stop.
    node.emit(new Float32Array(10));
    await vi.waitFor(() => expect(onAutoStop).toHaveBeenCalled());
    expect(onAutoStop.mock.calls[0][0].recording.samples).toHaveLength(100);
  });

  it("stops when the microphone goes away", async () => {
    const onAutoStop = vi.fn();
    const { recorder, node, stream } = setup({ onAutoStop });
    await recorder.start();
    node.emit(new Float32Array(30).fill(0.3));
    stream.tracks[0].onended?.();
    await vi.waitFor(() => expect(onAutoStop).toHaveBeenCalled());
    expect(onAutoStop.mock.calls[0][0].recording).toMatchObject({ stoppedBy: "device-ended" });
    // Tracks are detached on release, so a late ended event is harmless.
    expect(stream.tracks[0].onended).toBeNull();
  });

  it("reports an empty recording and a failed auto-stop", async () => {
    const { recorder, stream } = setup();
    await recorder.start();
    await expect(recorder.stop()).rejects.toMatchObject({ code: "empty" });
    expect(recorder.getState()).toBe("idle");

    const onAutoStop = vi.fn();
    const second = setup({ onAutoStop });
    await second.recorder.start();
    second.stream.tracks[0].onended?.();
    await vi.waitFor(() => expect(onAutoStop).toHaveBeenCalled());
    expect(onAutoStop.mock.calls[0][0].error).toMatchObject({ code: "empty" });
    expect(stream.tracks[0].stop).toHaveBeenCalled();
  });

  it("does not hang when the processor never answers the flush", async () => {
    vi.useFakeTimers();
    const { recorder, node } = setup();
    node.answersFlush = false;
    await recorder.start();
    node.emit(new Float32Array(20).fill(0.1));
    const stopped = recorder.stop();
    // A second stop shares the first.
    expect(recorder.stop()).toBe(stopped);
    await vi.advanceTimersByTimeAsync(500);
    await expect(stopped).resolves.toMatchObject({ durationSec: 0.2 });
  });

  it("guards against misuse", async () => {
    const { recorder } = setup();
    await expect(recorder.stop()).rejects.toMatchObject({ code: "not-recording" });
    await recorder.start();
    await expect(recorder.start()).rejects.toMatchObject({ code: "busy" });
    recorder.cancel();
    await expect(createMicRecorder({ mediaDevices: undefined }).start()).rejects.toMatchObject({ code: "unsupported" });
  });
});

describe("cancellation", () => {
  it("backs out of a start still waiting for permission", async () => {
    let grant: (stream: MediaStream) => void = () => {};
    const stream = fakeStream();
    const { recorder, states } = setup({
      mediaDevices: { getUserMedia: () => new Promise<MediaStream>((resolve) => { grant = resolve; }) },
    });
    const started = recorder.start();
    expect(recorder.getState()).toBe("starting");
    recorder.cancel();
    expect(recorder.getState()).toBe("idle");
    grant(stream);
    await expect(started).rejects.toMatchObject({ code: "cancelled" });
    expect(stream.tracks[0].stop).toHaveBeenCalled();
    expect(states).toEqual(["starting", "idle"]);
  });

  it("backs out when cancelled while the worklet loads", async () => {
    const { recorder, context, stream } = setup();
    context.audioWorklet = {
      addModule: vi.fn(async () => {
        recorder.cancel();
      }),
    };
    await expect(recorder.start()).rejects.toMatchObject({ code: "cancelled" });
    expect(context.close).toHaveBeenCalled();
    expect(stream.tracks[0].stop).toHaveBeenCalled();
  });

  it("discards a running recording and ignores late audio", async () => {
    const onLevel = vi.fn();
    const { recorder, node, context, stream } = setup({ onLevel });
    await recorder.start();
    const handler = node.port.onmessage;
    recorder.cancel();
    handler?.({ data: { type: "samples", samples: new Float32Array(10) } } as MessageEvent);
    expect(onLevel).not.toHaveBeenCalled();
    expect(stream.tracks[0].stop).toHaveBeenCalled();
    expect(context.close).toHaveBeenCalled();
    expect(recorder.getState()).toBe("idle");
    await expect(recorder.stop()).rejects.toMatchObject({ code: "not-recording" });
    recorder.cancel();
  });

  it("rejects a stop that a cancel overtook, without disturbing the next start", async () => {
    let finishDecode: (value: { channels: Float32Array[]; sampleRate: number }) => void = () => {};
    const decodeAudio = vi.fn(() => new Promise<{ channels: Float32Array[]; sampleRate: number }>((resolve) => { finishDecode = resolve; }));
    const { recorder, states } = setup({ preferMediaRecorder: true, decodeAudio });
    await recorder.start();
    const stopped = recorder.stop();
    expect(recorder.getState()).toBe("stopping");
    await vi.waitFor(() => expect(decodeAudio).toHaveBeenCalled());
    recorder.cancel();
    await recorder.start();
    finishDecode({ channels: [new Float32Array(10)], sampleRate: 100 });
    await expect(stopped).rejects.toMatchObject({ code: "cancelled" });
    expect(recorder.getState()).toBe("recording");
    expect(states.slice(-3)).toEqual(["idle", "starting", "recording"]);
    recorder.cancel();
  });
});

describe("MediaRecorder fallback", () => {
  it("falls back when the worklet cannot load and decodes the recording", async () => {
    const { recorder, context, mediaRecorder, stream } = setup();
    context.audioWorklet = { addModule: vi.fn(async () => { throw new Error("CSP"); }) };
    await recorder.start();
    expect(recorder.getMode()).toBe("media-recorder");
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(mediaRecorder.start).toHaveBeenCalledWith(250);
    const recording = await recorder.stop();
    // Stereo is averaged and the decoded 1.5 s is cut to the 1 s limit.
    expect(recording).toMatchObject({ sampleRate: 100, mode: "media-recorder", stoppedBy: "user" });
    expect(recording.samples).toHaveLength(100);
    expect(recording.samples[0]).toBeCloseTo(0.3);
    expect(stream.tracks[0].stop).toHaveBeenCalled();
  });

  it("meters through an analyser and stops at the time limit", async () => {
    vi.useFakeTimers();
    let clock = 0;
    const onLevel = vi.fn();
    const onAutoStop = vi.fn();
    const { recorder, context, mediaRecorder } = setup({ preferMediaRecorder: true, onLevel, onAutoStop, now: () => clock });
    await recorder.start();
    expect(context.analyser.fftSize).toBe(2048);
    expect(context.source.connect).toHaveBeenCalledWith(context.analyser);
    clock = 400;
    await vi.advanceTimersByTimeAsync(50);
    expect(onLevel).toHaveBeenLastCalledWith(expect.objectContaining({ peak: 0.25, elapsedSec: 0.4 }));
    clock = 1000;
    await vi.advanceTimersByTimeAsync(950);
    await vi.waitFor(() => expect(onAutoStop).toHaveBeenCalled());
    expect(mediaRecorder.stop).toHaveBeenCalledTimes(1);
    expect(onAutoStop.mock.calls[0][0].recording).toMatchObject({ stoppedBy: "max-duration" });
    expect(context.analyser.disconnect).toHaveBeenCalled();
    const calls = onLevel.mock.calls.length;
    await vi.advanceTimersByTimeAsync(200);
    expect(onLevel).toHaveBeenCalledTimes(calls);
  });

  it("records without a meter when metering is unavailable or not wanted", async () => {
    const plain = setup({ preferMediaRecorder: true });
    await plain.recorder.start();
    expect(plain.context.createMediaStreamSource).not.toHaveBeenCalled();
    plain.recorder.cancel();

    const broken = setup({ preferMediaRecorder: true, onLevel: vi.fn() });
    broken.context.createAnalyser = vi.fn(() => {
      throw new Error("no analyser");
    });
    await broken.recorder.start();
    await expect(broken.recorder.stop()).resolves.toMatchObject({ mode: "media-recorder" });
  });

  it("stops on a recorder error and reports an empty blob", async () => {
    const onAutoStop = vi.fn();
    const { recorder, mediaRecorder } = setup({ preferMediaRecorder: true, onAutoStop });
    mediaRecorder.data = new Blob([]);
    await recorder.start();
    mediaRecorder.onerror?.(new ErrorEvent("error"));
    await vi.waitFor(() => expect(onAutoStop).toHaveBeenCalled());
    expect(onAutoStop.mock.calls[0][0].error).toMatchObject({ code: "empty" });
    // Errors after the recorder stopped are ignored.
    mediaRecorder.onerror?.(new ErrorEvent("error"));
  });

  it("finishes when the browser already stopped the recorder before the track ended", async () => {
    const onAutoStop = vi.fn();
    const { recorder, mediaRecorder, stream } = setup({ preferMediaRecorder: true, onAutoStop });
    await recorder.start();
    mediaRecorder.endRecording();
    // The track's ended event arrives after the recorder's stop event.
    stream.tracks[0].onended?.();
    await vi.waitFor(() => expect(onAutoStop).toHaveBeenCalled());
    expect(onAutoStop.mock.calls[0][0].recording).toMatchObject({ stoppedBy: "device-ended", mode: "media-recorder" });
    expect(mediaRecorder.stop).not.toHaveBeenCalled();
    expect(recorder.getState()).toBe("idle");
    await expect(recorder.start()).resolves.toBeUndefined();
    recorder.cancel();
  });

  it("does not hang when the recorder never reports stopping", async () => {
    vi.useFakeTimers();
    const { recorder, mediaRecorder } = setup({ preferMediaRecorder: true });
    await recorder.start();
    mediaRecorder.ignoresStop = true;
    mediaRecorder.ondataavailable?.({ data: mediaRecorder.data } as BlobEvent);
    const stopped = recorder.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(stopped).resolves.toMatchObject({ mode: "media-recorder", stoppedBy: "user" });
    expect(recorder.getState()).toBe("idle");
  });

  it("fails clearly when neither capture path exists", async () => {
    const { recorder, context, stream } = setup({ createMediaRecorder: null });
    context.audioWorklet = undefined;
    await expect(recorder.start()).rejects.toMatchObject({ code: "unsupported", message: "AudioWorklet is not available." });
    expect(stream.tracks[0].stop).toHaveBeenCalled();
    const noRecorder = setup({ createMediaRecorder: null, preferMediaRecorder: true });
    await expect(noRecorder.recorder.start()).rejects.toMatchObject({ code: "unsupported" });
    expect(noRecorder.recorder.getState()).toBe("idle");
  });
});

describe("default browser adapters", () => {
  it("reports missing Web Audio and MediaRecorder support", async () => {
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("MediaRecorder", undefined);
    const recorder = createMicRecorder({ mediaDevices: { getUserMedia: async () => fakeStream() } });
    await expect(recorder.start()).rejects.toMatchObject({ code: "unsupported", message: "Web Audio is not available." });
  });

  it("builds real nodes, recorders and decoders from the globals", async () => {
    const context = new FakeContext();
    const decodeContext = {
      decodeAudioData: vi.fn(async () => ({ numberOfChannels: 1, sampleRate: 100, getChannelData: () => new Float32Array(20).fill(0.1) })),
      close: vi.fn(async () => {}),
    };
    let contexts = 0;
    vi.stubGlobal("AudioContext", vi.fn(function AudioContextStub() {
      contexts += 1;
      return contexts === 1 ? context : decodeContext;
    }));
    const node = new FakeWorkletNode();
    const AudioWorkletNodeStub = vi.fn(function AudioWorkletNodeStub() {
      return node;
    });
    vi.stubGlobal("AudioWorkletNode", AudioWorkletNodeStub);
    const mediaRecorder = new FakeMediaRecorder();
    vi.stubGlobal("MediaRecorder", vi.fn(function MediaRecorderStub() {
      return mediaRecorder;
    }));

    const recorder = createMicRecorder({ mediaDevices: { getUserMedia: async () => fakeStream() }, loadWorkletUrl: async () => "/w.js" });
    await recorder.start();
    expect(AudioWorkletNodeStub).toHaveBeenCalledWith(context, MIC_CAPTURE_PROCESSOR_NAME, expect.any(Object));
    recorder.cancel();

    const fallback = createMicRecorder({ mediaDevices: { getUserMedia: async () => fakeStream() }, preferMediaRecorder: true });
    await fallback.start();
    const recording = await fallback.stop();
    expect(recording.samples).toHaveLength(20);
    expect(decodeContext.close).toHaveBeenCalled();
  });

  it("bundles the capture worklet as a same-origin module URL", async () => {
    const module = await import("./micCapture.worklet.ts?worker&url");
    expect(typeof module.default).toBe("string");
  });
});
