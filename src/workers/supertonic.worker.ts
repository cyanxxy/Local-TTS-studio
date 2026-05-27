/**
 * Supertonic TTS Web Worker
 *
 * Runs Supertonic inference off the main thread.
 * Communicates via postMessage using typed WorkerInMessage / WorkerOutMessage.
 */

import { env, pipeline, TextToAudioPipeline } from "@huggingface/transformers";
import type { RawAudio } from "@huggingface/transformers";
import type { InferenceBackend, PronunciationRule, WorkerInMessage, WorkerOutMessage } from "../types";
import {
  SUPERTONIC_INTER_CHUNK_SILENCE_SEC,
} from "../constants";
import { concatFloat32Arrays, createSilence } from "../lib/audio";
import { normalizeRawAudioOutput } from "../lib/audioOutput";
import {
  chunkWithConstraintsDetailed,
  rechunkChunkForRetry,
  type TextChunk,
} from "../lib/chunking";
import { resolvePauseSeconds, resolveSentenceSpeed, tuneChunkText } from "../lib/textTuning";
import { getTransformersModelCache, initializeTransformersCache } from "../lib/transformersCache";
import { canInitializeWebGPU } from "../lib/webgpu";
import {
  buildTransformersRemoteFileUrl,
  createSupertonicSpeakerEmbeddingsTensor,
  createSupertonicVoiceStore,
  isSupertonicVoice,
  resolveSupertonicVoice,
  takeSupertonicBatch,
  type QueuedSupertonicChunk,
  validateSupertonicVoiceEmbedding,
} from "../lib/supertonicRuntime";
import { TRANSFORMERS_ONNX_WASM_ASSETS } from "../lib/onnxWasmAssets";
import { configureTransformersOnnxRuntime } from "../lib/onnxRuntime";

const MODEL_ID = "onnx-community/Supertonic-TTS-2-ONNX";
const MODEL_REVISION = "68d4d9420d0e0e51d14656e1ec5c9b091490b49e";
const BACKENDS: InferenceBackend[] = ["webgpu", "wasm"];
const SPEED_MIN_SAFE = 0.85;
const SPEED_MAX_SAFE = 1.15;
const PIPELINE_PROGRESS_MAX = 84;
const WARMUP_PROGRESS_PERCENT = 92;
const EMBEDDINGS_READY_PROGRESS = 99;
const MAX_WASM_THREADS = 4;
const PERF_DEBUG = import.meta.env.DEV;

interface ProgressInfo {
  status: string;
  file?: string;
  loaded?: number;
  total?: number;
}

let tts: TextToAudioPipeline | null = null;
let activeBackend: InferenceBackend | null = null;
let supertonicStyleDim: number | null = null;
let activeGenerationEpoch = 0;
const voiceStore = createSupertonicVoiceStore(fetchBinaryFile, parseEmbeddingBuffer);

interface PerfTrace {
  finish: (extra?: Record<string, unknown>) => void;
  mark: (name: string) => void;
}

function post(msg: WorkerOutMessage) {
  if (msg.type === "AUDIO_CHUNK") {
    self.postMessage(msg, { transfer: [msg.audio.buffer as ArrayBuffer] });
  } else {
    self.postMessage(msg);
  }
}

function clampPercent(percent: number): number {
  return Math.max(0, Math.min(100, percent));
}

function clampSpeed(speed: number): number {
  return Math.max(SPEED_MIN_SAFE, Math.min(SPEED_MAX_SAFE, speed));
}

function createPerfTrace(label: string, initial: Record<string, unknown> = {}) {
  const startedAt = performance.now();
  const marks: Array<[string, number]> = [];

  return {
    finish(extra: Record<string, unknown> = {}) {
      if (!PERF_DEBUG) return;
      const payload = Object.fromEntries(marks);
      console.debug(`[supertonic][${label}]`, {
        ...initial,
        ...payload,
        ...extra,
        totalMs: Math.round((performance.now() - startedAt) * 100) / 100,
      });
    },
    mark(name: string) {
      if (!PERF_DEBUG) return;
      marks.push([name, Math.round((performance.now() - startedAt) * 100) / 100]);
    },
  };
}

function beginGeneration(): number {
  activeGenerationEpoch += 1;
  return activeGenerationEpoch;
}

function invalidateActiveGeneration(): void {
  activeGenerationEpoch += 1;
}

function isGenerationCurrent(generationEpoch: number): boolean {
  return activeGenerationEpoch === generationEpoch;
}

function finishCancelledGenerationIfStale(
  generationEpoch: number,
  perf: PerfTrace,
  emitted: number,
): boolean {
  if (isGenerationCurrent(generationEpoch)) return false;
  perf.finish({ cancelled: true, emitted });
  return true;
}

function postLoadProgress(percent: number): void {
  post({ type: "LOAD_PROGRESS", percent: clampPercent(percent) });
}

function toPercentFromMap(progressMap: Map<string, number>): number {
  if (progressMap.size === 0) return 0;
  const total = Array.from(progressMap.values()).reduce((sum, value) => sum + value, 0);
  return clampPercent((total / progressMap.size) * 100);
}

function updateProgress(progressMap: Map<string, number>, info: ProgressInfo): void {
  if (!info.file) return;

  if (
    info.status === "progress"
    && typeof info.loaded === "number"
    && typeof info.total === "number"
    && info.total > 0
  ) {
    progressMap.set(info.file, clampPercent((info.loaded / info.total) * 100) / 100);
    postLoadProgress((toPercentFromMap(progressMap) / 100) * PIPELINE_PROGRESS_MAX);
    return;
  }

  if (info.status === "done") {
    progressMap.set(info.file, 1);
    postLoadProgress((toPercentFromMap(progressMap) / 100) * PIPELINE_PROGRESS_MAX);
  }
}

function configureDebugProfiling(enabled: boolean): void {
  const webgpuEnv = env.backends.onnx.webgpu;
  if (!webgpuEnv) return;

  webgpuEnv.profiling = enabled
    ? {
      mode: "default",
      ondata: (data) => {
        if (PERF_DEBUG) {
          console.debug("[supertonic][ort]", data);
        }
      },
    }
    : { mode: "off" };
}

function resolveModelFileUrl(filename: string): string {
  return buildTransformersRemoteFileUrl({
    remoteHost: env.remoteHost,
    remotePathTemplate: env.remotePathTemplate,
    modelId: MODEL_ID,
    revision: MODEL_REVISION,
    filename,
  });
}

function isValidBinaryPayload(buffer: ArrayBuffer, contentLengthHeader: string | null): boolean {
  if (buffer.byteLength <= 0) return false;

  const declaredLength = contentLengthHeader ? Number(contentLengthHeader) : NaN;
  if (Number.isFinite(declaredLength) && declaredLength > 0 && buffer.byteLength !== declaredLength) {
    return false;
  }

  return true;
}

async function fetchBinaryFile(filename: string): Promise<ArrayBuffer> {
  if (!env.allowRemoteModels) {
    throw new Error("Remote model downloads are disabled (`env.allowRemoteModels=false`).");
  }
  const remoteUrl = resolveModelFileUrl(filename);
  const modelCache = await getTransformersModelCache();

  // Store embeddings in the same Cache API bucket as Transformers.js files
  // so app-level cache clearing fully resets model assets.
  if (modelCache) {
    const cached = await modelCache.match(remoteUrl);
    if (cached) {
      const cachedBuffer = await cached.arrayBuffer();
      if (isValidBinaryPayload(cachedBuffer, cached.headers.get("content-length"))) {
        return cachedBuffer;
      }
    }

    const response = await fetch(remoteUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`Failed to load ${filename}: ${response.status}`);
    const responseCopy = response.clone();
    const buffer = await response.arrayBuffer();
    if (!isValidBinaryPayload(buffer, responseCopy.headers.get("content-length"))) {
      throw new Error(`Received truncated model file for ${filename}.`);
    }
    await modelCache.put(remoteUrl, responseCopy).catch(() => undefined);
    return buffer;
  }

  const response = await fetch(remoteUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`Failed to load ${filename}: ${response.status}`);
  const buffer = await response.arrayBuffer();
  if (!isValidBinaryPayload(buffer, response.headers.get("content-length"))) {
    throw new Error(`Received truncated model file for ${filename}.`);
  }
  return buffer;
}

function parseEmbeddingBuffer(buffer: ArrayBuffer, filename: string): Float32Array {
  if (buffer.byteLength === 0 || buffer.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error(`Invalid embedding file for ${filename}.`);
  }

  const values = new Float32Array(buffer);
  return validateSupertonicVoiceEmbedding(values, filename, getSupertonicStyleDim());
}

function getSupertonicStyleDim(styleSource?: TextToAudioPipeline | null): number {
  if (styleSource) {
    const styleDim = Number(
      (styleSource as unknown as { model?: { config?: { style_dim?: unknown } } }).model?.config?.style_dim,
    );
    if (!Number.isInteger(styleDim) || styleDim <= 0) {
      throw new Error("Supertonic model config is missing a valid style dimension.");
    }
    return styleDim;
  }

  if (supertonicStyleDim === null) {
    throw new Error("Supertonic style dimension is unavailable.");
  }

  return supertonicStyleDim;
}

function createSpeakerEmbeddingsTensor(embedding: Float32Array) {
  validateSupertonicVoiceEmbedding(embedding, "speaker embeddings", getSupertonicStyleDim());
  return createSupertonicSpeakerEmbeddingsTensor(embedding);
}

async function preloadPreferredVoice(preferredVoice?: string): Promise<Float32Array> {
  return voiceStore.preload(resolveSupertonicVoice(preferredVoice));
}

async function disposeSupertonicPipeline(instance: TextToAudioPipeline | null): Promise<void> {
  if (!instance) return;
  try {
    await instance.dispose();
  } catch (error) {
    if (PERF_DEBUG) {
      console.warn("[supertonic] Failed to dispose pipeline cleanly", error);
    }
  }
}

async function createPipelineWithFallback(
  progressMap: Map<string, number>,
  debugProfiling: boolean,
  backends: readonly InferenceBackend[] = BACKENDS,
): Promise<{ pipeline: TextToAudioPipeline; backend: InferenceBackend }> {
  await initializeTransformersCache();
  let lastError: unknown = null;

  for (const backend of backends) {
    try {
      configureDebugProfiling(debugProfiling && backend === "webgpu");
      configureTransformersOnnxRuntime(env, TRANSFORMERS_ONNX_WASM_ASSETS, {
        backend,
        maxWasmThreads: MAX_WASM_THREADS,
      });
      if (backend === "webgpu" && !(await canInitializeWebGPU())) {
        throw new Error("WebGPU device initialization failed.");
      }
      const instance = (await pipeline("text-to-speech", MODEL_ID, {
        device: backend,
        // Model repo only ships fp32 weights — no fp16/q8 variants available.
        revision: MODEL_REVISION,
        progress_callback: (info: ProgressInfo) => updateProgress(progressMap, info),
        session_options: debugProfiling ? { enableProfiling: true } : {},
      })) as TextToAudioPipeline;
      return { pipeline: instance, backend };
    } catch (err) {
      lastError = err;
      if (backend === "webgpu") {
        progressMap.clear();
        postLoadProgress(0);
      }
    }
  }

  throw (lastError instanceof Error)
    ? lastError
    : new Error(lastError ? String(lastError) : "Failed to load Supertonic model");
}

function getTaggedText(text: string): string {
  return `<en>${text}</en>`;
}

async function warmUpPipeline(
  instance: TextToAudioPipeline,
  speakerEmbeddings: Float32Array,
): Promise<void> {
  // Warm up — compiles WebGPU shaders on first run.
  // Use 1 step to minimize warmup time (the denoiser shader is the same
  // regardless of step count, so a single pass is sufficient).
  await instance(getTaggedText("Hello"), {
    speaker_embeddings: createSpeakerEmbeddingsTensor(speakerEmbeddings),
    num_inference_steps: 1,
    speed: 1.0,
  });
}

function appendPauseToAudio(
  chunk: TextChunk,
  output: RawAudio,
  hasFollowing: boolean,
  pauseOverridesSec?: Partial<Record<"none" | "comma" | "sentence" | "paragraph", number>>,
) {
  const normalized = normalizeRawAudioOutput(output);
  const fallbackPause = hasFollowing ? SUPERTONIC_INTER_CHUNK_SILENCE_SEC : 0;
  const pauseSec = hasFollowing
    ? resolvePauseSeconds(chunk.pauseKind, chunk.pauseAfterSec > 0 ? chunk.pauseAfterSec : fallbackPause, pauseOverridesSec)
    : 0;

  const audio = pauseSec > 0
    ? concatFloat32Arrays([
      normalized.audio,
      createSilence(pauseSec, normalized.samplingRate),
    ])
    : normalized.audio;

  return {
    audio,
    pauseSec,
    samplingRate: normalized.samplingRate,
  };
}

function emitChunk(
  chunk: TextChunk,
  output: RawAudio,
  emitted: number,
  total: number,
  hasFollowing: boolean,
  pauseOverridesSec?: Partial<Record<"none" | "comma" | "sentence" | "paragraph", number>>,
): number {
  const normalized = appendPauseToAudio(chunk, output, hasFollowing, pauseOverridesSec);
  const nextIndex = emitted + 1;

  post({
    type: "AUDIO_CHUNK",
    audio: normalized.audio,
    samplingRate: normalized.samplingRate,
    text: chunk.text,
    index: nextIndex,
    total,
    textStart: chunk.start,
    textEnd: chunk.end,
    pauseAfterSec: normalized.pauseSec,
    pauseKind: chunk.pauseKind,
  });

  return nextIndex;
}

async function loadModel(
  forceReload: boolean = false,
  preferredVoice?: string,
  debugProfiling: boolean = false,
) {
  let nextTts: TextToAudioPipeline | null = null;
  try {
    const perf = createPerfTrace("load", {
      debugProfiling,
      forceReload,
      preferredVoice: resolveSupertonicVoice(preferredVoice),
    });

    if (forceReload) {
      invalidateActiveGeneration();
      const previousTts = tts;
      tts = null;
      activeBackend = null;
      supertonicStyleDim = null;
      voiceStore.clear();
      await disposeSupertonicPipeline(previousTts);
    }

    if (tts && activeBackend) {
      await preloadPreferredVoice(preferredVoice);
      postLoadProgress(EMBEDDINGS_READY_PROGRESS);
      perf.mark("voicePreloadReady");
      perf.finish({ backend: activeBackend });
      post({ type: "READY", backend: activeBackend });
      return;
    }

    postLoadProgress(0);
    const progressMap = new Map<string, number>();
    let loaded = await createPipelineWithFallback(progressMap, debugProfiling);
    nextTts = loaded.pipeline;
    let nextBackend = loaded.backend;
    perf.mark("pipelineReady");
    supertonicStyleDim = getSupertonicStyleDim(nextTts);

    postLoadProgress(PIPELINE_PROGRESS_MAX);
    let speakerEmbeddings = await preloadPreferredVoice(preferredVoice);
    perf.mark("voicePreloadReady");
    postLoadProgress(WARMUP_PROGRESS_PERCENT);

    try {
      await warmUpPipeline(nextTts, speakerEmbeddings);
    } catch (warmupError) {
      if (nextBackend !== "webgpu") {
        throw warmupError;
      }

      await disposeSupertonicPipeline(nextTts);
      nextTts = null;
      supertonicStyleDim = null;
      progressMap.clear();
      postLoadProgress(0);

      loaded = await createPipelineWithFallback(progressMap, debugProfiling, ["wasm"]);
      nextTts = loaded.pipeline;
      nextBackend = loaded.backend;
      perf.mark("pipelineReady");
      supertonicStyleDim = getSupertonicStyleDim(nextTts);

      postLoadProgress(PIPELINE_PROGRESS_MAX);
      speakerEmbeddings = await preloadPreferredVoice(preferredVoice);
      perf.mark("voicePreloadReady");
      postLoadProgress(WARMUP_PROGRESS_PERCENT);
      await warmUpPipeline(nextTts, speakerEmbeddings);
    }
    postLoadProgress(EMBEDDINGS_READY_PROGRESS);
    perf.mark("warmupReady");

    tts = nextTts;
    activeBackend = nextBackend;

    perf.finish({ backend: activeBackend });
    post({ type: "READY", backend: activeBackend });
  } catch (err) {
    await disposeSupertonicPipeline(nextTts);
    tts = null;
    activeBackend = null;
    supertonicStyleDim = null;
    post({ type: "ERROR", message: err instanceof Error ? err.message : String(err), scope: "load" });
  }
}

async function generate(
  text: string,
  voice: string,
  speed: number,
  quality: number,
  pauseOverridesSec?: Partial<Record<"none" | "comma" | "sentence" | "paragraph", number>>,
  sentenceSpeedVariance: number = 0,
  pronunciationRules: PronunciationRule[] = [],
  emphasisStrength: number = 0,
) {
  const ttsInstance = tts;
  if (!ttsInstance) {
    post({ type: "ERROR", message: "Model not loaded yet", scope: "generate" });
    return;
  }

  const generationEpoch = beginGeneration();

  try {
    const perf = createPerfTrace("generate", {
      backend: activeBackend,
      quality,
      sentenceSpeedVariance,
      voice: resolveSupertonicVoice(voice),
    });
    if (!isSupertonicVoice(voice)) {
      post({ type: "ERROR", message: `Unknown voice: ${voice}`, scope: "generate" });
      return;
    }
    const hadCachedVoice = voiceStore.get(voice) !== null;
    const speakerEmbeddings = await voiceStore.ensure(voice);
    if (finishCancelledGenerationIfStale(generationEpoch, perf, 0)) return;
    if (!hadCachedVoice) {
      perf.mark("voiceLazyLoadReady");
    }

    const normalizedSpeed = clampSpeed(speed);
    const runtimeProfile = { backend: activeBackend, quality };
    const initialChunks = chunkWithConstraintsDetailed(text, { runtime: runtimeProfile });
    if (initialChunks.length === 0) {
      initialChunks.push({
        text,
        start: 0,
        end: text.length,
        pauseAfterSec: 0,
        pauseKind: "none",
      });
    }

    const queue: QueuedSupertonicChunk[] = initialChunks.map((chunk) => ({ chunk, depth: 0 }));
    let emitted = 0;
    let hadChunkFailure = false;
    let firstChunkFailure: unknown = null;
    let recordedFirstChunk = false;

    while (isGenerationCurrent(generationEpoch) && queue.length > 0) {
      const selectedBatch = takeSupertonicBatch(queue, {
        backend: activeBackend,
        emitted,
        sentenceSpeedVariance,
      }).filter(({ chunk }) => chunk.text.trim().length > 0);
      if (selectedBatch.length === 0) continue;

      const total = emitted + selectedBatch.length + queue.length;

      if (selectedBatch.length > 1) {
        try {
          const taggedTexts = selectedBatch.map(({ chunk }) => getTaggedText(
            tuneChunkText(chunk.text, pronunciationRules, emphasisStrength),
          ));
          const output = await ttsInstance(taggedTexts, {
            speaker_embeddings: createSpeakerEmbeddingsTensor(speakerEmbeddings),
            num_inference_steps: quality,
            speed: normalizedSpeed,
          }) as RawAudio | RawAudio[];
          if (finishCancelledGenerationIfStale(generationEpoch, perf, emitted)) return;
          const outputs = Array.isArray(output) ? output : [output];

          if (outputs.length !== selectedBatch.length) {
            throw new Error(`Expected ${selectedBatch.length} batch outputs, received ${outputs.length}.`);
          }

          for (const [index, item] of selectedBatch.entries()) {
            const hasFollowing = index < selectedBatch.length - 1 || queue.length > 0;
            emitted = emitChunk(
              item.chunk,
              outputs[index],
              emitted,
              total,
              hasFollowing,
              pauseOverridesSec,
            );
            if (finishCancelledGenerationIfStale(generationEpoch, perf, emitted)) return;
            if (!recordedFirstChunk) {
              perf.mark("firstChunkReady");
              recordedFirstChunk = true;
            }
          }

          continue;
        } catch {
          if (finishCancelledGenerationIfStale(generationEpoch, perf, emitted)) return;
          queue.unshift(...selectedBatch.slice(1));
        }
      }

      const [{ chunk, depth }] = selectedBatch;
      try {
        const tunedText = tuneChunkText(chunk.text, pronunciationRules, emphasisStrength);
        const chunkSpeed = clampSpeed(resolveSentenceSpeed(normalizedSpeed, sentenceSpeedVariance, tunedText));
        const output = (await ttsInstance(getTaggedText(tunedText), {
          speaker_embeddings: createSpeakerEmbeddingsTensor(speakerEmbeddings),
          num_inference_steps: quality,
          speed: chunkSpeed,
        })) as RawAudio;
        if (finishCancelledGenerationIfStale(generationEpoch, perf, emitted)) return;
        emitted = emitChunk(chunk, output, emitted, total, queue.length > 0, pauseOverridesSec);
        if (finishCancelledGenerationIfStale(generationEpoch, perf, emitted)) return;
        if (!recordedFirstChunk) {
          perf.mark("firstChunkReady");
          recordedFirstChunk = true;
        }
      } catch (error) {
        if (depth >= 2) {
          hadChunkFailure = true;
          if (firstChunkFailure === null) firstChunkFailure = error;
          continue;
        }

        const retryChunks = rechunkChunkForRetry(chunk, {
          runtime: runtimeProfile,
          attempt: depth + 1,
        });

        if (retryChunks.length <= 1) {
          hadChunkFailure = true;
          if (firstChunkFailure === null) firstChunkFailure = error;
          continue;
        }

        queue.unshift(...retryChunks.map((retryChunk) => ({ chunk: retryChunk, depth: depth + 1 })));
      }
    }

    if (finishCancelledGenerationIfStale(generationEpoch, perf, emitted)) {
      return;
    }

    if (hadChunkFailure) {
      const reason = firstChunkFailure instanceof Error ? firstChunkFailure.message : String(firstChunkFailure ?? "unknown error");
      throw new Error(`Generation completed with skipped segments after ${emitted} chunks: ${reason}`);
    }

    if (emitted === 0) {
      throw new Error("Model returned no audio chunks.");
    }

    perf.finish({ emitted });
    post({ type: "GENERATION_COMPLETE" });
  } catch (err) {
    if (!isGenerationCurrent(generationEpoch)) return;
    post({ type: "ERROR", message: err instanceof Error ? err.message : String(err), scope: "generate" });
  }
}

self.onmessage = (e: MessageEvent<WorkerInMessage>) => {
  const msg = e.data;
  switch (msg.type) {
    case "LOAD":
      loadModel(msg.forceReload ?? false, msg.preferredVoice, msg.debugProfiling ?? false);
      break;
    case "GENERATE":
      generate(
        msg.text,
        msg.voice,
        msg.speed,
        msg.quality,
        msg.pauseOverridesSec,
        msg.sentenceSpeedVariance ?? 0,
        msg.pronunciationRules ?? [],
        msg.emphasisStrength ?? 0,
      );
      break;
    case "CANCEL":
      invalidateActiveGeneration();
      break;
  }
};
