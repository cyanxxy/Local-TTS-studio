import { MIC_CAPTURE_PROCESSOR_NAME, type MicCaptureOutboundMessage } from "./micCaptureProtocol";
import { concatSamples, downmixToMono } from "./pcmTransforms";
import { REFERENCE_DURATION_LIMITS } from "./referenceAudio";
import { encodeWavPcm16 } from "./wavCodec";

/**
 * Microphone capture for clone references. Audio is captured as raw PCM
 * through an AudioWorklet served from the app's own origin (the desktop CSP
 * allows scripts only from 'self'), with MediaRecorder as a fallback where
 * worklets are unavailable. Browser voice processing (echo cancellation,
 * noise suppression, auto gain) is turned off because it smears the timbre a
 * clone copies. The result is mono Float32 PCM plus a 16-bit WAV, ready for
 * the reference checks and the voice library.
 *
 * The browser APIs are reached through small injectable interfaces so the
 * recorder can be unit-tested without a microphone.
 */

export type MicRecorderState = "idle" | "starting" | "recording" | "stopping";
export type MicCaptureMode = "worklet" | "media-recorder";
export type MicStopReason = "user" | "max-duration" | "device-ended";
export type MicRecorderErrorCode =
  | "unsupported"
  | "permission-denied"
  | "no-device"
  | "device-busy"
  | "busy"
  | "not-recording"
  | "empty"
  | "cancelled"
  | "capture-failed";

export class MicRecorderError extends Error {
  readonly code: MicRecorderErrorCode;

  constructor(code: MicRecorderErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MicRecorderError";
    this.code = code;
  }
}

export interface MicLevel {
  /** Highest absolute sample in the measured block, 0-1. */
  peak: number;
  rms: number;
  /** RMS level in dBFS, floored at -100. */
  dbfs: number;
  /** Seconds captured so far. */
  elapsedSec: number;
}

export interface MicRecording {
  samples: Float32Array;
  sampleRate: number;
  durationSec: number;
  /** 16-bit PCM mono WAV of `samples`. */
  wav: Uint8Array;
  mode: MicCaptureMode;
  stoppedBy: MicStopReason;
}

export interface AudioNodeLike {
  connect(destination: AudioNodeLike): unknown;
  disconnect(): void;
}

export interface AnalyserLike extends AudioNodeLike {
  fftSize: number;
  getFloatTimeDomainData(array: Float32Array<ArrayBuffer>): void;
}

export interface MicAudioContextLike {
  readonly sampleRate: number;
  readonly state: string;
  readonly destination: AudioNodeLike;
  readonly audioWorklet?: { addModule(moduleUrl: string): Promise<void> };
  createMediaStreamSource(stream: MediaStream): AudioNodeLike;
  createAnalyser(): AnalyserLike;
  resume(): Promise<void>;
  close(): Promise<void>;
}

export interface WorkletNodeLike extends AudioNodeLike {
  readonly port: {
    onmessage: ((event: MessageEvent) => void) | null;
    postMessage(message: unknown): void;
  };
}

export interface MediaRecorderLike {
  readonly mimeType: string;
  ondataavailable: ((event: BlobEvent) => void) | null;
  onstop: ((event: Event) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  start(timeslice?: number): void;
  stop(): void;
}

export interface MicRecorderOptions {
  /** Stop automatically after this many seconds; defaults to Qwen3 Base's 20 s limit. */
  maxDurationSec?: number;
  deviceId?: string;
  /** Called about 20 times a second while recording. */
  onLevel?: (level: MicLevel) => void;
  onStateChange?: (state: MicRecorderState) => void;
  /** The recorder stopped by itself (time limit or the device went away). */
  onAutoStop?: (result: { recording: MicRecording } | { error: MicRecorderError }) => void;
  /** Skip the worklet and record with MediaRecorder. */
  preferMediaRecorder?: boolean;
  mediaDevices?: Pick<MediaDevices, "getUserMedia">;
  createAudioContext?: () => MicAudioContextLike;
  createWorkletNode?: (context: MicAudioContextLike, name: string, options: AudioWorkletNodeOptions) => WorkletNodeLike;
  /** URL of the bundled capture worklet module. */
  loadWorkletUrl?: () => Promise<string>;
  createMediaRecorder?: ((stream: MediaStream) => MediaRecorderLike) | null;
  /** Decode a MediaRecorder blob to PCM channels. */
  decodeAudio?: (bytes: ArrayBuffer) => Promise<{ channels: Float32Array[]; sampleRate: number }>;
  now?: () => number;
}

export interface MicRecorder {
  getState(): MicRecorderState;
  getMode(): MicCaptureMode | null;
  /** Ask for the microphone and start capturing. */
  start(): Promise<void>;
  /** Stop and return the recording. Calls during an ongoing stop share it. */
  stop(): Promise<MicRecording>;
  /** Stop and discard everything, releasing the microphone. */
  cancel(): void;
}

export const DEFAULT_MIC_MAX_DURATION_SEC = REFERENCE_DURATION_LIMITS["qwen3-base"].maxSec;
export const MAX_MIC_DURATION_SEC = 600;
const LEVEL_INTERVAL_MS = 50;
const FLUSH_TIMEOUT_MS = 500;
const MEDIA_RECORDER_TIMESLICE_MS = 250;

/** Voice processing smears the timbre a clone copies, so it stays off. */
export function micConstraints(deviceId?: string): MediaStreamConstraints {
  return {
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
    video: false,
  };
}

export function measureMicLevel(samples: Float32Array, elapsedSec: number): MicLevel {
  let peak = 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = Number.isFinite(samples[index]) ? samples[index] : 0;
    peak = Math.max(peak, Math.abs(value));
    sum += value * value;
  }
  const rms = samples.length > 0 ? Math.sqrt(sum / samples.length) : 0;
  return { peak, rms, dbfs: rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100, elapsedSec };
}

/** Turn getUserMedia failures into codes the UI can explain. */
export function toMicRecorderError(error: unknown): MicRecorderError {
  if (error instanceof MicRecorderError) return error;
  const name = (error as { name?: unknown } | null)?.name;
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return new MicRecorderError("permission-denied", "Microphone access was denied. Allow it in your browser or system settings and try again.", { cause: error });
    case "NotFoundError":
    case "OverconstrainedError":
      return new MicRecorderError("no-device", "No microphone was found. Connect one and try again.", { cause: error });
    case "NotReadableError":
    case "AbortError":
      return new MicRecorderError("device-busy", "The microphone could not be opened. Close other apps using it and try again.", { cause: error });
    default:
      return new MicRecorderError("capture-failed", error instanceof Error && error.message ? error.message : "Recording failed.", { cause: error });
  }
}

async function defaultDecodeAudio(bytes: ArrayBuffer): Promise<{ channels: Float32Array[]; sampleRate: number }> {
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(bytes);
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
    return { channels, sampleRate: buffer.sampleRate };
  } finally {
    void context.close();
  }
}

function defaultLoadWorkletUrl(): Promise<string> {
  // `?worker&url` bundles the processor and its imports as one same-origin
  // module, which is what audioWorklet.addModule needs under the app's CSP.
  return import("./micCapture.worklet.ts?worker&url").then((module) => module.default);
}

function isCaptureMessage(data: unknown): data is MicCaptureOutboundMessage {
  if (typeof data !== "object" || data === null) return false;
  const message = data as { type?: unknown; samples?: unknown };
  return message.type === "flushed" || (message.type === "samples" && message.samples instanceof Float32Array);
}

interface Session {
  stream: MediaStream;
  mode: MicCaptureMode;
  sampleRate: number;
  maxFrames: number;
  chunks: Float32Array[];
  frames: number;
  /** Ends capture and resolves with the captured audio. */
  finish: () => Promise<{ chunks: Float32Array[]; sampleRate: number }>;
  release: () => void;
}

export function createMicRecorder(options: MicRecorderOptions = {}): MicRecorder {
  const maxDurationSec = options.maxDurationSec ?? DEFAULT_MIC_MAX_DURATION_SEC;
  if (!Number.isFinite(maxDurationSec) || maxDurationSec <= 0 || maxDurationSec > MAX_MIC_DURATION_SEC) {
    throw new RangeError(`The maximum recording length must be between 0 and ${MAX_MIC_DURATION_SEC} seconds.`);
  }
  const mediaDevices = options.mediaDevices ?? globalThis.navigator?.mediaDevices;
  const createAudioContext = options.createAudioContext
    ?? (typeof AudioContext === "undefined" ? undefined : (): MicAudioContextLike => new AudioContext());
  const createWorkletNode = options.createWorkletNode
    ?? ((context, name, nodeOptions) => new AudioWorkletNode(context as unknown as BaseAudioContext, name, nodeOptions));
  const loadWorkletUrl = options.loadWorkletUrl ?? defaultLoadWorkletUrl;
  const createMediaRecorder: ((stream: MediaStream) => MediaRecorderLike) | null = options.createMediaRecorder !== undefined
    ? options.createMediaRecorder
    : typeof MediaRecorder === "undefined" ? null : (stream: MediaStream) => new MediaRecorder(stream);
  const decodeAudio = options.decodeAudio ?? defaultDecodeAudio;
  const now = options.now ?? (() => performance.now());

  let state: MicRecorderState = "idle";
  let session: Session | null = null;
  let stopping: Promise<MicRecording> | null = null;
  // Bumped by cancel() so a start() still waiting on permission backs out.
  let generation = 0;

  function setState(next: MicRecorderState): void {
    if (state === next) return;
    state = next;
    options.onStateChange?.(next);
  }

  function stopTracks(stream: MediaStream): void {
    for (const track of stream.getTracks()) {
      track.onended = null;
      track.stop();
    }
  }

  function reportLevel(samples: Float32Array, current: Session): void {
    options.onLevel?.(measureMicLevel(samples, current.frames / current.sampleRate));
  }

  /** Append captured audio, trimming at the limit; true once the limit is hit. */
  function append(current: Session, samples: Float32Array): boolean {
    const room = current.maxFrames - current.frames;
    if (room <= 0) return true;
    const kept = samples.length > room ? samples.subarray(0, room) : samples;
    current.chunks.push(kept);
    current.frames += kept.length;
    return current.frames >= current.maxFrames;
  }

  async function startWorklet(stream: MediaStream): Promise<Session> {
    if (!createAudioContext) throw new MicRecorderError("unsupported", "Web Audio is not available.");
    const context = createAudioContext();
    let source: AudioNodeLike | null = null;
    let node: WorkletNodeLike | null = null;
    let released = false;
    const release = () => {
      released = true;
      if (node) node.port.onmessage = null;
      source?.disconnect();
      node?.disconnect();
      void context.close().catch(() => {});
    };
    try {
      if (!context.audioWorklet) throw new MicRecorderError("unsupported", "AudioWorklet is not available.");
      await context.audioWorklet.addModule(await loadWorkletUrl());
      source = context.createMediaStreamSource(stream);
      node = createWorkletNode(context, MIC_CAPTURE_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: "explicit",
        channelInterpretation: "speakers",
      });
      const workletNode = node;
      let flushed: (() => void) | null = null;
      const current: Session = {
        stream,
        mode: "worklet",
        sampleRate: context.sampleRate,
        maxFrames: Math.ceil(maxDurationSec * context.sampleRate),
        chunks: [],
        frames: 0,
        release,
        finish: () => new Promise((resolve) => {
          const done = () => {
            clearTimeout(timer);
            resolve({ chunks: current.chunks, sampleRate: current.sampleRate });
          };
          // A processor that never answers (a suspended context) must not hang the stop.
          const timer = setTimeout(done, FLUSH_TIMEOUT_MS);
          flushed = done;
          workletNode.port.postMessage({ type: "flush" });
        }),
      };
      workletNode.port.onmessage = (event) => {
        if (!isCaptureMessage(event.data)) return;
        if (event.data.type === "flushed") {
          flushed?.();
          return;
        }
        // Batches arrive until the flush answers, including the tail after stop().
        if (released) return;
        const reachedLimit = append(current, event.data.samples);
        reportLevel(event.data.samples, current);
        if (reachedLimit && state === "recording") void autoStop("max-duration");
      };
      source.connect(workletNode);
      // The processor writes silence; the connection only keeps it pulled.
      workletNode.connect(context.destination);
      if (context.state === "suspended") await context.resume();
      return current;
    } catch (error) {
      release();
      throw error;
    }
  }

  function startMediaRecorder(stream: MediaStream): Session {
    if (!createMediaRecorder) throw new MicRecorderError("unsupported", "This browser cannot record audio.");
    const recorder = createMediaRecorder(stream);
    const blobs: Blob[] = [];
    const startedAt = now();
    let meter: { context: MicAudioContextLike; source: AudioNodeLike; analyser: AnalyserLike } | null = null;
    try {
      if (createAudioContext && options.onLevel) {
        const context = createAudioContext();
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 2048;
        source.connect(analyser);
        meter = { context, source, analyser };
      }
    } catch {
      // Metering is a nicety; record without it.
      meter = null;
    }
    const block = new Float32Array(meter?.analyser.fftSize ?? 0);
    const elapsedSec = () => Math.min(maxDurationSec, Math.max(0, (now() - startedAt) / 1000));
    const levelTimer = setInterval(() => {
      if (!meter) return;
      meter.analyser.getFloatTimeDomainData(block);
      options.onLevel?.(measureMicLevel(block, elapsedSec()));
    }, LEVEL_INTERVAL_MS);
    const limitTimer = setTimeout(() => {
      if (state === "recording") void autoStop("max-duration");
    }, maxDurationSec * 1000);

    let stopped: Promise<void> | null = null;
    const release = () => {
      clearInterval(levelTimer);
      clearTimeout(limitTimer);
      recorder.ondataavailable = null;
      recorder.onerror = null;
      if (meter) {
        meter.source.disconnect();
        meter.analyser.disconnect();
        void meter.context.close().catch(() => {});
        meter = null;
      }
    };
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) blobs.push(event.data);
    };
    // A recorder error ends capture; whatever was recorded is still returned.
    recorder.onerror = () => {
      if (state === "recording") void autoStop("device-ended");
    };
    const current: Session = {
      stream,
      mode: "media-recorder",
      sampleRate: 0,
      maxFrames: 0,
      chunks: [],
      frames: 0,
      release,
      finish: async () => {
        stopped ??= new Promise<void>((resolve) => {
          recorder.onstop = () => resolve();
          recorder.stop();
        });
        await stopped;
        const blob = new Blob(blobs, { type: recorder.mimeType || "audio/webm" });
        if (blob.size === 0) return { chunks: [], sampleRate: 0 };
        const decoded = await decodeAudio(await blob.arrayBuffer());
        current.sampleRate = decoded.sampleRate;
        current.maxFrames = Math.ceil(maxDurationSec * decoded.sampleRate);
        append(current, downmixToMono(decoded.channels));
        return { chunks: current.chunks, sampleRate: decoded.sampleRate };
      },
    };
    recorder.start(MEDIA_RECORDER_TIMESLICE_MS);
    return current;
  }

  function teardown(current: Session): void {
    current.release();
    stopTracks(current.stream);
    if (session === current) session = null;
  }

  async function finishSession(current: Session, stoppedBy: MicStopReason): Promise<MicRecording> {
    const stopGeneration = generation;
    setState("stopping");
    try {
      const captured = await current.finish();
      if (stopGeneration !== generation) throw new MicRecorderError("cancelled", "Recording was cancelled.");
      const samples = concatSamples(captured.chunks);
      if (samples.length === 0 || captured.sampleRate <= 0) {
        throw new MicRecorderError("empty", "Nothing was recorded. Check that the right microphone is selected.");
      }
      return {
        samples,
        sampleRate: captured.sampleRate,
        durationSec: samples.length / captured.sampleRate,
        wav: encodeWavPcm16(samples, captured.sampleRate),
        mode: current.mode,
        stoppedBy,
      };
    } catch (error) {
      throw toMicRecorderError(error);
    } finally {
      teardown(current);
      // After a cancel the recorder may already be starting again.
      if (stopGeneration === generation) {
        stopping = null;
        setState("idle");
      }
    }
  }

  function autoStop(reason: MicStopReason): Promise<void> {
    const current = session;
    if (!current || stopping) return Promise.resolve();
    stopping = finishSession(current, reason);
    return stopping.then(
      (recording) => options.onAutoStop?.({ recording }),
      (error: unknown) => options.onAutoStop?.({ error: toMicRecorderError(error) }),
    );
  }

  return {
    getState: () => state,
    getMode: () => session?.mode ?? null,

    async start() {
      if (state !== "idle") throw new MicRecorderError("busy", "The recorder is already in use.");
      if (!mediaDevices?.getUserMedia) {
        throw new MicRecorderError("unsupported", "This browser does not allow microphone recording here.");
      }
      const startGeneration = ++generation;
      setState("starting");
      let stream: MediaStream | null = null;
      try {
        stream = await mediaDevices.getUserMedia(micConstraints(options.deviceId));
        if (startGeneration !== generation) throw new MicRecorderError("cancelled", "Recording was cancelled.");
        let current: Session;
        if (options.preferMediaRecorder) {
          current = startMediaRecorder(stream);
        } else {
          try {
            current = await startWorklet(stream);
          } catch (workletError) {
            if (!createMediaRecorder) throw workletError;
            current = startMediaRecorder(stream);
          }
        }
        if (startGeneration !== generation) {
          current.release();
          throw new MicRecorderError("cancelled", "Recording was cancelled.");
        }
        session = current;
        const capturedStream = stream;
        for (const track of capturedStream.getAudioTracks()) {
          track.onended = () => {
            if (state === "recording" && session?.stream === capturedStream) void autoStop("device-ended");
          };
        }
        setState("recording");
      } catch (error) {
        if (stream) stopTracks(stream);
        // A cancelled start already reset the state.
        if (startGeneration === generation) setState("idle");
        throw toMicRecorderError(error);
      }
    },

    stop() {
      if (stopping) return stopping;
      const current = session;
      if (!current || state !== "recording") {
        return Promise.reject(new MicRecorderError("not-recording", "The recorder is not recording."));
      }
      stopping = finishSession(current, "user");
      return stopping;
    },

    cancel() {
      generation += 1;
      const current = session;
      session = null;
      stopping = null;
      if (current) {
        current.release();
        stopTracks(current.stream);
      }
      setState("idle");
    },
  };
}
