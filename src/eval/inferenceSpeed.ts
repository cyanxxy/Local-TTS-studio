import type { InferenceBackend, WorkerInMessage, WorkerOutMessage } from "../types";
import { getWebGPUStatus, type WebGPUStatus } from "../lib/webgpu";
import { BENCHMARK_MODEL_INFO, resolveBenchmarkVoice } from "./inferenceSpeedModels";
import {
  parseInferenceSpeedOptions,
  resolveBenchmarkModels,
  type BenchmarkModel,
  type ParsedInferenceSpeedOptions,
} from "./inferenceSpeedOptions";
import { summarizeIterations, type IterationResult, type IterationSummary } from "./inferenceSpeedSummary";

const RESULT_PREFIX = "INFERENCE_SPEED_RESULT_JSON:";
const ERROR_PREFIX = "INFERENCE_SPEED_ERROR_JSON:";
// Fixed so Supertonic 3, which samples from noise, synthesizes the same audio
// on every run; Kokoro and Supertonic 2 ignore it.
const BENCHMARK_SEED = 0;

interface ModelBenchmarkResult {
  model: BenchmarkModel;
  modelId: string;
  modelRevision: string;
  /** Backend of the worker that ran the generations (the warm-loaded one). */
  backend: InferenceBackend | null;
  /**
   * First LOAD on a fresh worker. It includes downloads only when the
   * runtime's Cache Storage is empty in this browser profile.
   */
  coldLoadMs: number | null;
  /** LOAD on a second fresh worker after the first is terminated, served from the cache. */
  warmLoadMs: number | null;
  /** Alias of `coldLoadMs` for reports and tools that predate the split. */
  loadMs: number | null;
  /**
   * Time to the first AUDIO_CHUNK of the first GENERATE after the warm load,
   * before any warm-up: the first-audio latency a user sees after loading.
   */
  firstChunkMs: number | null;
  voice: string;
  iterations: IterationResult[];
  summary: IterationSummary | null;
  error?: string;
}

interface BenchmarkResult {
  runner: {
    href: string;
    userAgent: string;
    crossOriginIsolated: boolean;
  };
  options: ParsedInferenceSpeedOptions;
  webgpu: WebGPUStatus;
  models: ModelBenchmarkResult[];
}

interface LoadResult {
  backend: InferenceBackend | null;
  voices?: string[];
  loadMs: number;
}

// One literal `new Worker(new URL(...))` per runtime so Vite bundles each worker.
function createWorker(model: BenchmarkModel): Worker {
  switch (model) {
    case "kokoro":
      return new Worker(new URL("../workers/kokoro.worker.ts", import.meta.url), { type: "module" });
    case "supertonic":
      return new Worker(new URL("../workers/supertonic.worker.ts", import.meta.url), { type: "module" });
    case "supertonic3":
      return new Worker(new URL("../workers/supertonic3.worker.ts", import.meta.url), { type: "module" });
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function workerErrorMessage(event: ErrorEvent, model: BenchmarkModel): string {
  return event.message || `${model} worker failed to start.`;
}

function waitForLoad(worker: Worker, model: BenchmarkModel, timeoutMs: number, label: string): Promise<LoadResult> {
  const startedAt = performance.now();

  const promise = new Promise<LoadResult>((resolve, reject) => {
    const cleanup = () => {
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);
    };
    const handleMessage = (event: MessageEvent<WorkerOutMessage>) => {
      const message = event.data;
      if (message.type === "READY") {
        cleanup();
        resolve({
          backend: message.backend ?? null,
          voices: message.voices,
          loadMs: performance.now() - startedAt,
        });
        return;
      }

      if (message.type === "ERROR" && message.scope !== "generate") {
        cleanup();
        reject(new Error(message.message));
      }
    };
    // A worker whose module fails to evaluate posts nothing; fail fast instead
    // of waiting for the timeout.
    const handleError = (event: ErrorEvent) => {
      cleanup();
      reject(new Error(workerErrorMessage(event, model)));
    };

    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);
    worker.postMessage({
      type: "LOAD",
      // Only Supertonic 2 preloads a voice during LOAD, as in useModelLoader.
      preferredVoice: model === "supertonic" ? BENCHMARK_MODEL_INFO.supertonic.defaultVoice : undefined,
      debugProfiling: false,
    } satisfies WorkerInMessage);
  });

  return withTimeout(promise, timeoutMs, `${model} ${label}`);
}

function generateOnce(
  worker: Worker,
  model: BenchmarkModel,
  options: ParsedInferenceSpeedOptions,
  voice: string,
  iteration: number,
  warmup: boolean,
): Promise<IterationResult> {
  const startedAt = performance.now();
  let firstChunkMs: number | null = null;
  let audioSeconds = 0;
  let chunks = 0;

  return new Promise<IterationResult>((resolve, reject) => {
    const handleMessage = (event: MessageEvent<WorkerOutMessage>) => {
      const message = event.data;

      if (message.type === "AUDIO_CHUNK") {
        firstChunkMs ??= performance.now() - startedAt;
        chunks += 1;
        audioSeconds += message.audio.length / message.samplingRate;
        return;
      }

      if (message.type === "GENERATION_COMPLETE") {
        worker.removeEventListener("message", handleMessage);
        const generationMs = performance.now() - startedAt;
        resolve({
          iteration,
          warmup,
          generationMs,
          firstChunkMs,
          chunks,
          audioSeconds,
          charsPerSec: options.text.length / (generationMs / 1000),
          rtf: audioSeconds > 0 ? (generationMs / 1000) / audioSeconds : null,
        });
        return;
      }

      if (message.type === "ERROR" && message.scope !== "load") {
        worker.removeEventListener("message", handleMessage);
        reject(new Error(message.message));
      }
    };

    worker.addEventListener("message", handleMessage);
    worker.postMessage({
      type: "GENERATE",
      text: options.text,
      voice,
      language: BENCHMARK_MODEL_INFO[model].language,
      speed: options.speed,
      quality: options.quality,
      pauseOverridesSec: {
        none: 0,
        comma: 0,
        sentence: 0,
        paragraph: 0,
      },
      sentenceSpeedVariance: 0,
      pronunciationRules: [],
      emphasisStrength: 0,
      seed: BENCHMARK_SEED,
    } satisfies WorkerInMessage);
  });
}

/**
 * Cold-loads the runtime on a fresh worker, terminates it, warm-loads a second
 * fresh worker from the cache, then runs the warm-ups and measured iterations
 * on the warm worker. Whatever was measured before a failure is kept.
 */
async function benchmarkModel(model: BenchmarkModel, options: ParsedInferenceSpeedOptions): Promise<ModelBenchmarkResult> {
  const info = BENCHMARK_MODEL_INFO[model];
  const result: ModelBenchmarkResult = {
    model,
    modelId: info.modelId,
    modelRevision: info.modelRevision,
    backend: null,
    coldLoadMs: null,
    warmLoadMs: null,
    loadMs: null,
    firstChunkMs: null,
    voice: info.defaultVoice,
    iterations: [],
    summary: null,
  };

  let worker: Worker | null = null;
  try {
    worker = createWorker(model);
    const cold = await waitForLoad(worker, model, options.timeoutMs, "cold load");
    result.coldLoadMs = cold.loadMs;
    result.loadMs = cold.loadMs;
    worker.terminate();
    worker = null;

    worker = createWorker(model);
    const warm = await waitForLoad(worker, model, options.timeoutMs, "warm load");
    result.warmLoadMs = warm.loadMs;
    result.backend = warm.backend;
    result.voice = resolveBenchmarkVoice(model, warm.voices);

    const totalRuns = options.warmups + options.iterations;
    for (let index = 0; index < totalRuns; index += 1) {
      const iteration = await withTimeout(
        generateOnce(worker, model, options, result.voice, index + 1, index < options.warmups),
        options.timeoutMs,
        `${model} generation ${index + 1}`,
      );
      result.iterations.push(iteration);
    }

    result.firstChunkMs = result.iterations[0]?.firstChunkMs ?? null;
    result.summary = summarizeIterations(result.iterations);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    worker?.terminate();
  }
  return result;
}

function setStatus(value: string): void {
  const status = document.getElementById("status");
  if (status) status.textContent = value;
}

async function main(): Promise<void> {
  const options = parseInferenceSpeedOptions(window.location.search);
  const webgpu = await getWebGPUStatus();
  const models: ModelBenchmarkResult[] = [];

  for (const model of resolveBenchmarkModels(options.model)) {
    setStatus(`Benchmarking ${model}...`);
    models.push(await benchmarkModel(model, options));
  }

  const result: BenchmarkResult = {
    runner: {
      href: window.location.href,
      userAgent: navigator.userAgent,
      crossOriginIsolated: window.crossOriginIsolated,
    },
    options,
    webgpu,
    models,
  };

  setStatus(JSON.stringify(result, null, 2));
  console.log(`${RESULT_PREFIX}${JSON.stringify(result)}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  setStatus(message);
  console.error(`${ERROR_PREFIX}${JSON.stringify({ message })}`);
});
