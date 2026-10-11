// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BENCHMARK_PROMPTS,
  describeBenchmarkMachine,
  parseNativeBenchmarkArgs,
  runNativeRuntimeBenchmark,
  summarizeBenchmarkValues,
  type BenchmarkAudio,
  type NativeRuntimeBenchmarkAdapter,
} from "./runtimeBenchmark";

/**
 * A runtime on a scripted clock: every step advances time by a fixed amount,
 * so each measurement in the report is exact.
 */
function scriptedRuntime({
  loadMs = 2_000,
  firstAudioMs = 100 as number | null,
  restMs = 400,
  audio = { sampleRate: 1_000, samples: 1_000 } as BenchmarkAudio,
} = {}) {
  let clock = 0;
  const now = () => clock;
  const synthesize = vi.fn(async (_text: string, onFirstAudio: () => void) => {
    if (firstAudioMs !== null) {
      clock += firstAudioMs;
      onFirstAudio();
      onFirstAudio();
    }
    clock += restMs;
    return audio;
  });
  const adapter: NativeRuntimeBenchmarkAdapter = {
    runtime: "kitten",
    model: { id: "Kitten/Nano", revision: "abc" },
    load: vi.fn(async () => {
      clock += loadMs;
    }),
    synthesize,
    dispose: vi.fn(async () => undefined),
  };
  return { adapter, now, synthesize };
}

describe("runNativeRuntimeBenchmark", () => {
  it("measures load, first audio, wall time and real-time factor per prompt and run", async () => {
    const { adapter, now, synthesize } = scriptedRuntime();

    const report = await runNativeRuntimeBenchmark(adapter, {
      prompts: ["One", "Two words"],
      runs: 2,
      warmupRuns: 1,
      now,
    });

    expect(synthesize).toHaveBeenCalledTimes(5);
    expect(synthesize.mock.calls.map(([text]) => text)).toEqual(["One", "One", "Two words", "One", "Two words"]);
    expect(report).toEqual({
      runtime: "kitten",
      model: { id: "Kitten/Nano", revision: "abc" },
      loadSec: 2,
      warmupRuns: 1,
      runs: [
        { prompt: 0, characters: 3, firstAudioSec: 0.1, wallSec: 0.5, audioSec: 1, realTimeFactor: 0.5 },
        { prompt: 1, characters: 9, firstAudioSec: 0.1, wallSec: 0.5, audioSec: 1, realTimeFactor: 0.5 },
        { prompt: 0, characters: 3, firstAudioSec: 0.1, wallSec: 0.5, audioSec: 1, realTimeFactor: 0.5 },
        { prompt: 1, characters: 9, firstAudioSec: 0.1, wallSec: 0.5, audioSec: 1, realTimeFactor: 0.5 },
      ],
      summary: {
        firstAudioSec: { min: 0.1, median: 0.1, mean: 0.1, max: 0.1 },
        wallSec: { min: 0.5, median: 0.5, mean: 0.5, max: 0.5 },
        realTimeFactor: { min: 0.5, median: 0.5, mean: 0.5, max: 0.5 },
      },
    });
    expect(adapter.dispose).toHaveBeenCalledTimes(1);
  });

  it("measures a runtime that never signals first audio as non-streaming", async () => {
    const { adapter, now } = scriptedRuntime({ firstAudioMs: null, restMs: 750 });

    const report = await runNativeRuntimeBenchmark(adapter, { prompts: ["Hi"], runs: 1, warmupRuns: 0, now });

    expect(report.runs[0]).toMatchObject({ firstAudioSec: 0.75, wallSec: 0.75 });
  });

  it("counts Unicode scalars rather than UTF-16 units", async () => {
    const { adapter, now } = scriptedRuntime();

    const report = await runNativeRuntimeBenchmark(adapter, { prompts: ["héllo 😀"], runs: 1, warmupRuns: 0, now });

    expect(report.runs[0].characters).toBe(7);
  });

  it("refuses a take with no audio and still disposes of the runtime", async () => {
    const { adapter, now } = scriptedRuntime({ audio: { sampleRate: 44_100, samples: 0 } });

    await expect(runNativeRuntimeBenchmark(adapter, { prompts: ["Hello"], runs: 1, warmupRuns: 0, now }))
      .rejects.toThrow('kitten benchmark produced no audio for "Hello".');
    expect(adapter.dispose).toHaveBeenCalledTimes(1);
  });

  it("refuses a take with an unusable sample rate", async () => {
    const { adapter, now } = scriptedRuntime({ audio: { sampleRate: Number.NaN, samples: 10 } });

    await expect(runNativeRuntimeBenchmark(adapter, { prompts: ["Hello"], runs: 1, warmupRuns: 0, now }))
      .rejects.toThrow("produced no audio");
  });

  it("disposes of the runtime when the load fails", async () => {
    const { adapter, now } = scriptedRuntime();
    vi.mocked(adapter.load).mockRejectedValueOnce(new Error("Kitten weights failed integrity verification."));

    await expect(runNativeRuntimeBenchmark(adapter, { prompts: ["Hello"], runs: 1, warmupRuns: 0, now }))
      .rejects.toThrow("Kitten weights failed integrity verification.");
    expect(adapter.dispose).toHaveBeenCalledTimes(1);
  });

  it("validates its options before loading anything", async () => {
    const { adapter } = scriptedRuntime();

    await expect(runNativeRuntimeBenchmark(adapter, { prompts: [], runs: 1, warmupRuns: 0 }))
      .rejects.toThrow("Benchmark prompts must be non-empty.");
    await expect(runNativeRuntimeBenchmark(adapter, { prompts: ["  "], runs: 1, warmupRuns: 0 }))
      .rejects.toThrow("Benchmark prompts must be non-empty.");
    await expect(runNativeRuntimeBenchmark(adapter, { prompts: ["Hi"], runs: 0, warmupRuns: 0 }))
      .rejects.toThrow("Benchmark runs must be an integer from 1 to 100.");
    await expect(runNativeRuntimeBenchmark(adapter, { prompts: ["Hi"], runs: 1, warmupRuns: -1 }))
      .rejects.toThrow("Benchmark warm-up runs must be an integer from 0 to 100.");
    expect(adapter.load).not.toHaveBeenCalled();
  });

  it("uses the real clock by default", async () => {
    const { adapter } = scriptedRuntime();

    const report = await runNativeRuntimeBenchmark(adapter, { prompts: ["Hi"], runs: 1, warmupRuns: 0 });

    expect(report.loadSec).toBeGreaterThanOrEqual(0);
    expect(report.runs[0].wallSec).toBeGreaterThanOrEqual(0);
  });

  it("ships default prompts every runtime can take in one request", () => {
    expect(DEFAULT_BENCHMARK_PROMPTS.length).toBeGreaterThan(0);
    for (const prompt of DEFAULT_BENCHMARK_PROMPTS) {
      expect(prompt.trim().length).toBeGreaterThan(0);
      // Audio8's per-request cap is the tightest of the native runtimes.
      expect([...prompt].length).toBeLessThanOrEqual(1000);
    }
  });
});

describe("summarizeBenchmarkValues", () => {
  it("reports the median of odd and even samples", () => {
    expect(summarizeBenchmarkValues([3, 1, 2])).toEqual({ min: 1, median: 2, mean: 2, max: 3 });
    expect(summarizeBenchmarkValues([4, 1, 3, 2])).toEqual({ min: 1, median: 2.5, mean: 2.5, max: 4 });
  });

  it("refuses an empty sample", () => {
    expect(() => summarizeBenchmarkValues([])).toThrow("Cannot summarize an empty benchmark.");
  });
});

describe("parseNativeBenchmarkArgs", () => {
  it("defaults to three measured Audio8 runs after one warm-up", () => {
    expect(parseNativeBenchmarkArgs([])).toEqual({ runtime: "audio8", runs: 3, warmupRuns: 1, runtimeOptions: {} });
  });

  it("reads every flag and passes runtime options through as typed", () => {
    expect(parseNativeBenchmarkArgs([
      "--runtime", "kitten",
      "--runs", "5",
      "--warmup", "0",
      "--output", "reports/native.json",
      "--voice", "iris",
      "--seed", "7",
      "--temperature", "0.5",
    ])).toEqual({
      runtime: "kitten",
      runs: 5,
      warmupRuns: 0,
      output: "reports/native.json",
      runtimeOptions: { voice: "iris", seed: "7", temperature: "0.5" },
    });
  });

  it("refuses unknown flags, missing values and bad counts", () => {
    expect(() => parseNativeBenchmarkArgs(["--fast", "yes"])).toThrow("Unknown benchmark flag --fast.");
    expect(() => parseNativeBenchmarkArgs(["--toString", "1"])).toThrow("Unknown benchmark flag --toString.");
    expect(() => parseNativeBenchmarkArgs(["--runs"])).toThrow("Benchmark flag --runs needs a value.");
    expect(() => parseNativeBenchmarkArgs(["--runs", "--warmup", "1"])).toThrow("Benchmark flag --runs needs a value.");
    expect(() => parseNativeBenchmarkArgs(["--runs", "1.5"])).toThrow("Benchmark runs must be an integer from 1 to 100.");
    expect(() => parseNativeBenchmarkArgs(["--warmup", "101"])).toThrow("Benchmark warm-up runs must be an integer from 0 to 100.");
  });
});

describe("describeBenchmarkMachine", () => {
  const source = {
    platform: "darwin",
    arch: "arm64",
    release: () => "25.0.0",
    cpus: () => [{ model: " Apple M1 Pro " }, { model: "Apple M1 Pro" }],
    totalmem: () => 16 * 1024 ** 3,
    nodeVersion: "v24.1.0",
  };

  it("records what the numbers were measured on", () => {
    expect(describeBenchmarkMachine(source)).toEqual({
      platform: "darwin",
      arch: "arm64",
      osRelease: "25.0.0",
      cpuModel: "Apple M1 Pro",
      logicalCores: 2,
      totalMemoryGiB: 16,
      node: "v24.1.0",
    });
  });

  it("names an unreported CPU as unknown", () => {
    expect(describeBenchmarkMachine({ ...source, cpus: () => [] }).cpuModel).toBe("unknown");
    expect(describeBenchmarkMachine({ ...source, cpus: () => [{ model: "  " }] }).cpuModel).toBe("unknown");
  });
});
