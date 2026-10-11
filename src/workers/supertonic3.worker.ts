/** Electron-renderer-only Supertonic 3 worker. */
import * as ort from "onnxruntime-web";
import type { InferenceBackend, WorkerInMessage } from "../types";
import {
  SUPERTONIC3_LANGUAGES,
  SUPERTONIC3_MODEL_ID,
  SUPERTONIC3_MODEL_REVISION,
  SUPERTONIC3_VOICES,
} from "../constants";
import { chunkForSupertonicDetailed } from "../lib/chunking";
import { resolveSentenceSpeed, tuneChunkText } from "../lib/textTuning";
import { TRANSFORMERS_ONNX_WASM_ASSETS } from "../lib/onnxWasmAssets";
import { getSafeWasmThreadCount } from "../lib/onnxRuntime";
import { verifyPinnedAssetIntegrity, type PinnedAssetIntegrity } from "../lib/pinnedModelFetch";
import { BackendIndependentLoadError, loadWithBackendFallback, MAX_WASM_THREADS } from "./kit/backends";
import { emitAudioChunk, resolveChunkPauseSec } from "./kit/emit";
import type { GenerationTicket } from "./kit/generation";
import { createPrefetcher } from "./kit/prefetch";
import { createLoadProgress, type LoadProgress } from "./kit/progress";
import { generationMeta } from "./kit/protocol";
import { createWorkerRuntime, type GenerateMessage, type LoadMessage } from "./kit/runtime";
import { SUPERTONIC3_ASSETS } from "./manifests/supertonic3";
import {
  createSeededRandom,
  createSupertonic3RuntimeStreaming,
  createSupertonic3Style,
  deriveChunkSeed,
  SUPERTONIC3_MAX_SEED,
  type Supertonic3Config,
  type Supertonic3ModelName,
  type Supertonic3Style,
  type VoiceStyleJson,
  type Supertonic3Runtime,
} from "../lib/supertonic3Runtime";

const CACHE_NAME = "transformers-cache-supertonic3-v1";
const MODEL_FILES = [
  "onnx/tts.json",
  "onnx/unicode_indexer.json",
  "onnx/duration_predictor.onnx",
  "onnx/text_encoder.onnx",
  "onnx/vector_estimator.onnx",
  "onnx/vocoder.onnx",
] as const;
const MODEL_FILE_BY_NAME: Record<Supertonic3ModelName, string> = {
  duration_predictor: "onnx/duration_predictor.onnx",
  text_encoder: "onnx/text_encoder.onnx",
  vector_estimator: "onnx/vector_estimator.onnx",
  vocoder: "onnx/vocoder.onnx",
};
const DEFAULT_VOICE = "M1";
// Exact sizes and repository digests at SUPERTONIC3_MODEL_REVISION, generated
// by scripts/pin-hf-assets.mjs; regenerate the manifest with the revision.
const ASSET_INTEGRITY: Readonly<Record<string, PinnedAssetIntegrity>> = SUPERTONIC3_ASSETS.files;
// Downloads fill the bar up to here; session creation takes the rest.
const DOWNLOAD_PROGRESS_MAX = 94;
// Sessions are created in this order, one buffer at a time.
const SESSION_FILES = [
  MODEL_FILE_BY_NAME.duration_predictor,
  MODEL_FILE_BY_NAME.text_encoder,
  MODEL_FILE_BY_NAME.vector_estimator,
  MODEL_FILE_BY_NAME.vocoder,
];
// While one session is created, the next model file downloads (or is read
// back from the cache and verified) unless it is larger than this. The 256 MB
// vector estimator is therefore only fetched when its turn comes, and at most
// one buffer of up to 128 MB is held ahead: the vocoder, which downloads
// while the vector estimator's session is created.
const PREFETCH_AHEAD_MAX_BYTES = 128 * 1024 * 1024;

let runtime: Supertonic3Runtime | null = null;
let backend: InferenceBackend | null = null;
const styles = new Map<string, Supertonic3Style>();
const workerRuntime = createWorkerRuntime({ load: loadModel, generate });
const { port, generations } = workerRuntime;

function assetUrl(file: string): string {
  return `https://huggingface.co/${SUPERTONIC3_MODEL_ID}/resolve/${SUPERTONIC3_MODEL_REVISION}/${file}`;
}

function styleFile(voice: string): string {
  return `voice_styles/${voice}.json`;
}

/** Byte-weighted load progress over every file a cold load downloads. */
function createModelLoadProgress(): LoadProgress {
  const loadFiles = [...MODEL_FILES, styleFile(DEFAULT_VOICE)];
  return createLoadProgress({
    report: (percent) => port.post({ type: "LOAD_PROGRESS", percent }),
    range: [0, DOWNLOAD_PROGRESS_MAX],
    expectedBytes: Object.fromEntries(loadFiles.map((file) => [file, ASSET_INTEGRITY[file].byteLength])),
  });
}

/**
 * Reads a response body into exactly `byteLength` bytes. The pinned size is
 * authoritative and Content-Length is never used to size the buffer: Hugging
 * Face serves the small JSON assets compressed with no Content-Length, and
 * when one is present it counts encoded bytes, not the decoded body read here.
 */
async function readPinnedBody(
  response: Response,
  file: string,
  byteLength: number,
  progress?: LoadProgress,
): Promise<ArrayBuffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== byteLength) {
      throw new Error(`Supertonic 3 ${file} did not match its pinned size.`);
    }
    return buffer;
  }

  const bytes = new Uint8Array(byteLength);
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (received + value.byteLength > byteLength) {
        throw new Error(`Supertonic 3 ${file} exceeded its pinned size.`);
      }
      bytes.set(value, received);
      received += value.byteLength;
      progress?.update(file, received);
    }
  } catch (error) {
    // Stop the download instead of draining a body that is already rejected.
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  if (received !== byteLength) {
    throw new Error(`Supertonic 3 ${file} was truncated at ${received} of ${byteLength} bytes.`);
  }
  return bytes.buffer;
}

/** Headers for the cached copy, which holds the decoded body. */
function cacheHeaders(response: Response, byteLength: number): Headers {
  const headers = new Headers({ "content-length": String(byteLength) });
  const contentType = response.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  return headers;
}

async function fetchAsset(file: string, progress?: LoadProgress): Promise<ArrayBuffer> {
  const expected = ASSET_INTEGRITY[file];
  if (!expected) throw new Error(`Supertonic 3 ${file} is not a pinned asset.`);
  const url = assetUrl(file);
  const cache = typeof caches === "undefined" ? null : await caches.open(CACHE_NAME);
  const cached = await cache?.match(url);
  if (cached) {
    const buffer = await cached.arrayBuffer();
    if (await verifyPinnedAssetIntegrity(buffer, expected)) {
      progress?.complete(file);
      return buffer;
    }
    await cache?.delete(url);
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${file}: HTTP ${response.status}.`);
  const buffer = await readPinnedBody(response, file, expected.byteLength, progress);
  if (!await verifyPinnedAssetIntegrity(buffer, expected)) {
    throw new Error(`Supertonic 3 ${file} failed integrity verification.`);
  }
  await cache?.put(url, new Response(buffer, { headers: cacheHeaders(response, buffer.byteLength) }));
  progress?.complete(file);
  return buffer;
}

function parseJson<T>(buffer: ArrayBuffer, file: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(buffer)) as T;
  } catch {
    throw new Error(`Supertonic 3 ${file} is invalid JSON.`);
  }
}

function clearStyles(): void {
  for (const style of styles.values()) {
    try {
      style.ttl.dispose();
    } catch {
      // Continue releasing the rest of the style tensors.
    }
    try {
      style.dp.dispose();
    } catch {
      // Continue releasing the rest of the style tensors.
    }
  }
  styles.clear();
}

async function disposeRuntime(value: Supertonic3Runtime | null): Promise<void> {
  await value?.dispose();
}

async function loadStyle(voice: string, progress?: LoadProgress): Promise<Supertonic3Style> {
  const normalized = (SUPERTONIC3_VOICES as readonly string[]).includes(voice) ? voice : DEFAULT_VOICE;
  const cached = styles.get(normalized);
  if (cached) return cached;
  const file = styleFile(normalized);
  const value = parseJson<VoiceStyleJson>(await fetchAsset(file, progress), file);
  const style = createSupertonic3Style(value);
  styles.set(normalized, style);
  return style;
}

/**
 * One single-step synthesis on WebGPU compiles every session's shaders before
 * READY, so the first real chunk does not pay for it, and proves the device
 * can run the graphs at all.
 */
async function warmUpRuntime(instance: Supertonic3Runtime, style: Supertonic3Style): Promise<void> {
  await instance.synthesize("Hello.", "en", style, 1, 1);
}

async function loadModel({ forceReload = false }: LoadMessage): Promise<void> {
  if (runtime && !forceReload) {
    port.post({ type: "READY", voices: [...SUPERTONIC3_VOICES], backend: backend ?? undefined });
    return;
  }
  // Dropped before the first await, so a GENERATE that arrives during the
  // reload is refused instead of running on sessions about to be released.
  const previousRuntime = runtime;
  runtime = null;
  backend = null;
  try {
    // The runtime superseded the running generation when this reload
    // arrived; never release sessions under its in-flight inference.
    await generations.idle();
    clearStyles();
    await disposeRuntime(previousRuntime);
    if (forceReload && typeof caches !== "undefined") await caches.delete(CACHE_NAME);
    const progress = createModelLoadProgress();
    progress.reset();
    ort.env.wasm.wasmPaths = TRANSFORMERS_ONNX_WASM_ASSETS.asyncify;
    ort.env.wasm.numThreads = getSafeWasmThreadCount(MAX_WASM_THREADS);
    const models = createPrefetcher({
      order: SESSION_FILES,
      fetch: (file) => fetchAsset(file, progress),
      sizeOf: (file) => ASSET_INTEGRITY[file].byteLength,
      maxAheadBytes: PREFETCH_AHEAD_MAX_BYTES,
    });
    // The small JSON assets and the first model file download together.
    models.prefetch(SESSION_FILES[0]);
    const [configBuffer, indexerBuffer, defaultStyle] = await Promise.all([
      fetchAsset("onnx/tts.json", progress),
      fetchAsset("onnx/unicode_indexer.json", progress),
      loadStyle(DEFAULT_VOICE, progress),
    ]);
    const config = parseJson<Supertonic3Config>(configBuffer, "onnx/tts.json");
    const indexer = parseJson<number[]>(indexerBuffer, "onnx/unicode_indexer.json");
    // A failed or corrupt download fails on every backend; retrying on WASM
    // would only download it again.
    const loadModelBuffer = (name: Supertonic3ModelName) => models.take(MODEL_FILE_BY_NAME[name])
      .catch((error: unknown) => {
        throw new BackendIndependentLoadError(error);
      });
    const loaded = await loadWithBackendFallback({
      backends: ["webgpu", "wasm"],
      load: (candidate) => createSupertonic3RuntimeStreaming(config, indexer, loadModelBuffer, candidate),
      warmUp: (instance, candidate) => (candidate === "webgpu" ? warmUpRuntime(instance, defaultStyle) : Promise.resolve()),
      dispose: (instance) => instance.dispose(),
      onFallback: () => {
        // The WASM attempt re-reads the model files from the cache.
        progress.reset();
        for (const file of ["onnx/tts.json", "onnx/unicode_indexer.json", styleFile(DEFAULT_VOICE)]) progress.complete(file);
      },
      failureMessage: "Failed to load Supertonic 3.",
    });
    runtime = loaded.instance;
    backend = loaded.backend;
    port.post({ type: "LOAD_PROGRESS", percent: 100 });
    port.post({ type: "READY", voices: [...SUPERTONIC3_VOICES], backend });
  } catch (error) {
    clearStyles();
    throw error;
  }
}

function validateSeed(seed: number | undefined): number | undefined {
  if (seed === undefined) return undefined;
  if (!Number.isInteger(seed) || seed < 0 || seed > SUPERTONIC3_MAX_SEED) {
    throw new Error(`Supertonic 3 seed must be an integer from 0 to ${SUPERTONIC3_MAX_SEED}.`);
  }
  return seed;
}

async function generate(message: GenerateMessage, ticket: GenerationTicket): Promise<void> {
  const activeRuntime = runtime;
  if (!activeRuntime) throw new Error("Supertonic 3 is not loaded.");
  const seed = validateSeed(message.seed);
  const language = (SUPERTONIC3_LANGUAGES as readonly string[]).includes(message.language ?? "")
    ? message.language!
    : "en";
  const style = await loadStyle(message.voice);
  if (!ticket.isCurrent()) return;
  const chunks = chunkForSupertonicDetailed(message.text, {
    minCharacters: 30,
    maxCharacters: language === "ko" || language === "ja" ? 120 : 280,
    runtime: { backend, quality: message.quality },
  });
  const pronunciationRules = message.pronunciationRules ?? [];
  const emphasisStrength = message.emphasisStrength ?? 0;
  const variance = message.sentenceSpeedVariance ?? 0;
  const totalSteps = Math.max(1, Math.min(20, Math.round(message.quality)));
  for (const [index, chunk] of chunks.entries()) {
    const tunedText = tuneChunkText(chunk.text, pronunciationRules, emphasisStrength);
    const audio = await activeRuntime.synthesize(
      tunedText,
      language,
      style,
      totalSteps,
      resolveSentenceSpeed(message.speed, variance, chunk.text),
      { random: seed === undefined ? undefined : createSeededRandom(deriveChunkSeed(seed, tunedText)) },
    );
    if (!ticket.isCurrent()) return;
    emitAudioChunk(port, {
      generationId: message.generationId,
      audio,
      samplingRate: activeRuntime.sampleRate,
      text: chunk.text,
      index: index + 1,
      total: chunks.length,
      textStart: chunk.start,
      textEnd: chunk.end,
      pauseKind: chunk.pauseKind,
      pauseSec: resolveChunkPauseSec({
        hasFollowing: index + 1 < chunks.length,
        pauseKind: chunk.pauseKind,
        pauseAfterSec: chunk.pauseAfterSec,
        pauseOverridesSec: message.pauseOverridesSec,
        finalPauseSec: message.finalPauseSec,
      }),
    });
  }
  port.post({ type: "GENERATION_COMPLETE", ...generationMeta(message.generationId) });
}

self.onmessage = (event: MessageEvent<WorkerInMessage>) => {
  workerRuntime.handleMessage(event.data);
};
