#!/usr/bin/env node
/**
 * Measures load time, time to first audio and real-time factor of a desktop
 * native runtime, against the compiled Electron output.
 *
 *   npm run build:electron:main
 *   OPEN_TTS_AUDIO8_MODEL_DIR=<revision dir> node scripts/benchmark-native-runtimes.cjs \
 *     [--runtime audio8] [--runs 3] [--warmup 1] [--voice clara] [--seed 42] \
 *     [--temperature 0.3] [--output report.json]
 *
 * The JSON report goes to stdout, and to --output when given. Loading fills in
 * any file missing from the model directory, exactly as the app does.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DIST = path.resolve(__dirname, "..", "dist-electron");

function requireDist(file) {
  const target = path.join(DIST, file);
  if (!fs.existsSync(target)) {
    throw new Error(`Missing ${path.relative(process.cwd(), target)}. Run "npm run build:electron:main" first.`);
  }
  return require(target);
}

function requireModelDir(variable, label) {
  const modelDir = process.env[variable];
  if (!modelDir) throw new Error(`Set ${variable} to the downloaded ${label} revision directory before benchmarking it.`);
  if (!fs.existsSync(modelDir)) throw new Error(`${label} model directory does not exist: ${modelDir}`);
  return modelDir;
}

/**
 * One factory per runtime. Each returns a NativeRuntimeBenchmarkAdapter (see
 * electron/nativeModels/runtimeBenchmark.ts); a new native model joins the
 * benchmark by adding an entry here.
 */
const RUNTIMES = {
  audio8(runtimeOptions) {
    const modelDir = requireModelDir("OPEN_TTS_AUDIO8_MODEL_DIR", "Audio8");
    const { Audio8NativeClient } = requireDist("audio8NativeClient.js");
    const { createAudio8BenchmarkAdapter } = requireDist("audio8Benchmark.js");
    return createAudio8BenchmarkAdapter(new Audio8NativeClient(modelDir), runtimeOptions);
  },
};

async function main() {
  const {
    DEFAULT_BENCHMARK_PROMPTS,
    describeBenchmarkMachine,
    parseNativeBenchmarkArgs,
    runNativeRuntimeBenchmark,
  } = requireDist("nativeModels/runtimeBenchmark.js");
  const args = parseNativeBenchmarkArgs(process.argv.slice(2));
  if (!Object.hasOwn(RUNTIMES, args.runtime)) {
    throw new Error(`Unknown runtime "${args.runtime}". Choose one of: ${Object.keys(RUNTIMES).join(", ")}.`);
  }
  const adapter = RUNTIMES[args.runtime](args.runtimeOptions);
  const report = await runNativeRuntimeBenchmark(adapter, {
    prompts: DEFAULT_BENCHMARK_PROMPTS,
    runs: args.runs,
    warmupRuns: args.warmupRuns,
  });
  const output = {
    measuredAt: new Date().toISOString(),
    machine: describeBenchmarkMachine({
      platform: process.platform,
      arch: process.arch,
      release: os.release,
      cpus: os.cpus,
      totalmem: os.totalmem,
      nodeVersion: process.version,
    }),
    ...report,
  };
  const json = `${JSON.stringify(output, null, 2)}\n`;
  if (args.output) {
    fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
    fs.writeFileSync(args.output, json);
  }
  process.stdout.write(json);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
