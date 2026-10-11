/**
 * Supertonic TTS Web Worker
 *
 * Runs Supertonic inference off the main thread. The message loop, generation
 * run lock, and chunk emission come from the shared worker kit (./kit).
 */

import { env, pipeline, TextToAudioPipeline } from "@huggingface/transformers";
import type { RawAudio } from "@huggingface/transformers";
import type { InferenceBackend, WorkerInMessage } from "../types";
import {
  SUPERTONIC_MODEL_ID,
  SUPERTONIC_MODEL_REVISION,
  SUPERTONIC_INTER_CHUNK_SILENCE_SEC,
} from "../constants";
import { normalizeRawAudioOutput } from "../lib/audioOutput";
import {
  chunkForSupertonicDetailed,
  rechunkChunkForRetry,
  type TextChunk,
} from "../lib/chunking";
import { resolveSentenceSpeed, tuneChunkText } from "../lib/textTuning";
import { getTransformersModelCache, initializeTransformersCache } from "../lib/transformersCache";
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
import { BackendIndependentLoadError, loadWithBackendFallback, MAX_WASM_THREADS } from "./kit/backends";
import { clampSpeed, emitAudioChunk, resolveChunkPauseSec } from "./kit/emit";
import type { GenerationTicket } from "./kit/generation";
import { createLoadProgress } from "./kit/progress";
import { errorMessage, generationMeta } from "./kit/protocol";
import { createWorkerRuntime, type GenerateMessage, type LoadMessage } from "./kit/runtime";

const BACKENDS: readonly InferenceBackend[] = ["webgpu", "wasm"];
// Pipeline downloads fill the bar up to here; voice preload and warm-up take the rest.
const PIPELINE_PROGRESS_MAX = 84;
const WARMUP_PROGRESS_PERCENT = 92;
const EMBEDDINGS_READY_PROGRESS = 99;
const PERF_DEBUG = import.meta.env.DEV;

let tts: TextToAudioPipeline | null = null;
let activeBackend: InferenceBackend | null = null;
let supertonicStyleDim: number | null = null;
const voiceStore = createSupertonicVoiceStore(fetchBinaryFile, parseEmbeddingBuffer);
const workerRuntime = createWorkerRuntime({ load: loadModel, generate });
const { port, generations } = workerRuntime;

interface PerfTrace {
  finish: (extra?: Record<string, unknown>) => void;
  mark: (name: string) => void;
}

function createPerfTrace(label: string, initial: Record<string, unknown> = {}): PerfTrace {
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

/** True once `ticket` was superseded; finishes the trace so a stopped generation still logs. */
function finishIfSuperseded(ticket: GenerationTicket, perf: PerfTrace, emitted: number): boolean {
  if (ticket.isCurrent()) return false;
  perf.finish({ cancelled: true, emitted });
  return true;
}

function postLoadProgress(percent: number): void {
  port.post({ type: "LOAD_PROGRESS", percent });
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
    modelId: SUPERTONIC_MODEL_ID,
    revision: SUPERTONIC_MODEL_REVISION,
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

function getTaggedText(text: string, language = "en"): string {
  if (!["en", "ko", "es", "pt", "fr"].includes(language)) {
    throw new Error(`Unsupported Supertonic 2 language: ${language}`);
  }
  return `<${language}>${text}</${language}>`;
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

function emitChunk(
  message: GenerateMessage,
  chunk: TextChunk,
  output: RawAudio,
  index: number,
  total: number,
  hasFollowing: boolean,
): void {
  const normalized = normalizeRawAudioOutput(output);
  emitAudioChunk(port, {
    generationId: message.generationId,
    audio: normalized.audio,
    samplingRate: normalized.samplingRate,
    text: chunk.text,
    index,
    total,
    textStart: chunk.start,
    textEnd: chunk.end,
    pauseKind: chunk.pauseKind,
    pauseSec: resolveChunkPauseSec({
      hasFollowing,
      pauseKind: chunk.pauseKind,
      // A boundary the chunker gave no pause still gets the inter-chunk gap.
      pauseAfterSec: chunk.pauseAfterSec > 0 ? chunk.pauseAfterSec : SUPERTONIC_INTER_CHUNK_SILENCE_SEC,
      pauseOverridesSec: message.pauseOverridesSec,
      finalPauseSec: message.finalPauseSec,
    }),
  });
}

async function loadModel({ forceReload = false, preferredVoice, debugProfiling = false }: LoadMessage): Promise<void> {
  const perf = createPerfTrace("load", {
    debugProfiling,
    forceReload,
    preferredVoice: resolveSupertonicVoice(preferredVoice),
  });

  if (tts && activeBackend && !forceReload) {
    try {
      await preloadPreferredVoice(preferredVoice);
      perf.mark("voicePreloadReady");
    } catch (voicePreloadError) {
      // The resident pipeline is still healthy — never tear it down over a
      // transient voice fetch failure. The voice lazy-loads on generate.
      if (PERF_DEBUG) {
        console.warn("[supertonic] Voice preload failed on resident pipeline", voicePreloadError);
      }
    }
    postLoadProgress(EMBEDDINGS_READY_PROGRESS);
    perf.finish({ backend: activeBackend });
    port.post({ type: "READY", backend: activeBackend });
    return;
  }

  // Dropped before the first await, so a GENERATE that arrives during the
  // reload is refused instead of running on the pipeline being released.
  const previousTts = tts;
  tts = null;
  activeBackend = null;
  supertonicStyleDim = null;
  if (forceReload) voiceStore.clear();
  try {
    // The runtime superseded the running generation when a forced reload
    // arrived; never release the pipeline under its in-flight inference.
    await generations.idle();
    await disposeSupertonicPipeline(previousTts);

    const progress = createLoadProgress({ report: postLoadProgress, range: [0, PIPELINE_PROGRESS_MAX] });
    progress.reset();
    await initializeTransformersCache();
    const loaded = await loadWithBackendFallback<TextToAudioPipeline>({
      backends: BACKENDS,
      load: async (backend) => {
        configureDebugProfiling(debugProfiling && backend === "webgpu");
        configureTransformersOnnxRuntime(env, TRANSFORMERS_ONNX_WASM_ASSETS, {
          backend,
          maxWasmThreads: MAX_WASM_THREADS,
        });
        return (await pipeline("text-to-speech", SUPERTONIC_MODEL_ID, {
          device: backend,
          // Model repo only ships fp32 weights — no fp16/q8 variants available.
          revision: SUPERTONIC_MODEL_REVISION,
          progress_callback: (info: unknown) => progress.handleTransformersEvent(info),
          session_options: debugProfiling ? { enableProfiling: true } : {},
        })) as TextToAudioPipeline;
      },
      // Runs on every backend; on WebGPU the first inference also compiles
      // the shaders before READY instead of on the first chunk.
      warmUp: async (instance) => {
        perf.mark("pipelineReady");
        postLoadProgress(PIPELINE_PROGRESS_MAX);
        let speakerEmbeddings: Float32Array;
        try {
          // The voice store validates embeddings against this dimension.
          supertonicStyleDim = getSupertonicStyleDim(instance);
          speakerEmbeddings = await preloadPreferredVoice(preferredVoice);
        } catch (error) {
          // A bad model config or voice download fails on every backend.
          throw new BackendIndependentLoadError(error);
        }
        perf.mark("voicePreloadReady");
        postLoadProgress(WARMUP_PROGRESS_PERCENT);
        await warmUpPipeline(instance, speakerEmbeddings);
      },
      dispose: disposeSupertonicPipeline,
      onFallback: () => {
        // The WASM attempt starts over from a fresh pipeline.
        supertonicStyleDim = null;
        progress.reset();
      },
      failureMessage: "Failed to load Supertonic model",
    });
    postLoadProgress(EMBEDDINGS_READY_PROGRESS);
    perf.mark("warmupReady");

    tts = loaded.instance;
    activeBackend = loaded.backend;
    perf.finish({ backend: activeBackend });
    port.post({ type: "READY", backend: activeBackend });
  } catch (error) {
    supertonicStyleDim = null;
    throw error;
  }
}

async function generate(message: GenerateMessage, ticket: GenerationTicket): Promise<void> {
  const ttsInstance = tts;
  if (!ttsInstance) throw new Error("Model not loaded yet");

  const {
    text,
    voice,
    quality,
    sentenceSpeedVariance = 0,
    pronunciationRules = [],
    emphasisStrength = 0,
    language = "en",
  } = message;
  getTaggedText("", language); // Validate before loading voice data or running inference.
  const perf = createPerfTrace("generate", {
    backend: activeBackend,
    quality,
    sentenceSpeedVariance,
    voice: resolveSupertonicVoice(voice),
  });
  if (!isSupertonicVoice(voice)) throw new Error(`Unknown voice: ${voice}`);
  const hadCachedVoice = voiceStore.get(voice) !== null;
  const speakerEmbeddings = await voiceStore.ensure(voice);
  if (finishIfSuperseded(ticket, perf, 0)) return;
  if (!hadCachedVoice) {
    perf.mark("voiceLazyLoadReady");
  }

  const normalizedSpeed = clampSpeed(message.speed);
  // The embedding never changes within a generation — build the tensor once
  // instead of re-allocating it per inference call.
  const speakerEmbeddingsTensor = createSpeakerEmbeddingsTensor(speakerEmbeddings);
  const runtimeProfile = { backend: activeBackend, quality };
  // The chunks the Reader previews, first chunk capped for a faster start.
  const initialChunks = chunkForSupertonicDetailed(text, { runtime: runtimeProfile });
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
  let firstChunkFailure: { error: unknown } | null = null;
  let recordedFirstChunk = false;
  let hasDynamicTotal = false;

  let batchingDisabled = false;

  while (ticket.isCurrent() && queue.length > 0) {
    const selectedBatch = takeSupertonicBatch(queue, {
      backend: activeBackend,
      emitted,
      sentenceSpeedVariance,
      batchingDisabled,
    }).filter(({ chunk }) => chunk.text.trim().length > 0);
    if (selectedBatch.length === 0) continue;

    const total = hasDynamicTotal ? 0 : emitted + selectedBatch.length + queue.length;

    if (selectedBatch.length > 1) {
      let batchEmittedCount = 0;
      try {
        const taggedTexts = selectedBatch.map(({ chunk }) => getTaggedText(
          tuneChunkText(chunk.text, pronunciationRules, emphasisStrength),
          language,
        ));
        const output = await ttsInstance(taggedTexts, {
          speaker_embeddings: speakerEmbeddingsTensor,
          num_inference_steps: quality,
          speed: normalizedSpeed,
        }) as RawAudio | RawAudio[];
        if (finishIfSuperseded(ticket, perf, emitted)) return;
        const outputs = Array.isArray(output) ? output : [output];

        if (outputs.length !== selectedBatch.length) {
          throw new Error(`Expected ${selectedBatch.length} batch outputs, received ${outputs.length}.`);
        }

        for (const [index, item] of selectedBatch.entries()) {
          const hasFollowing = index < selectedBatch.length - 1 || queue.length > 0;
          emitChunk(message, item.chunk, outputs[index], emitted + 1, total, hasFollowing);
          emitted += 1;
          batchEmittedCount = index + 1;
          if (!recordedFirstChunk) {
            perf.mark("firstChunkReady");
            recordedFirstChunk = true;
          }
        }

        continue;
      } catch {
        if (finishIfSuperseded(ticket, perf, emitted)) return;
        batchingDisabled = true;
        hasDynamicTotal = true;
        // Only requeue/retry items that were not already emitted; the first
        // unemitted item falls through to the single-chunk retry below.
        queue.unshift(...selectedBatch.slice(batchEmittedCount + 1));
        selectedBatch.splice(0, batchEmittedCount);
      }
    }

    const [{ chunk, depth }] = selectedBatch;
    try {
      const tunedText = tuneChunkText(chunk.text, pronunciationRules, emphasisStrength);
      const chunkSpeed = clampSpeed(resolveSentenceSpeed(normalizedSpeed, sentenceSpeedVariance, tunedText));
      const output = (await ttsInstance(getTaggedText(tunedText, language), {
        speaker_embeddings: speakerEmbeddingsTensor,
        num_inference_steps: quality,
        speed: chunkSpeed,
      })) as RawAudio;
      if (finishIfSuperseded(ticket, perf, emitted)) return;
      emitChunk(message, chunk, output, emitted + 1, total, queue.length > 0);
      emitted += 1;
      if (!recordedFirstChunk) {
        perf.mark("firstChunkReady");
        recordedFirstChunk = true;
      }
    } catch (error) {
      if (finishIfSuperseded(ticket, perf, emitted)) return;
      if (depth >= 2) {
        firstChunkFailure ??= { error };
        continue;
      }

      const retryChunks = rechunkChunkForRetry(chunk, {
        runtime: runtimeProfile,
        attempt: depth + 1,
      });

      if (retryChunks.length <= 1) {
        firstChunkFailure ??= { error };
        continue;
      }

      hasDynamicTotal = true;
      queue.unshift(...retryChunks.map((retryChunk) => ({ chunk: retryChunk, depth: depth + 1 })));
    }
  }

  if (finishIfSuperseded(ticket, perf, emitted)) return;

  if (firstChunkFailure) {
    throw new Error(`Generation completed with skipped segments after ${emitted} chunks: ${errorMessage(firstChunkFailure.error)}`);
  }

  if (emitted === 0) {
    throw new Error("Model returned no audio chunks.");
  }

  perf.finish({ emitted });
  port.post({ type: "GENERATION_COMPLETE", ...generationMeta(message.generationId) });
}

self.onmessage = (event: MessageEvent<WorkerInMessage>) => {
  workerRuntime.handleMessage(event.data);
};
