const DEFAULT_TEXT = [
  "Local text to speech should feel immediate even when the model is running entirely on device.",
  "This benchmark measures warm model generation throughput through the same worker path used by the app.",
  "It includes several sentences so chunking, batching, and worker transfer costs are visible in the result.",
  "The output is designed for repeatable speed comparisons after runtime changes.",
].join(" ");

/** Every browser Web Worker runtime the eval can benchmark, in run order. */
export const BENCHMARK_MODELS = ["kokoro", "supertonic", "supertonic3"] as const;
export type BenchmarkModel = (typeof BENCHMARK_MODELS)[number];

/**
 * Accepted `model` values: one runtime, `both` (Kokoro and Supertonic 2, kept
 * for reports and scripts that predate Supertonic 3), or `all` (every runtime).
 * `scripts/inference-speed-output.mjs` mirrors this list for the CLI.
 */
export const BENCHMARK_MODEL_SELECTIONS = [...BENCHMARK_MODELS, "both", "all"] as const;
export type BenchmarkModelSelection = (typeof BENCHMARK_MODEL_SELECTIONS)[number];

export const DEFAULT_BENCHMARK_MODEL_SELECTION: BenchmarkModelSelection = "both";

export interface ParsedInferenceSpeedOptions {
  model: BenchmarkModelSelection;
  iterations: number;
  warmups: number;
  quality: number;
  speed: number;
  timeoutMs: number;
  text: string;
}

export function isBenchmarkModelSelection(value: string): value is BenchmarkModelSelection {
  return (BENCHMARK_MODEL_SELECTIONS as readonly string[]).includes(value);
}

/** The runtimes a selection benchmarks, in run order. */
export function resolveBenchmarkModels(selection: BenchmarkModelSelection): BenchmarkModel[] {
  if (selection === "all") return [...BENCHMARK_MODELS];
  if (selection === "both") return ["kokoro", "supertonic"];
  return [selection];
}

function readPositiveNumber(params: URLSearchParams, name: string, fallback: number): number {
  const value = Number(params.get(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readNonNegativeNumber(params: URLSearchParams, name: string, fallback: number): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * An absent `model` selects the default set; an unrecognized one throws, so a
 * typo can never silently benchmark a different set of runtimes.
 */
function readModelSelection(params: URLSearchParams): BenchmarkModelSelection {
  const model = params.get("model");
  if (model === null) return DEFAULT_BENCHMARK_MODEL_SELECTION;
  if (!isBenchmarkModelSelection(model)) {
    throw new Error(`model must be one of: ${BENCHMARK_MODEL_SELECTIONS.join(", ")}.`);
  }
  return model;
}

export function parseInferenceSpeedOptions(search: string): ParsedInferenceSpeedOptions {
  const params = new URLSearchParams(search);

  return {
    model: readModelSelection(params),
    iterations: Math.max(1, Math.floor(readPositiveNumber(params, "iterations", 3))),
    warmups: Math.floor(readNonNegativeNumber(params, "warmups", 1)),
    quality: Math.max(1, Math.floor(readPositiveNumber(params, "quality", 5))),
    speed: readPositiveNumber(params, "speed", 1),
    timeoutMs: readPositiveNumber(params, "timeoutMs", 15 * 60 * 1000),
    text: params.get("text")?.trim() || DEFAULT_TEXT,
  };
}
