/** Electron-renderer-only Supertonic 3 worker. */
import * as ort from "onnxruntime-web";
import type { InferenceBackend, WorkerInMessage, WorkerOutMessage } from "../types";
import {
  SUPERTONIC3_LANGUAGES,
  SUPERTONIC3_MODEL_ID,
  SUPERTONIC3_MODEL_REVISION,
  SUPERTONIC3_VOICES,
} from "../constants";
import { concatFloat32Arrays, createSilence } from "../lib/audio";
import { chunkWithConstraintsDetailed } from "../lib/chunking";
import { resolvePauseSeconds, resolveSentenceSpeed, tuneChunkText } from "../lib/textTuning";
import { canInitializeWebGPU } from "../lib/webgpu";
import { TRANSFORMERS_ONNX_WASM_ASSETS } from "../lib/onnxWasmAssets";
import { getSafeWasmThreadCount } from "../lib/onnxRuntime";
import { verifyPinnedAssetIntegrity, type PinnedAssetIntegrity } from "../lib/pinnedModelFetch";
import { SUPERTONIC3_ASSETS } from "./manifests/supertonic3";
import {
  createSupertonic3RuntimeStreaming,
  createSupertonic3Style,
  type Supertonic3Config,
  type Supertonic3ModelName,
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
const MODEL_FILE_BY_NAME: Record<Supertonic3ModelName, string> = {
  duration_predictor: "onnx/duration_predictor.onnx",
  text_encoder: "onnx/text_encoder.onnx",
  vector_estimator: "onnx/vector_estimator.onnx",
  vocoder: "onnx/vocoder.onnx",
};
const LOAD_FILE_COUNT = MODEL_FILES.length + 1;
// Exact sizes and repository digests at SUPERTONIC3_MODEL_REVISION, generated
// by scripts/pin-hf-assets.mjs; regenerate the manifest with the revision.
const ASSET_INTEGRITY: Readonly<Record<string, PinnedAssetIntegrity>> = SUPERTONIC3_ASSETS.files;

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

  const canPreallocate = Number.isSafeInteger(declaredLength) && declaredLength >= 0;
  const preallocated = canPreallocate ? new Uint8Array(declaredLength) : null;
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      if (preallocated) {
        if (received + value.byteLength > preallocated.byteLength) {
          throw new Error(`Supertonic 3 ${file} exceeded its declared size.`);
        }
        preallocated.set(value, received);
      } else {
        chunks.push(value);
      }
      received += value.byteLength;
      if (Number.isFinite(declaredLength) && declaredLength > 0) {
        updateLoadProgress(file, received / declaredLength);
      }
    }
  }
  if (preallocated && received !== preallocated.byteLength) {
    throw new Error(`Supertonic 3 ${file} did not match its declared size.`);
  }
  const merged = preallocated ?? new Uint8Array(received);
  if (!preallocated) {
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
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
    const configBuffer = await fetchAsset("onnx/tts.json");
    const indexerBuffer = await fetchAsset("onnx/unicode_indexer.json");
    const config = parseJson<Supertonic3Config>(configBuffer, "onnx/tts.json");
    const indexer = parseJson<number[]>(indexerBuffer, "onnx/unicode_indexer.json");
    const loadModelBuffer = (name: Supertonic3ModelName) => fetchAsset(MODEL_FILE_BY_NAME[name]);
    const preferredBackend: InferenceBackend = await canInitializeWebGPU() ? "webgpu" : "wasm";
    try {
      runtime = await createSupertonic3RuntimeStreaming(config, indexer, loadModelBuffer, preferredBackend);
      backend = preferredBackend;
    } catch (error) {
      if (preferredBackend === "wasm") throw error;
      runtime = await createSupertonic3RuntimeStreaming(config, indexer, loadModelBuffer, "wasm");
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
    const pauseSec = index + 1 === chunks.length
      ? Math.max(0, Math.min(5, message.finalPauseSec ?? 0))
      : resolvePauseSeconds(chunk.pauseKind, chunk.pauseAfterSec, message.pauseOverridesSec);
    post({
      type: "AUDIO_CHUNK",
      generationId: message.generationId,
      audio: pauseSec > 0 ? concatFloat32Arrays([audio, createSilence(pauseSec, runtime.sampleRate)]) : audio,
      samplingRate: runtime.sampleRate,
      text: chunk.text,
      index: index + 1,
      total: chunks.length,
      textStart: chunk.start,
      textEnd: chunk.end,
      pauseAfterSec: pauseSec,
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
    post({ type: "CANCELLED" });
    self.close();
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
