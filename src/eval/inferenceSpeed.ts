import { MODELS } from "../constants";
import type { InferenceBackend, ModelType, WorkerInMessage, WorkerOutMessage } from "../types";
import { getWebGPUStatus, type WebGPUStatus } from "../lib/webgpu";

const RESULT_PREFIX = "INFERENCE_SPEED_RESULT_JSON:";
const ERROR_PREFIX = "INFERENCE_SPEED_ERROR_JSON:";

const DEFAULT_TEXT = [
  "Local text to speech should feel immediate even when the model is running entirely on device.",
  "This benchmark measures warm model generation throughput through the same worker path used by the app.",
  "It includes several sentences so chunking, batching, and worker transfer costs are visible in the result.",
  "The output is designed for repeatable speed comparisons after runtime changes.",
].join(" ");

interface ParsedOptions {
  model: ModelType | "both";
  iterations: number;
  warmups: number;
  quality: number;
  speed: number;
  timeoutMs: number;
  text: string;
}

interface IterationResult {
  iteration: number;
  warmup: boolean;
  generationMs: number;
  firstChunkMs: number | null;
  chunks: number;
  audioSeconds: number;
  charsPerSec: number;
  rtf: number | null;
}

interface ModelBenchmarkResult {
  model: ModelType;
  backend: InferenceBackend | null;
  loadMs: number | null;
  voice: string;
  iterations: IterationResult[];
  summary: {
    meanGenerationMs: number;
    medianGenerationMs: number;
    bestGenerationMs: number;
    meanFirstChunkMs: number | null;
    meanCharsPerSec: number;
    meanRtf: number | null;
  } | null;
  error?: string;
}

interface BenchmarkResult {
  runner: {
    href: string;
    userAgent: string;
    crossOriginIsolated: boolean;
  };
  options: ParsedOptions;
  webgpu: WebGPUStatus;
  models: ModelBenchmarkResult[];
}

function readNumber(params: URLSearchParams, name: string, fallback: number): number {
  const value = Number(params.get(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseOptions(): ParsedOptions {
  const params = new URLSearchParams(window.location.search);
  const model = params.get("model");

  return {
    model: model === "kokoro" || model === "supertonic" ? model : "both",
    iterations: Math.max(1, Math.floor(readNumber(params, "iterations", 3))),
    warmups: Math.max(0, Math.floor(readNumber(params, "warmups", 1))),
    quality: Math.max(1, Math.floor(readNumber(params, "quality", 5))),
    speed: readNumber(params, "speed", 1),
    timeoutMs: readNumber(params, "timeoutMs", 15 * 60 * 1000),
    text: params.get("text")?.trim() || DEFAULT_TEXT,
  };
}

function modelList(model: ParsedOptions["model"]): ModelType[] {
  return model === "both" ? ["kokoro", "supertonic"] : [model];
}

function createWorker(model: ModelType): Worker {
  if (model === "kokoro") {
    return new Worker(new URL("../workers/kokoro.worker.ts", import.meta.url), { type: "module" });
  }
  return new Worker(new URL("../workers/supertonic.worker.ts", import.meta.url), { type: "module" });
}

function timeoutPromise<T>(timeoutMs: number, label: string): Promise<T> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
  });
}

function waitForLoad(
  worker: Worker,
  model: ModelType,
  timeoutMs: number,
): Promise<{ backend: InferenceBackend | null; voices?: string[]; loadMs: number }> {
  const startedAt = performance.now();

  const promise = new Promise<{ backend: InferenceBackend | null; voices?: string[]; loadMs: number }>((resolve, reject) => {
    const handleMessage = (event: MessageEvent<WorkerOutMessage>) => {
      const message = event.data;
      if (message.type === "READY") {
        worker.removeEventListener("message", handleMessage);
        resolve({
          backend: message.backend ?? null,
          voices: message.voices,
          loadMs: performance.now() - startedAt,
        });
        return;
      }

      if (message.type === "ERROR" && message.scope !== "generate") {
        worker.removeEventListener("message", handleMessage);
        reject(new Error(message.message));
      }
    };

    worker.addEventListener("message", handleMessage);
    worker.postMessage({
      type: "LOAD",
      preferredVoice: model === "supertonic" ? MODELS.supertonic.defaultVoice : undefined,
      debugProfiling: false,
    } satisfies WorkerInMessage);
  });

  return Promise.race([
    promise,
    timeoutPromise<{ backend: InferenceBackend | null; voices?: string[]; loadMs: number }>(timeoutMs, `${model} load`),
  ]);
}

function generateOnce(
  worker: Worker,
  options: ParsedOptions,
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
    } satisfies WorkerInMessage);
  });
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function summarize(iterations: IterationResult[]): ModelBenchmarkResult["summary"] {
  const measured = iterations.filter((iteration) => !iteration.warmup);
  if (measured.length === 0) return null;

  const generationMs = measured.map((iteration) => iteration.generationMs);
  const firstChunkMs = measured
    .map((iteration) => iteration.firstChunkMs)
    .filter((value): value is number => value !== null);
  const rtf = measured
    .map((iteration) => iteration.rtf)
    .filter((value): value is number => value !== null);

  return {
    meanGenerationMs: mean(generationMs),
    medianGenerationMs: median(generationMs),
    bestGenerationMs: Math.min(...generationMs),
    meanFirstChunkMs: firstChunkMs.length > 0 ? mean(firstChunkMs) : null,
    meanCharsPerSec: mean(measured.map((iteration) => iteration.charsPerSec)),
    meanRtf: rtf.length > 0 ? mean(rtf) : null,
  };
}

async function benchmarkModel(model: ModelType, options: ParsedOptions): Promise<ModelBenchmarkResult> {
  const worker = createWorker(model);
  try {
    const loaded = await waitForLoad(worker, model, options.timeoutMs);
    const voice = model === "kokoro"
      ? (loaded.voices?.includes(MODELS.kokoro.defaultVoice) ? MODELS.kokoro.defaultVoice : loaded.voices?.[0] ?? MODELS.kokoro.defaultVoice)
      : MODELS.supertonic.defaultVoice;

    const iterations: IterationResult[] = [];
    const totalRuns = options.warmups + options.iterations;
    for (let index = 0; index < totalRuns; index += 1) {
      const warmup = index < options.warmups;
      const iteration = await Promise.race([
        generateOnce(worker, options, voice, index + 1, warmup),
        timeoutPromise<IterationResult>(options.timeoutMs, `${model} generation ${index + 1}`),
      ]);
      iterations.push(iteration);
    }

    return {
      model,
      backend: loaded.backend,
      loadMs: loaded.loadMs,
      voice,
      iterations,
      summary: summarize(iterations),
    };
  } catch (error) {
    return {
      model,
      backend: null,
      loadMs: null,
      voice: model === "kokoro" ? MODELS.kokoro.defaultVoice : MODELS.supertonic.defaultVoice,
      iterations: [],
      summary: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    worker.terminate();
  }
}

function setStatus(value: string): void {
  const status = document.getElementById("status");
  if (status) status.textContent = value;
}

async function main(): Promise<void> {
  const options = parseOptions();
  const webgpu = await getWebGPUStatus();
  const models: ModelBenchmarkResult[] = [];

  for (const model of modelList(options.model)) {
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
