/** Electron-renderer-only Supertonic 3 worker. */
import * as ort from "onnxruntime-web";
import type { InferenceBackend, WorkerInMessage, WorkerOutMessage } from "../types";
import {
  SUPERTONIC3_LANGUAGES,
  SUPERTONIC3_MODEL_ID,
  SUPERTONIC3_MODEL_REVISION,
  SUPERTONIC3_VOICES,
} from "../constants";
import { chunkWithConstraintsDetailed } from "../lib/chunking";
import { resolvePauseSeconds, resolveSentenceSpeed, tuneChunkText } from "../lib/textTuning";
import { canInitializeWebGPU } from "../lib/webgpu";
import { TRANSFORMERS_ONNX_WASM_ASSETS } from "../lib/onnxWasmAssets";
import { getSafeWasmThreadCount } from "../lib/onnxRuntime";
import { verifyPinnedAssetIntegrity, type PinnedAssetIntegrity } from "../lib/pinnedModelFetch";
import {
  createSupertonic3Runtime,
  createSupertonic3Style,
  type Supertonic3Config,
  type Supertonic3Style,
  type VoiceStyleJson,
  type Supertonic3Runtime,
} from "../lib/supertonic3Runtime";

const CACHE_NAME = "transformers-cache-supertonic3-v1";
const MAX_WASM_THREADS = 4;
const MODEL_FILES = [
  "onnx/tts.json",
  "onnx/unicode_indexer.json",
  "onnx/duration_predictor.onnx",
  "onnx/text_encoder.onnx",
  "onnx/vector_estimator.onnx",
  "onnx/vocoder.onnx",
] as const;
const LOAD_FILE_COUNT = MODEL_FILES.length + 1;
// Exact sizes and repository hashes from the pinned revision's HF siblings metadata.
// Update this table together with SUPERTONIC3_MODEL_REVISION.
const ASSET_INTEGRITY: Record<string, PinnedAssetIntegrity> = {
  "onnx/tts.json": { byteLength: 8_253, gitBlobSha1: "28575b0793c92607a0f0a292550df9bd17709a79" },
  "onnx/unicode_indexer.json": { byteLength: 277_676, gitBlobSha1: "3aaf4d33024aff0be455633c24b3636b3a810150" },
  "onnx/duration_predictor.onnx": { byteLength: 3_700_147, sha256: "c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db" },
  "onnx/text_encoder.onnx": { byteLength: 36_416_150, sha256: "c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff" },
  "onnx/vector_estimator.onnx": { byteLength: 256_534_781, sha256: "883ac868ea0275ef0e991524dc64f16b3c0376efd7c320af6b53f5b780d7c61c" },
  "onnx/vocoder.onnx": { byteLength: 101_424_195, sha256: "085de76dd8e8d5836d6ca66826601f615939218f90e519f70ee8a36ed2a4c4ba" },
  "voice_styles/F1.json": { byteLength: 292_046, gitBlobSha1: "421365f307ed1535d8da16845031d0e9fa3e60c5" },
  "voice_styles/F2.json": { byteLength: 292_423, gitBlobSha1: "b09a3a433df8a4856d1d7d64736a56ddf37a4ea3" },
  "voice_styles/F3.json": { byteLength: 290_794, gitBlobSha1: "a366f94c77c4b440404071f1a52bed3ccf83a5ff" },
  "voice_styles/F4.json": { byteLength: 291_808, gitBlobSha1: "39c78a52795320c6101b7eaf984c0e2352fbdc18" },
  "voice_styles/F5.json": { byteLength: 291_479, gitBlobSha1: "06983f8816ad00a8eeb7efd37a33d457587e16f8" },
  "voice_styles/M1.json": { byteLength: 291_748, gitBlobSha1: "bddfff85a7c4c140c11620bd7005d86681dccdac" },
  "voice_styles/M2.json": { byteLength: 292_055, gitBlobSha1: "602ff6c4d6d48cdb71c37461f7c175d71fe8b34b" },
  "voice_styles/M3.json": { byteLength: 290_198, gitBlobSha1: "000b60436b77619b933fdc33628ad737595e6794" },
  "voice_styles/M4.json": { byteLength: 291_522, gitBlobSha1: "aae253ae81185fa06a6469c3f1cdff04ed121ddf" },
  "voice_styles/M5.json": { byteLength: 291_469, gitBlobSha1: "0536b252698830f8536c077edcb94e1ce4768ab6" },
};

let runtime: Supertonic3Runtime | null = null;
let backend: InferenceBackend | null = null;
let isLoadingModel = false;
let activeGenerationEpoch = 0;
let loadQueue: Promise<void> = Promise.resolve();
let activeGenerationTask: Promise<void> | null = null;
const styles = new Map<string, Supertonic3Style>();
const loadProgress = new Map<string, number>();

function post(message: WorkerOutMessage): void {
  if (message.type === "AUDIO_CHUNK") {
    self.postMessage(message, { transfer: [message.audio.buffer as ArrayBuffer] });
  } else {
    self.postMessage(message);
  }
}

function assetUrl(file: string): string {
  return `https://huggingface.co/${SUPERTONIC3_MODEL_ID}/resolve/${SUPERTONIC3_MODEL_REVISION}/${file}`;
}

function updateLoadProgress(file: string, fraction: number): void {
  if (!isLoadingModel) return;
  loadProgress.set(file, Math.max(0, Math.min(1, fraction)));
  const total = Array.from(loadProgress.values()).reduce((sum, value) => sum + value, 0);
  post({ type: "LOAD_PROGRESS", percent: (total / LOAD_FILE_COUNT) * 94 });
}

async function assertAssetIntegrity(file: string, buffer: ArrayBuffer): Promise<void> {
  const expected = ASSET_INTEGRITY[file];
  if (!expected || !await verifyPinnedAssetIntegrity(buffer, expected)) {
    throw new Error(`Supertonic 3 ${file} failed integrity verification.`);
  }
}

async function fetchAsset(file: string): Promise<ArrayBuffer> {
  const url = assetUrl(file);
  const cache = typeof caches === "undefined" ? null : await caches.open(CACHE_NAME);
  const cached = await cache?.match(url);
  if (cached) {
    const buffer = await cached.arrayBuffer();
    try {
      await assertAssetIntegrity(file, buffer);
      updateLoadProgress(file, 1);
      return buffer;
    } catch {
      await cache?.delete(url);
    }
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${file}: HTTP ${response.status}.`);
  const declaredLength = Number(response.headers.get("content-length"));
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    await assertAssetIntegrity(file, buffer);
    await cache?.put(url, new Response(buffer, { headers: response.headers }));
    updateLoadProgress(file, 1);
    return buffer;
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.byteLength;
      if (Number.isFinite(declaredLength) && declaredLength > 0) {
        updateLoadProgress(file, received / declaredLength);
      }
    }
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  await assertAssetIntegrity(file, merged.buffer);
  await cache?.put(url, new Response(merged, { headers: response.headers }));
  updateLoadProgress(file, 1);
  return merged.buffer;
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

async function loadStyle(voice: string): Promise<Supertonic3Style> {
  const normalized = (SUPERTONIC3_VOICES as readonly string[]).includes(voice) ? voice : "M1";
  const cached = styles.get(normalized);
  if (cached) return cached;
  const file = `voice_styles/${normalized}.json`;
  const value = parseJson<VoiceStyleJson>(await fetchAsset(file), file);
  const style = createSupertonic3Style(value);
  styles.set(normalized, style);
  return style;
}

async function loadModel(forceReload: boolean): Promise<void> {
  if (runtime && !forceReload) {
    post({ type: "READY", voices: [...SUPERTONIC3_VOICES], backend: backend ?? undefined });
    return;
  }
  if (forceReload && typeof caches !== "undefined") await caches.delete(CACHE_NAME);
  isLoadingModel = true;
  try {
    activeGenerationEpoch += 1;
    if (activeGenerationTask) await activeGenerationTask.catch(() => undefined);
    const previousRuntime = runtime;
    runtime = null;
    backend = null;
    clearStyles();
    await disposeRuntime(previousRuntime);
    loadProgress.clear();
    post({ type: "LOAD_PROGRESS", percent: 0 });
    ort.env.wasm.wasmPaths = TRANSFORMERS_ONNX_WASM_ASSETS.asyncify;
    ort.env.wasm.numThreads = getSafeWasmThreadCount(MAX_WASM_THREADS);
    const [configBuffer, indexerBuffer, durationPredictor, textEncoder, vectorEstimator, vocoder] = await Promise.all(
      MODEL_FILES.map((file) => fetchAsset(file)),
    );
    const config = parseJson<Supertonic3Config>(configBuffer, "onnx/tts.json");
    const indexer = parseJson<number[]>(indexerBuffer, "onnx/unicode_indexer.json");
    const models = {
      duration_predictor: durationPredictor,
      text_encoder: textEncoder,
      vector_estimator: vectorEstimator,
      vocoder,
    };
    const preferredBackend: InferenceBackend = await canInitializeWebGPU() ? "webgpu" : "wasm";
    try {
      runtime = await createSupertonic3Runtime(config, indexer, models, preferredBackend);
      backend = preferredBackend;
    } catch (error) {
      if (preferredBackend === "wasm") throw error;
      runtime = await createSupertonic3Runtime(config, indexer, models, "wasm");
      backend = "wasm";
    }
    await loadStyle("M1");
    post({ type: "LOAD_PROGRESS", percent: 100 });
    post({ type: "READY", voices: [...SUPERTONIC3_VOICES], backend });
  } catch (error) {
    const failedRuntime: Supertonic3Runtime | null = runtime;
    runtime = null;
    backend = null;
    clearStyles();
    await disposeRuntime(failedRuntime);
    throw error;
  } finally {
    isLoadingModel = false;
  }
}

function enqueueModelLoad(forceReload: boolean): Promise<void> {
  const request = loadQueue.catch(() => undefined).then(() => loadModel(forceReload));
  loadQueue = request;
  return request;
}

async function generate(message: Extract<WorkerInMessage, { type: "GENERATE" }>): Promise<void> {
  if (!runtime) throw new Error("Supertonic 3 is not loaded.");
  const epoch = ++activeGenerationEpoch;
  const language = (SUPERTONIC3_LANGUAGES as readonly string[]).includes(message.language ?? "")
    ? message.language!
    : "en";
  const style = await loadStyle(message.voice);
  const chunks = chunkWithConstraintsDetailed(message.text, {
    minCharacters: 30,
    maxCharacters: language === "ko" || language === "ja" ? 120 : 280,
    runtime: { backend, quality: message.quality },
  });
  const pronunciationRules = message.pronunciationRules ?? [];
  const emphasisStrength = message.emphasisStrength ?? 0;
  const variance = message.sentenceSpeedVariance ?? 0;
  for (let index = 0; index < chunks.length; index += 1) {
    if (epoch !== activeGenerationEpoch) return;
    const chunk = chunks[index];
    const speed = resolveSentenceSpeed(message.speed, variance, chunk.text);
    const audio = await runtime.synthesize(
      tuneChunkText(chunk.text, pronunciationRules, emphasisStrength),
      language,
      style,
      Math.max(1, Math.min(20, Math.round(message.quality))),
      speed,
    );
    if (epoch !== activeGenerationEpoch) return;
    post({
      type: "AUDIO_CHUNK",
      generationId: message.generationId,
      audio,
      samplingRate: runtime.sampleRate,
      text: chunk.text,
      index: index + 1,
      total: chunks.length,
      textStart: chunk.start,
      textEnd: chunk.end,
      pauseAfterSec: index + 1 === chunks.length
        ? Math.max(0, Math.min(5, message.finalPauseSec ?? 0))
        : resolvePauseSeconds(chunk.pauseKind, chunk.pauseAfterSec, message.pauseOverridesSec),
      pauseKind: chunk.pauseKind,
    });
  }
  if (epoch === activeGenerationEpoch) {
    post({ type: "GENERATION_COMPLETE", generationId: message.generationId });
  }
}

self.onmessage = (event: MessageEvent<WorkerInMessage & { language?: string }>) => {
  const message = event.data;
  if (message.type === "CANCEL") {
    activeGenerationEpoch += 1;
    return;
  }
  if (message.type === "LOAD") {
    void enqueueModelLoad(Boolean(message.forceReload)).catch((error: unknown) => {
      post({ type: "ERROR", scope: "load", message: error instanceof Error ? error.message : String(error) });
    });
    return;
  }
  if (message.type === "GENERATE") {
    const task = generate(message);
    activeGenerationTask = task;
    void task
      .catch((error: unknown) => {
        post({
          type: "ERROR",
          scope: "generate",
          generationId: message.generationId,
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (activeGenerationTask === task) activeGenerationTask = null;
      });
  }
};
