/**
 * Shared pieces of the single-graph StyleTTS-family browser models (Kitten TTS
 * and Paradee): one onnxruntime-web session that maps phoneme ids to a 24 kHz
 * waveform, with the app-level asyncify WASM assets (never kokoro-js's nested
 * runtime).
 */
import * as ort from "onnxruntime-web";
import type { InferenceBackend, WorkerOutMessage } from "../types";
import type { WordTiming } from "../workers/kit/emit";
import { getSafeWasmThreadCount } from "./onnxRuntime";
import { TRANSFORMERS_ONNX_WASM_ASSETS } from "./onnxWasmAssets";

export const STYLE_TTS_SAMPLE_RATE = 24_000;
/** Both graphs' PL-BERT text encoders have 512 positions, pads included (verified: 513 fails). */
export const STYLE_TTS_MAX_INPUT_TOKENS = 512;
const MAX_WASM_THREADS = 4;

export type { WordTiming };

/** AUDIO_CHUNK plus the optional exact word timings that models with a duration output provide. */
export type StyleTtsAudioChunkMessage = Extract<WorkerOutMessage, { type: "AUDIO_CHUNK" }> & {
  wordTimings?: WordTiming[];
};
export type StyleTtsOutMessage = Exclude<WorkerOutMessage, { type: "AUDIO_CHUNK" }> | StyleTtsAudioChunkMessage;

/** The subset of an onnxruntime-web session these runtimes use, so tests can supply fakes. */
export type StyleTtsSession = Pick<ort.InferenceSession, "run" | "release">;

/** Thrown before inference when a chunk phonemizes to more tokens than the graph accepts. */
export class ChunkTooLongError extends Error {
  readonly tokenCount: number;

  constructor(tokenCount: number) {
    super(`The chunk needs ${tokenCount} phoneme tokens; the model accepts at most ${STYLE_TTS_MAX_INPUT_TOKENS}.`);
    this.name = "ChunkTooLongError";
    this.tokenCount = tokenCount;
  }
}

export function configureStyleTtsWasm(): void {
  ort.env.wasm.wasmPaths = TRANSFORMERS_ONNX_WASM_ASSETS.asyncify;
  ort.env.wasm.numThreads = getSafeWasmThreadCount(MAX_WASM_THREADS);
}

export async function createStyleTtsSession(
  model: ArrayBuffer,
  backend: InferenceBackend,
): Promise<ort.InferenceSession> {
  return ort.InferenceSession.create(new Uint8Array(model), {
    executionProviders: [backend],
    graphOptimizationLevel: "all",
  });
}

export async function releaseStyleTtsSession(session: StyleTtsSession | null): Promise<void> {
  try {
    await session?.release();
  } catch {
    // The session is being dropped either way.
  }
}

export function idsTensor(ids: readonly number[]): ort.Tensor {
  return new ort.Tensor("int64", BigInt64Array.from(ids, (id) => BigInt(id)), [1, ids.length]);
}

export function disposeOutputs(outputs: ort.InferenceSession.ReturnType): void {
  for (const tensor of new Set(Object.values(outputs))) {
    try {
      tensor.dispose();
    } catch {
      // GPU-backed outputs may already be released.
    }
  }
}

/**
 * The waveform output's samples, after rejecting the NaN/Inf output an
 * unsupported backend can produce. This is the output's own storage: slice it
 * before posting, because AUDIO_CHUNK transfers the whole underlying buffer.
 */
export function finiteWaveform(output: ort.Tensor | undefined): Float32Array {
  if (!output || !(output.data instanceof Float32Array)) {
    throw new Error("The model returned no float32 waveform.");
  }
  const samples = output.data;
  for (let index = 0; index < samples.length; index += 1) {
    if (!Number.isFinite(samples[index])) throw new Error("The model returned a non-finite waveform.");
  }
  return samples;
}

/** Below -60 dBFS: what these graphs emit around speech is digital silence, far quieter than any phoneme. */
const NEAR_SILENCE = 1e-3;
const SILENCE_MARGIN_SEC = 0.05;

/**
 * Cut leading and trailing near-silence down to a 50 ms margin, so the pauses
 * the worker renders between chunks are the pauses listeners hear. Returns a
 * standalone copy; all-silent input becomes empty.
 */
export function trimNearSilence(samples: Float32Array, sampleRate: number): Float32Array {
  let first = 0;
  while (first < samples.length && Math.abs(samples[first]) < NEAR_SILENCE) first += 1;
  if (first === samples.length) return new Float32Array(0);
  let last = samples.length - 1;
  while (Math.abs(samples[last]) < NEAR_SILENCE) last -= 1;
  const margin = Math.round(SILENCE_MARGIN_SEC * sampleRate);
  return samples.slice(Math.max(0, first - margin), Math.min(samples.length, last + 1 + margin));
}
