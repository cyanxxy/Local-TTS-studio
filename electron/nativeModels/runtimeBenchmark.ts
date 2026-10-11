/**
 * Time-to-first-audio and real-time-factor measurements for native runtimes.
 *
 * A runtime takes part through a `NativeRuntimeBenchmarkAdapter`: load it,
 * synthesize a prompt while signalling when the first playable audio exists,
 * dispose of it. The harness owns the clock, warm-up, repetition, statistics
 * and the report shape, so numbers from different runtimes and machines are
 * comparable. `scripts/benchmark-native-runtimes.cjs` drives it against the
 * compiled runtimes; nothing here touches the network or the disk.
 */

export interface BenchmarkAudio {
  sampleRate: number;
  /** Mono samples produced for the prompt. */
  samples: number;
}

export interface NativeRuntimeBenchmarkAdapter {
  /** Short runtime name used in the report, e.g. "audio8". */
  runtime: string;
  /** The pinned model the numbers belong to. */
  model: { id: string; revision: string };
  load(): Promise<void>;
  /**
   * Synthesizes `text`, calling `onFirstAudio` as soon as playable audio
   * exists: on the first chunk for a streaming runtime, or once the whole take
   * is ready for one that is not. A runtime that never calls it is measured
   * as non-streaming, with first audio at completion.
   */
  synthesize(text: string, onFirstAudio: () => void): Promise<BenchmarkAudio>;
  dispose(): Promise<void>;
}

export interface NativeRuntimeBenchmarkOptions {
  prompts: readonly string[];
  /** Measured passes over every prompt. */
  runs: number;
  /** Unrecorded syntheses of the first prompt before measuring, to settle caches and JIT. */
  warmupRuns: number;
  /** Milliseconds from an arbitrary origin. Seam for tests. */
  now?: () => number;
}

export interface BenchmarkRun {
  /** Index into the prompt list. */
  prompt: number;
  /** Unicode scalar count of the prompt. */
  characters: number;
  firstAudioSec: number;
  wallSec: number;
  audioSec: number;
  /** Wall time over audio time: below 1 is faster than real time. */
  realTimeFactor: number;
}

export interface BenchmarkStats {
  min: number;
  median: number;
  mean: number;
  max: number;
}

export interface NativeRuntimeBenchmarkReport {
  runtime: string;
  model: { id: string; revision: string };
  loadSec: number;
  warmupRuns: number;
  runs: BenchmarkRun[];
  summary: {
    firstAudioSec: BenchmarkStats;
    wallSec: BenchmarkStats;
    realTimeFactor: BenchmarkStats;
  };
}

/** Short enough for any runtime's per-request limit, long enough to reach steady state. */
export const DEFAULT_BENCHMARK_PROMPTS: readonly string[] = [
  "Local speech synthesis keeps every word on this computer.",
  "The quick brown fox jumps over the lazy dog, and then it settles down for a long, quiet afternoon nap.",
  "Measuring the time to first audio tells you how long a listener waits before anything plays, while the real-time factor tells you whether generation keeps ahead of playback once it starts.",
];

const MAX_RUNS = 100;

function round(value: number): number {
  return Number(value.toFixed(4));
}

export function summarizeBenchmarkValues(values: readonly number[]): BenchmarkStats {
  if (values.length === 0) throw new Error("Cannot summarize an empty benchmark.");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  const mean = sorted.reduce((total, value) => total + value, 0) / sorted.length;
  return { min: round(sorted[0]), median: round(median), mean: round(mean), max: round(sorted[sorted.length - 1]) };
}

function assertRunCount(name: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum || value > MAX_RUNS) {
    throw new Error(`Benchmark ${name} must be an integer from ${minimum} to ${MAX_RUNS}.`);
  }
}

async function measure(
  adapter: NativeRuntimeBenchmarkAdapter,
  text: string,
  now: () => number,
): Promise<{ firstAudioMs: number; wallMs: number; audio: BenchmarkAudio }> {
  const startedAt = now();
  let firstAudioAt: number | null = null;
  const audio = await adapter.synthesize(text, () => {
    firstAudioAt ??= now();
  });
  const finishedAt = now();
  if (!Number.isFinite(audio.sampleRate) || audio.sampleRate <= 0 || !Number.isInteger(audio.samples) || audio.samples <= 0) {
    throw new Error(`${adapter.runtime} benchmark produced no audio for "${text.slice(0, 40)}".`);
  }
  return { firstAudioMs: (firstAudioAt ?? finishedAt) - startedAt, wallMs: finishedAt - startedAt, audio };
}

/** Loads, warms up and measures `adapter`, then disposes of it whatever happened. */
export async function runNativeRuntimeBenchmark(
  adapter: NativeRuntimeBenchmarkAdapter,
  { prompts, runs, warmupRuns, now = () => performance.now() }: NativeRuntimeBenchmarkOptions,
): Promise<NativeRuntimeBenchmarkReport> {
  if (prompts.length === 0 || prompts.some((prompt) => prompt.trim().length === 0)) {
    throw new Error("Benchmark prompts must be non-empty.");
  }
  assertRunCount("runs", runs, 1);
  assertRunCount("warm-up runs", warmupRuns, 0);
  try {
    const loadStartedAt = now();
    await adapter.load();
    const loadSec = (now() - loadStartedAt) / 1000;

    for (let warmup = 0; warmup < warmupRuns; warmup += 1) await measure(adapter, prompts[0], now);

    const measured: BenchmarkRun[] = [];
    for (let run = 0; run < runs; run += 1) {
      for (const [prompt, text] of prompts.entries()) {
        const { firstAudioMs, wallMs, audio } = await measure(adapter, text, now);
        const audioSec = audio.samples / audio.sampleRate;
        measured.push({
          prompt,
          characters: [...text].length,
          firstAudioSec: round(firstAudioMs / 1000),
          wallSec: round(wallMs / 1000),
          audioSec: round(audioSec),
          realTimeFactor: round(wallMs / 1000 / audioSec),
        });
      }
    }

    return {
      runtime: adapter.runtime,
      model: { ...adapter.model },
      loadSec: round(loadSec),
      warmupRuns,
      runs: measured,
      summary: {
        firstAudioSec: summarizeBenchmarkValues(measured.map((run) => run.firstAudioSec)),
        wallSec: summarizeBenchmarkValues(measured.map((run) => run.wallSec)),
        realTimeFactor: summarizeBenchmarkValues(measured.map((run) => run.realTimeFactor)),
      },
    };
  } finally {
    await adapter.dispose();
  }
}

export interface NativeBenchmarkArgs {
  runtime: string;
  runs: number;
  warmupRuns: number;
  /** Where to write the JSON report in addition to stdout. */
  output?: string;
  /** Runtime-specific options such as `voice`, `seed` or `temperature`, validated by the runtime. */
  runtimeOptions: Record<string, string>;
}

const COUNT_FLAGS: Record<string, "runs" | "warmupRuns"> = { "--runs": "runs", "--warmup": "warmupRuns" };
const RUNTIME_OPTION_FLAGS = new Set(["--voice", "--seed", "--temperature"]);

/** Parses `--flag value` pairs. Unknown flags are refused rather than ignored. */
export function parseNativeBenchmarkArgs(argv: readonly string[]): NativeBenchmarkArgs {
  const args: NativeBenchmarkArgs = { runtime: "audio8", runs: 3, warmupRuns: 1, runtimeOptions: {} };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Benchmark flag ${flag} needs a value.`);
    if (flag === "--runtime") args.runtime = value;
    else if (flag === "--output") args.output = value;
    else if (Object.hasOwn(COUNT_FLAGS, flag)) args[COUNT_FLAGS[flag]] = Number(value);
    else if (RUNTIME_OPTION_FLAGS.has(flag)) args.runtimeOptions[flag.slice(2)] = value;
    else throw new Error(`Unknown benchmark flag ${flag}.`);
  }
  assertRunCount("runs", args.runs, 1);
  assertRunCount("warm-up runs", args.warmupRuns, 0);
  return args;
}

export interface BenchmarkMachine {
  platform: string;
  arch: string;
  osRelease: string;
  cpuModel: string;
  logicalCores: number;
  totalMemoryGiB: number;
  node: string;
}

export interface BenchmarkMachineSource {
  platform: string;
  arch: string;
  release: () => string;
  cpus: () => readonly { model: string }[];
  totalmem: () => number;
  nodeVersion: string;
}

/** What the numbers were measured on; comparisons across different machines are not meaningful. */
export function describeBenchmarkMachine(source: BenchmarkMachineSource): BenchmarkMachine {
  const cpus = source.cpus();
  return {
    platform: source.platform,
    arch: source.arch,
    osRelease: source.release(),
    cpuModel: cpus[0]?.model.trim() || "unknown",
    logicalCores: cpus.length,
    totalMemoryGiB: Number((source.totalmem() / 1024 ** 3).toFixed(1)),
    node: source.nodeVersion,
  };
}
