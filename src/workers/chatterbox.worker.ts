/**
 * Chatterbox Turbo Web Worker
 *
 * Zero-shot voice cloning from a reference clip (no transcript) plus inline
 * audio tags, on Transformers.js ChatterboxModel. Every model file is pinned
 * to a revision and verified against its SHA-256 before ONNX Runtime sees it.
 * LOAD, GENERATE, ABORT, and CANCEL follow the shared worker protocol
 * (src/workers/kit/runtime.ts); reference voices and the extra READY fields
 * follow src/lib/chatterboxProtocol.ts.
 */
import { env } from "@huggingface/transformers";
import type { InferenceBackend, WorkerInMessage } from "../types";
import {
  createChatterboxAssetGuard,
  loadVerifiedAsset,
  buildChatterboxAssetUrl,
  type ChatterboxAssetCache,
  type ChatterboxDtype,
} from "../lib/chatterboxAssets";
import {
  CHATTERBOX_CONTROLS,
  CHATTERBOX_DEFAULT_REFERENCE_ID,
  CHATTERBOX_MAX_REFERENCE_ID_LENGTH,
  type ChatterboxWorkerInMessage,
  type ChatterboxWorkerOutMessage,
} from "../lib/chatterboxProtocol";
import {
  CHATTERBOX_DEFAULT_VOICE,
  CHATTERBOX_MODEL_ID,
  CHATTERBOX_MODEL_REVISION,
  getChatterboxAssetManifest,
} from "../lib/chatterboxModel";
import {
  createChatterboxReferenceStore,
  decodeChatterboxWav,
  digestChatterboxReference,
  prepareChatterboxReference,
} from "../lib/chatterboxReference";
import {
  getChatterboxTokenBudget,
  loadChatterboxRuntime,
  normalizeChatterboxSampling,
  CHATTERBOX_DTYPE,
  type ChatterboxConditioning,
  type ChatterboxRuntime,
  type ChatterboxSampling,
} from "../lib/chatterboxRuntime";
import {
  CHATTERBOX_TAG_TOKENS,
  normalizeChatterboxPunctuation,
  renderChatterboxText,
} from "../lib/chatterboxTags";
import { chunkWithConstraintsDetailed, type TextChunk } from "../lib/chunking";
import { configureTransformersOnnxRuntime } from "../lib/onnxRuntime";
import { TRANSFORMERS_ONNX_WASM_ASSETS } from "../lib/onnxWasmAssets";
import { tuneChunkText } from "../lib/textTuning";
import { getTransformersModelCache } from "../lib/transformersCache";
import { BackendIndependentLoadError, loadWithBackendFallback, MAX_WASM_THREADS } from "./kit/backends";
import { emitAudioChunk, normalizeFinalPauseSec, resolveChunkPauseSec } from "./kit/emit";
import type { GenerationTicket } from "./kit/generation";
import { createLoadProgress, type LoadProgress } from "./kit/progress";
import { errorMessage, generationMeta } from "./kit/protocol";
import { createWorkerRuntime, type GenerateMessage, type LoadMessage } from "./kit/runtime";

const DOWNLOAD_PROGRESS_MAX = 90;
const WARMUP_PROGRESS_PERCENT = 95;
const MAX_CACHED_REFERENCES = 16;
// Smaller chunks reach first audio sooner; the decoder runs once per chunk.
const CHUNK_MIN_CHARACTERS = 60;
const CHUNK_MAX_CHARACTERS = 260;
const WARMUP_TEXT = "Hello.";
const WARMUP_MAX_NEW_TOKENS = 8;
// Golden-ratio offset so a retry never replays the seed that ran away.
const RETRY_SEED_OFFSET = 0x9e3779b9;
const DEFAULT_VOICE_FILE = `${CHATTERBOX_DEFAULT_VOICE.modelId}/${CHATTERBOX_DEFAULT_VOICE.file}`;

interface RenderedChunk {
  chunk: TextChunk;
  text: string;
  spokenCharacters: number;
  tagCount: number;
}

const baseFetch: typeof fetch = self.fetch.bind(self);
const references = createChatterboxReferenceStore<ChatterboxConditioning>(MAX_CACHED_REFERENCES);
let runtime: ChatterboxRuntime | null = null;
let assetStorePromise: Promise<ChatterboxAssetCache | null> | null = null;
let defaultVoiceProgress: LoadProgress | null = null;
const workerRuntime = createWorkerRuntime({ load: loadModel, generate });
const { port, generations } = workerRuntime;

/** Posts the messages that exist only in the Chatterbox protocol. */
function postExtra(message: ChatterboxWorkerOutMessage): void {
  self.postMessage(message);
}

function getAssetStore(): Promise<ChatterboxAssetCache | null> {
  // Captured once: after the first load env.customCache is the guard itself.
  assetStorePromise ??= getTransformersModelCache().then((store) => store && {
    match: (request) => store.match(request),
    put: (request, response) => store.put(request, response),
    delete: async (request) => (await (store as Partial<Pick<Cache, "delete">>).delete?.(request)) ?? false,
  });
  return assetStorePromise;
}

/** Byte-weighted progress over every file a cold load downloads for one dtype. */
function createModelLoadProgress(dtype: ChatterboxDtype): LoadProgress {
  const expectedBytes: Record<string, number> = {
    [DEFAULT_VOICE_FILE]: CHATTERBOX_DEFAULT_VOICE.integrity.byteLength,
  };
  for (const [file, entry] of Object.entries(getChatterboxAssetManifest(dtype))) {
    expectedBytes[file] = entry.byteLength;
  }
  return createLoadProgress({
    report: (percent) => port.post({ type: "LOAD_PROGRESS", percent }),
    range: [0, DOWNLOAD_PROGRESS_MAX],
    expectedBytes,
  });
}

/**
 * Points Transformers.js at the pinned, verified files for one attempt.
 * `onDownloadError` receives the first download or integrity failure, which
 * no other backend can fix.
 */
async function configureTransformers(
  backend: InferenceBackend,
  dtype: ChatterboxDtype,
  progress: LoadProgress,
  onDownloadError: (error: unknown) => void,
): Promise<void> {
  const guard = createChatterboxAssetGuard({
    modelId: CHATTERBOX_MODEL_ID,
    revision: CHATTERBOX_MODEL_REVISION,
    files: getChatterboxAssetManifest(dtype),
    baseFetch,
    cache: await getAssetStore(),
    onProgress: (file, loadedBytes) => progress.update(file, loadedBytes),
    onError: (_file, error) => onDownloadError(error),
  });
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.remoteHost = "https://huggingface.co/";
  env.remotePathTemplate = "{model}/resolve/{revision}/";
  env.fetch = guard.fetch;
  env.useBrowserCache = false;
  env.useCustomCache = true;
  env.customCache = guard.cache;
  configureTransformersOnnxRuntime(env, TRANSFORMERS_ONNX_WASM_ASSETS, { backend, maxWasmThreads: MAX_WASM_THREADS });
}

async function registerReference(referenceId: string, audio: Float32Array, samplingRate: number) {
  const prepared = prepareChatterboxReference(audio, samplingRate);
  const digest = await digestChatterboxReference(prepared.audio);
  references.register(referenceId, digest, prepared);
  return { digest, durationSec: prepared.durationSec };
}

async function ensureDefaultReference(): Promise<void> {
  if (references.resolve(CHATTERBOX_DEFAULT_REFERENCE_ID)) return;
  const progress = defaultVoiceProgress;
  const buffer = await loadVerifiedAsset(
    buildChatterboxAssetUrl(CHATTERBOX_DEFAULT_VOICE.modelId, CHATTERBOX_DEFAULT_VOICE.revision, CHATTERBOX_DEFAULT_VOICE.file),
    CHATTERBOX_DEFAULT_VOICE.file,
    CHATTERBOX_DEFAULT_VOICE.integrity,
    baseFetch,
    await getAssetStore(),
    progress ? (loadedBytes) => progress.update(DEFAULT_VOICE_FILE, loadedBytes) : undefined,
  );
  const { audio, samplingRate } = decodeChatterboxWav(buffer);
  await registerReference(CHATTERBOX_DEFAULT_REFERENCE_ID, audio, samplingRate);
}

async function resolveConditioning(activeRuntime: ChatterboxRuntime, referenceId: string): Promise<ChatterboxConditioning> {
  if (referenceId === CHATTERBOX_DEFAULT_REFERENCE_ID) await ensureDefaultReference();
  const entry = references.resolve(referenceId);
  if (!entry) {
    throw new Error(`Reference voice "${referenceId}" is not loaded. Send SET_REFERENCE first.`);
  }
  if (entry.conditioning) return entry.conditioning;
  const conditioning = await activeRuntime.encodeReference(entry.audio);
  references.setConditioning(entry.digest, conditioning);
  return conditioning;
}

function assertFiniteAudio(audio: Float32Array): void {
  if (audio.length === 0) throw new Error("Chatterbox Turbo returned no audio.");
  for (const sample of audio) {
    if (!Number.isFinite(sample)) throw new Error("Chatterbox Turbo returned invalid audio samples.");
  }
}

async function warmUp(candidate: ChatterboxRuntime): Promise<void> {
  // Compiles WebGPU shaders for all four sessions and proves the backend
  // produces finite audio before READY; also caches the default voice.
  const conditioning = await resolveConditioning(candidate, CHATTERBOX_DEFAULT_REFERENCE_ID);
  port.post({ type: "LOAD_PROGRESS", percent: WARMUP_PROGRESS_PERCENT });
  const result = await candidate.synthesize(WARMUP_TEXT, conditioning, {
    maxNewTokens: WARMUP_MAX_NEW_TOKENS,
    sampling: normalizeChatterboxSampling({ temperature: 0 }),
  });
  assertFiniteAudio(result.audio);
}

async function disposeRuntime(value: ChatterboxRuntime): Promise<void> {
  try {
    await value.dispose();
  } catch {
    // The sessions are unusable either way; keep tearing down.
  }
}

function postReady(activeRuntime: ChatterboxRuntime): void {
  postExtra({
    type: "READY",
    backend: activeRuntime.backend,
    dtype: activeRuntime.dtype,
    voices: [CHATTERBOX_DEFAULT_REFERENCE_ID],
    defaultReferenceId: CHATTERBOX_DEFAULT_REFERENCE_ID,
    tags: CHATTERBOX_TAG_TOKENS,
    controls: CHATTERBOX_CONTROLS,
  });
}

async function loadModel(message: LoadMessage): Promise<void> {
  if (runtime && !message.forceReload) {
    postReady(runtime);
    return;
  }
  // Dropped before the first await so a GENERATE sent meanwhile fails
  // instead of running on sessions about to be released.
  const previous = runtime;
  runtime = null;
  references.clearConditionings();
  if (previous) {
    await generations.idle();
    await disposeRuntime(previous);
  }

  const dtype = CHATTERBOX_DTYPE;
  const progress = createModelLoadProgress(dtype);
  let downloadError: unknown = null;
  try {
    const loaded = await loadWithBackendFallback<ChatterboxRuntime>({
      // The WASM execution provider cannot run the quantized graphs (see resolveChatterboxDtype).
      backends: ["webgpu"],
      failureMessage: "Failed to load Chatterbox Turbo.",
      async load(backend) {
        progress.reset();
        defaultVoiceProgress = progress;
        downloadError = null;
        try {
          await configureTransformers(backend, dtype, progress, (error) => {
            downloadError ??= error;
          });
          return await loadChatterboxRuntime({ backend, dtype });
        } catch (error) {
          throw downloadError ? new BackendIndependentLoadError(downloadError) : error;
        }
      },
      async warmUp(candidate) {
        try {
          await warmUp(candidate);
        } catch (error) {
          throw downloadError ? new BackendIndependentLoadError(downloadError) : error;
        }
      },
      dispose: disposeRuntime,
    });
    runtime = loaded.instance;
  } catch (error) {
    if (downloadError) throw error;
    throw new Error(`Chatterbox Turbo needs WebGPU: ${errorMessage(error)}`, { cause: error });
  } finally {
    // Later default-voice reloads must not post load progress mid-generation.
    progress.close();
    defaultVoiceProgress = null;
  }
  port.post({ type: "LOAD_PROGRESS", percent: 100 });
  postReady(runtime);
}

function isValidReferenceId(referenceId: unknown): referenceId is string {
  return typeof referenceId === "string"
    && referenceId.length > 0
    && referenceId.length <= CHATTERBOX_MAX_REFERENCE_ID_LENGTH;
}

/**
 * Prepares and registers a clip. The speech encoder runs lazily on the first
 * GENERATE that names it, inside the generation's own turn on the model.
 */
async function setReference(message: Extract<ChatterboxWorkerInMessage, { type: "SET_REFERENCE" }>): Promise<void> {
  const { referenceId } = message;
  if (!isValidReferenceId(referenceId) || referenceId === CHATTERBOX_DEFAULT_REFERENCE_ID) {
    throw new Error("Invalid reference id.");
  }
  if (!(message.audio instanceof Float32Array) || typeof message.samplingRate !== "number") {
    throw new Error("SET_REFERENCE needs Float32Array audio and a numeric sample rate.");
  }
  const { digest, durationSec } = await registerReference(referenceId, message.audio, message.samplingRate);
  postExtra({ type: "REFERENCE_READY", referenceId, digest, durationSec });
}

function renderChunks(message: ChatterboxGenerateMessage): { chunks: RenderedChunk[]; removedTags: string[] } {
  const rules = message.pronunciationRules ?? [];
  const emphasis = message.emphasisStrength ?? 0;
  const removedTags: string[] = [];
  const chunks: RenderedChunk[] = [];
  for (const chunk of chunkWithConstraintsDetailed(message.text, {
    minCharacters: CHUNK_MIN_CHARACTERS,
    maxCharacters: CHUNK_MAX_CHARACTERS,
  })) {
    const rendered = renderChatterboxText(chunk.text, (speech) => tuneChunkText(speech, rules, emphasis));
    removedTags.push(...rendered.removedTags);
    // A chunk made only of unsupported directions has nothing to perform.
    if (rendered.spokenCharacters === 0 && rendered.tags.length === 0) continue;
    chunks.push({
      chunk,
      text: normalizeChatterboxPunctuation(rendered.text),
      spokenCharacters: rendered.spokenCharacters,
      tagCount: rendered.tags.length,
    });
  }
  return { chunks, removedTags };
}

function chunkSampling(sampling: ChatterboxSampling, index: number, attempt: number): ChatterboxSampling {
  if (sampling.seed === undefined) return sampling;
  return { ...sampling, seed: (sampling.seed + index + (attempt * RETRY_SEED_OFFSET)) >>> 0 };
}

type ChatterboxGenerateMessage = Extract<ChatterboxWorkerInMessage, { type: "GENERATE" }>;

async function generate(sharedMessage: GenerateMessage, ticket: GenerationTicket): Promise<void> {
  // The host sends the Chatterbox GENERATE shape (src/lib/chatterboxProtocol.ts).
  const message = sharedMessage as unknown as ChatterboxGenerateMessage;
  const activeRuntime = runtime;
  if (!activeRuntime) throw new Error("Chatterbox Turbo is not loaded.");
  if (typeof message.text !== "string") throw new Error("GENERATE needs text.");
  const referenceId = message.referenceId ?? CHATTERBOX_DEFAULT_REFERENCE_ID;
  if (!isValidReferenceId(referenceId)) throw new Error("Invalid reference id.");

  const { chunks, removedTags } = renderChunks(message);
  if (removedTags.length > 0) {
    postExtra({ type: "UNSUPPORTED_TAGS", ...generationMeta(message.generationId), tags: removedTags });
  }
  if (chunks.length === 0) throw new Error("There is no speakable text to generate.");

  const conditioning = await resolveConditioning(activeRuntime, referenceId);
  if (!ticket.isCurrent()) return;
  const sampling = normalizeChatterboxSampling(message);
  let emitted = 0;
  let skipped = 0;
  let firstFailure: unknown = null;

  for (const [index, { chunk, text, spokenCharacters, tagCount }] of chunks.entries()) {
    if (!ticket.isCurrent()) return;
    const maxNewTokens = getChatterboxTokenBudget(spokenCharacters, tagCount);
    let audio: Float32Array | null = null;
    try {
      for (let attempt = 0; attempt < 2 && !audio; attempt += 1) {
        const result = await activeRuntime.synthesize(text, conditioning, {
          maxNewTokens,
          sampling: chunkSampling(sampling, index, attempt),
          shouldStop: () => !ticket.isCurrent(),
        });
        if (!ticket.isCurrent()) return;
        // Hitting the budget without the stop token means the model babbled.
        if (result.reachedStop) {
          assertFiniteAudio(result.audio);
          audio = result.audio;
        }
      }
      if (!audio) throw new Error(`Chatterbox Turbo did not finish "${chunk.text.slice(0, 40)}".`);
    } catch (error) {
      if (!ticket.isCurrent()) return;
      skipped += 1;
      firstFailure ??= error;
      continue;
    }

    emitted += 1;
    emitAudioChunk(port, {
      generationId: message.generationId,
      audio,
      samplingRate: activeRuntime.sampleRate,
      text: chunk.text,
      index: emitted,
      // 0 marks a dynamic total once a chunk has been skipped.
      total: skipped > 0 ? 0 : chunks.length,
      textStart: chunk.start,
      textEnd: chunk.end,
      pauseKind: chunk.pauseKind,
      pauseSec: resolveChunkPauseSec({
        hasFollowing: index < chunks.length - 1,
        pauseKind: chunk.pauseKind,
        pauseAfterSec: chunk.pauseAfterSec,
        pauseOverridesSec: message.pauseOverridesSec,
        finalPauseSec: normalizeFinalPauseSec(message.finalPauseSec),
      }),
    });
  }

  if (skipped > 0) {
    throw new Error(`Generation completed with ${skipped} skipped segment(s): ${errorMessage(firstFailure)}`);
  }
  port.post({ type: "GENERATION_COMPLETE", ...generationMeta(message.generationId) });
}

self.onmessage = (event: MessageEvent<ChatterboxWorkerInMessage>) => {
  const message = event.data;
  switch (message.type) {
    case "SET_REFERENCE":
      void setReference(message).catch((error: unknown) => {
        postExtra({
          type: "ERROR",
          scope: "reference",
          message: errorMessage(error),
          ...(typeof message.referenceId === "string" ? { referenceId: message.referenceId } : {}),
        });
      });
      return;
    case "DELETE_REFERENCE":
      if (isValidReferenceId(message.referenceId) && message.referenceId !== CHATTERBOX_DEFAULT_REFERENCE_ID) {
        references.delete(message.referenceId);
      }
      return;
    default:
      workerRuntime.handleMessage(message as WorkerInMessage);
  }
};
