import { spawn } from "child_process";
import { existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { performance } from "perf_hooks";
import {
  parseBridgeEnvelopeResult,
  sanitizeGeneratePayload,
  type BridgeGenerateResult,
} from "./localTtsIpc";
import {
  createWebSocketBridgeWorkerPool,
  type WebSocketBridgeWorkerPool,
} from "./webSocketBridgeWorker";

export type Qwen3ProfileTarget = "candle" | "mlx-api" | "sglang";
export type Qwen3ProfileBackend = "candle" | "mlx-api-server" | "sglang";

export const QWEN3_CANDLE_PROFILE_MODEL = "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice";
export const QWEN3_MLX_PROFILE_MODEL = "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit";
export const DEFAULT_QWEN3_PROFILE_TEXT = [
  "Local Qwen text to speech should produce first audio quickly and sustain a low real-time factor.",
  "This profiling pass captures model load, first audio, inference, chunking, transport, and wall-clock timing.",
  "The text is long enough to exercise sentence chunking without turning the benchmark into a stress test.",
].join(" ");

const DEFAULT_ITERATIONS = 3;
const DEFAULT_WARMUPS = 1;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 125_000_000;
const DEFAULT_MAX_STDERR_BYTES = 1_000_000;
const DEFAULT_IDLE_EVICT_MS = 5 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 2_000;

export interface Qwen3ProfileArgs {
  targets: Qwen3ProfileTarget[];
  iterations: number;
  warmups: number;
  timeoutMs: number;
  text: string;
  textFile?: string;
  bridgeBinary?: string;
  cacheDir?: string;
  reportDir?: string;
  output?: string;
  baseModelPath?: string;
  sglangUrl?: string;
  sglangModel?: string;
  speaker: string;
  language: string;
  instruct?: string;
  deviceMap: string;
  dtype: string;
  attnImplementation: string;
  temperature?: number;
  topK?: number;
  topP?: number;
  maxNewTokens?: number;
}

export interface Qwen3BridgePayloadOptions {
  text: string;
  baseModelPath?: string;
  speaker?: string;
  language?: string;
  instruct?: string;
  deviceMap?: string;
  dtype?: string;
  attnImplementation?: string;
  temperature?: number;
  topK?: number;
  topP?: number;
  maxNewTokens?: number;
}

export interface Qwen3ProfileRun {
  target: Qwen3ProfileTarget;
  backend: Qwen3ProfileBackend;
  iteration: number;
  warmup: boolean;
  textLength: number;
  modelRepo: string;
  device?: string;
  sampleRate: number;
  durationSec: number;
  wallSec: number;
  elapsedSec: number;
  rtf: number | null;
  bridgeRtf: number | null;
  audioChunkCount: number;
  modelLoadSec: number | null;
  firstAudioSec: number | null;
  inferenceSec: number | null;
  outputEncodingSec: number | null;
  transportEncodingSec: number | null;
  warnings?: string[];
}

export interface Qwen3ProfileSummary {
  measuredRuns: number;
  meanWallSec: number;
  meanElapsedSec: number;
  meanRtf: number | null;
  meanBridgeRtf: number | null;
  meanFirstAudioSec: number | null;
  meanModelLoadSec: number | null;
  meanInferenceSec: number | null;
  totalAudioChunks: number;
}

export interface Qwen3TargetProfile {
  target: Qwen3ProfileTarget;
  backend: Qwen3ProfileBackend;
  runs: Qwen3ProfileRun[];
  summary: Qwen3ProfileSummary | null;
  error?: string;
}

export interface Qwen3ProfileReport {
  runner: {
    generatedAt: string;
    platform: NodeJS.Platform;
    arch: string;
    node: string;
    cwd: string;
    bridgeBinary?: string;
    cacheDir?: string;
  };
  options: Omit<Qwen3ProfileArgs, "text"> & {
    textLength: number;
  };
  targets: Qwen3TargetProfile[];
}

interface RunBridgeTargetOptions extends Qwen3ProfileArgs {
  bridgeBinary: string;
  cacheDir: string;
  env: NodeJS.ProcessEnv;
}

function readValue(argv: string[], index: number): { value: string; nextIndex: number } {
  const arg = argv[index];
  const inline = arg.indexOf("=");
  if (inline !== -1) return { value: arg.slice(inline + 1), nextIndex: index };
  const value = argv[index + 1];
  if (value == null || value.startsWith("--")) {
    throw new Error(`Missing value for ${arg}.`);
  }
  return { value, nextIndex: index + 1 };
}

function parsePositiveInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
  return parsed;
}

function parseOptionalNumberArg(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be a finite number.`);
  }
  return parsed;
}

function splitTargets(value: string): Qwen3ProfileTarget[] {
  const targets = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (targets.length === 0) throw new Error("At least one Qwen3 profile target is required.");
  const valid = new Set<Qwen3ProfileTarget>(["candle", "mlx-api", "sglang"]);
  for (const target of targets) {
    if (!valid.has(target as Qwen3ProfileTarget)) {
      throw new Error(`Unsupported Qwen3 profile target: ${target}`);
    }
  }
  return [...new Set(targets)] as Qwen3ProfileTarget[];
}

export function parseQwen3ProfileArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Qwen3ProfileArgs {
  const options: Qwen3ProfileArgs = {
    targets: env.OPEN_TTS_QWEN3_PROFILE_TARGETS
      ? splitTargets(env.OPEN_TTS_QWEN3_PROFILE_TARGETS)
      : ["candle", "mlx-api"],
    iterations: DEFAULT_ITERATIONS,
    warmups: DEFAULT_WARMUPS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    text: DEFAULT_QWEN3_PROFILE_TEXT,
    baseModelPath: env.OPEN_TTS_QWEN3_MLX_MODEL_DIR,
    sglangUrl: env.OPEN_TTS_QWEN3_SGLANG_URL,
    sglangModel: env.OPEN_TTS_QWEN3_SGLANG_MODEL,
    speaker: "Ryan",
    language: "English",
    deviceMap: "auto",
    dtype: "auto",
    attnImplementation: "eager",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const { value, nextIndex } = readValue(argv, index);
    index = nextIndex;

    if (arg.startsWith("--target")) options.targets = splitTargets(value);
    else if (arg.startsWith("--iterations")) options.iterations = parsePositiveInteger(value, "iterations");
    else if (arg.startsWith("--warmups")) options.warmups = parseNonNegativeInteger(value, "warmups");
    else if (arg.startsWith("--timeout-ms")) options.timeoutMs = parsePositiveInteger(value, "timeout-ms");
    else if (arg.startsWith("--text-file")) options.textFile = value;
    else if (arg.startsWith("--text")) options.text = value.trim() || DEFAULT_QWEN3_PROFILE_TEXT;
    else if (arg.startsWith("--bridge-binary")) options.bridgeBinary = value;
    else if (arg.startsWith("--cache-dir")) options.cacheDir = value;
    else if (arg.startsWith("--report-dir")) options.reportDir = value;
    else if (arg.startsWith("--output")) options.output = value;
    else if (arg.startsWith("--base-model-path")) options.baseModelPath = value;
    else if (arg.startsWith("--sglang-url")) options.sglangUrl = value;
    else if (arg.startsWith("--sglang-model")) options.sglangModel = value;
    else if (arg.startsWith("--speaker")) options.speaker = value;
    else if (arg.startsWith("--language")) options.language = value;
    else if (arg.startsWith("--instruct")) options.instruct = value;
    else if (arg.startsWith("--device-map")) options.deviceMap = value;
    else if (arg.startsWith("--dtype")) options.dtype = value;
    else if (arg.startsWith("--attn")) options.attnImplementation = value;
    else if (arg.startsWith("--temperature")) options.temperature = parseOptionalNumberArg(value, "temperature");
    else if (arg.startsWith("--top-k")) options.topK = parseNonNegativeInteger(value, "top-k");
    else if (arg.startsWith("--top-p")) options.topP = parseOptionalNumberArg(value, "top-p");
    else if (arg.startsWith("--max-new-tokens")) options.maxNewTokens = parsePositiveInteger(value, "max-new-tokens");
    else throw new Error(`Unknown Qwen3 profile option: ${arg}`);
  }

  if (options.sglangUrl && !options.targets.includes("sglang")) {
    options.targets = [...options.targets, "sglang"];
  }
  return options;
}

export function buildQwen3BridgePayload(
  target: Extract<Qwen3ProfileTarget, "candle" | "mlx-api">,
  options: Qwen3BridgePayloadOptions,
): Record<string, unknown> {
  const rawPayload = {
    text: options.text,
    modelRepo: target === "mlx-api" ? QWEN3_MLX_PROFILE_MODEL : QWEN3_CANDLE_PROFILE_MODEL,
    ...(target === "mlx-api" && options.baseModelPath ? { baseModelPath: options.baseModelPath } : {}),
    speaker: options.speaker ?? "Ryan",
    language: options.language ?? "English",
    ...(options.instruct ? { instruct: options.instruct } : {}),
    ...(options.deviceMap ? { deviceMap: options.deviceMap } : {}),
    ...(options.dtype ? { dtype: options.dtype } : {}),
    ...(options.attnImplementation ? { attnImplementation: options.attnImplementation } : {}),
    ...(options.temperature != null ? { temperature: options.temperature } : {}),
    ...(options.topK != null ? { topK: options.topK } : {}),
    ...(options.topP != null ? { topP: options.topP } : {}),
    ...(options.maxNewTokens != null ? { maxNewTokens: options.maxNewTokens } : {}),
  };
  return sanitizeGeneratePayload("qwen3", rawPayload);
}

function backendForTarget(target: Qwen3ProfileTarget): Qwen3ProfileBackend {
  if (target === "mlx-api") return "mlx-api-server";
  return target;
}

function phaseTiming(result: BridgeGenerateResult, key: string): number | null {
  return result.phaseTimingsSec[key] ?? null;
}

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? rounded(numerator / denominator) : null;
}

export function toQwen3BridgeProfileRun({
  target,
  iteration,
  warmup,
  text,
  wallSec,
  result,
}: {
  target: Extract<Qwen3ProfileTarget, "candle" | "mlx-api">;
  iteration: number;
  warmup: boolean;
  text: string;
  wallSec: number;
  result: BridgeGenerateResult;
}): Qwen3ProfileRun {
  return {
    target,
    backend: backendForTarget(target),
    iteration,
    warmup,
    textLength: text.length,
    modelRepo: result.modelRepo,
    ...(result.device ? { device: result.device } : {}),
    sampleRate: result.sampleRate,
    durationSec: result.durationSec,
    wallSec: rounded(wallSec),
    elapsedSec: result.elapsedSec,
    rtf: ratio(wallSec, result.durationSec),
    bridgeRtf: ratio(result.elapsedSec, result.durationSec),
    audioChunkCount: result.audioChunkCount,
    modelLoadSec: phaseTiming(result, "modelLoadSec"),
    firstAudioSec: phaseTiming(result, "firstAudioSec"),
    inferenceSec: phaseTiming(result, "inferenceSec"),
    outputEncodingSec: phaseTiming(result, "outputEncodingSec"),
    transportEncodingSec: phaseTiming(result, "transportEncodingSec"),
    ...(result.warnings ? { warnings: result.warnings } : {}),
  };
}

export function summarizeQwen3ProfileRuns(runs: Qwen3ProfileRun[]): Qwen3ProfileSummary | null {
  const measured = runs.filter((run) => !run.warmup);
  if (measured.length === 0) return null;
  const mean = (values: number[]): number => rounded(values.reduce((sum, value) => sum + value, 0) / values.length);
  const meanNullable = (values: Array<number | null>): number | null => {
    const numbers = values.filter((value): value is number => value != null);
    return numbers.length > 0 ? mean(numbers) : null;
  };

  return {
    measuredRuns: measured.length,
    meanWallSec: mean(measured.map((run) => run.wallSec)),
    meanElapsedSec: mean(measured.map((run) => run.elapsedSec)),
    meanRtf: meanNullable(measured.map((run) => run.rtf)),
    meanBridgeRtf: meanNullable(measured.map((run) => run.bridgeRtf)),
    meanFirstAudioSec: meanNullable(measured.map((run) => run.firstAudioSec)),
    meanModelLoadSec: meanNullable(measured.map((run) => run.modelLoadSec)),
    meanInferenceSec: meanNullable(measured.map((run) => run.inferenceSec)),
    totalAudioChunks: measured.reduce((sum, run) => sum + run.audioChunkCount, 0),
  };
}

function executableName(baseName: string): string {
  return process.platform === "win32" ? `${baseName}.exe` : baseName;
}

export function defaultBridgeBinary(cwd = process.cwd()): string {
  return path.join(cwd, "dist-rust", executableName("open-tts-local-bridge"));
}

export function defaultProfileCacheDir(cwd = process.cwd()): string {
  return path.join(cwd, ".model-cache", "qwen3-profile");
}

function shouldForwardEnv(key: string): boolean {
  return [
    "CUDA_",
    "HF_",
    "HUGGINGFACE_",
    "OPEN_TTS_",
    "TTS_",
  ].some((prefix) => key.startsWith(prefix))
    || [
      "HOME",
      "LANG",
      "LC_ALL",
      "LOGNAME",
      "PATH",
      "REQUESTS_CA_BUNDLE",
      "SSL_CERT_FILE",
      "SHELL",
      "SystemRoot",
      "TEMP",
      "TMP",
      "TMPDIR",
      "USER",
      "USERPROFILE",
      "WINDIR",
    ].includes(key);
}

export function buildQwen3ProfileEnv(
  cacheDir: string,
  bridgeBinary: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const forwarded: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && shouldForwardEnv(key)) forwarded[key] = value;
  }

  const hfHome = path.join(cacheDir, "huggingface");
  forwarded.HF_HOME = hfHome;
  forwarded.HF_HUB_CACHE = path.join(hfHome, "hub");
  forwarded.HUGGINGFACE_HUB_CACHE = path.join(hfHome, "hub");

  const binaryDir = path.dirname(bridgeBinary);
  const bundledWorker = path.join(binaryDir, executableName("pibot-tts-worker"));
  const bundledTts = path.join(binaryDir, executableName("tts"));
  const bundledApiServer = path.join(binaryDir, executableName("api_server"));
  if (!forwarded.OPEN_TTS_QWEN3_MLX_WORKER && existsSync(bundledWorker)) {
    forwarded.OPEN_TTS_QWEN3_MLX_WORKER = bundledWorker;
  }
  if (!forwarded.OPEN_TTS_QWEN3_MLX_TTS && existsSync(bundledTts)) {
    forwarded.OPEN_TTS_QWEN3_MLX_TTS = bundledTts;
  }
  if (!forwarded.OPEN_TTS_QWEN3_MLX_API_SERVER && existsSync(bundledApiServer)) {
    forwarded.OPEN_TTS_QWEN3_MLX_API_SERVER = bundledApiServer;
  }
  return forwarded;
}

export function createQwen3ProfileWorkerPool(): WebSocketBridgeWorkerPool<"qwen3"> {
  return createWebSocketBridgeWorkerPool<"qwen3">({
    idleEvictMs: DEFAULT_IDLE_EVICT_MS,
    killGraceMs: DEFAULT_KILL_GRACE_MS,
    spawn: (model, { bridgeBinary, cacheDir, env, authToken, host, port }) =>
      spawn(
        bridgeBinary,
        [
          "--action",
          "serve-ws",
          "--model",
          model,
          "--cache-dir",
          cacheDir,
          "--host",
          host,
          "--port",
          String(port),
          "--auth-token",
          authToken,
        ],
        { stdio: ["pipe", "pipe", "pipe"], env, cwd: cacheDir },
      ),
  });
}

async function runBridgeTarget(
  target: Extract<Qwen3ProfileTarget, "candle" | "mlx-api">,
  options: RunBridgeTargetOptions,
  pool: WebSocketBridgeWorkerPool<"qwen3">,
): Promise<Qwen3TargetProfile> {
  const runs: Qwen3ProfileRun[] = [];
  const totalRuns = options.warmups + options.iterations;
  for (let index = 0; index < totalRuns; index += 1) {
    const warmup = index < options.warmups;
    const payload = buildQwen3BridgePayload(target, options);
    const requestId = `qwen3-profile-${target}-${Date.now()}-${index + 1}`;
    const started = performance.now();
    const { response } = await pool.run("qwen3", {
      requestId,
      payload,
      spawnConfig: {
        bridgeBinary: options.bridgeBinary,
        cacheDir: options.cacheDir,
        env: options.env,
      },
      idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
      maxStdoutBytes: DEFAULT_MAX_OUTPUT_BYTES,
      maxStderrBytes: DEFAULT_MAX_STDERR_BYTES,
      onProgress: () => {},
      onAudioChunk: () => {},
    });
    const result = parseBridgeEnvelopeResult(response, "generate") as BridgeGenerateResult;
    runs.push(toQwen3BridgeProfileRun({
      target,
      iteration: index + 1,
      warmup,
      text: options.text,
      wallSec: (performance.now() - started) / 1000,
      result,
    }));
  }

  return {
    target,
    backend: backendForTarget(target),
    runs,
    summary: summarizeQwen3ProfileRuns(runs),
  };
}

async function runSglangTarget(options: Qwen3ProfileArgs): Promise<Qwen3TargetProfile> {
  if (!options.sglangUrl) {
    throw new Error("SGLang target requires --sglang-url or OPEN_TTS_QWEN3_SGLANG_URL.");
  }

  const runs: Qwen3ProfileRun[] = [];
  const totalRuns = options.warmups + options.iterations;
  for (let index = 0; index < totalRuns; index += 1) {
    const warmup = index < options.warmups;
    const started = performance.now();
    let firstAudioSec: number | null = null;
    let audioChunkCount = 0;
    let audioBytes = 0;
    const response = await fetch(options.sglangUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(options.sglangModel ? { model: options.sglangModel } : {}),
        input: options.text,
        voice: options.speaker,
        language: options.language,
        response_format: "pcm",
        stream: true,
        ...(options.instruct ? { instructions: options.instruct } : {}),
        ...(options.maxNewTokens != null ? { max_new_tokens: options.maxNewTokens } : {}),
      }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`SGLang returned HTTP ${response.status}: ${await response.text()}`);
    }
    const sampleRate = Number(response.headers.get("x-sample-rate")) || 24_000;
    const reader = response.body?.getReader();
    if (!reader) throw new Error("SGLang response did not expose a readable body.");
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      firstAudioSec ??= rounded((performance.now() - started) / 1000);
      audioChunkCount += 1;
      audioBytes += value.byteLength;
    }
    const wallSec = rounded((performance.now() - started) / 1000);
    const durationSec = rounded((audioBytes / 2) / sampleRate);
    runs.push({
      target: "sglang",
      backend: "sglang",
      iteration: index + 1,
      warmup,
      textLength: options.text.length,
      modelRepo: options.sglangModel ?? "sglang-omni",
      sampleRate,
      durationSec,
      wallSec,
      elapsedSec: wallSec,
      rtf: ratio(wallSec, durationSec),
      bridgeRtf: null,
      audioChunkCount,
      modelLoadSec: null,
      firstAudioSec,
      inferenceSec: wallSec,
      outputEncodingSec: null,
      transportEncodingSec: null,
    });
  }

  return {
    target: "sglang",
    backend: "sglang",
    runs,
    summary: summarizeQwen3ProfileRuns(runs),
  };
}

export async function runQwen3Profile(
  options: Qwen3ProfileArgs,
): Promise<Qwen3ProfileReport> {
  const bridgeBinary = options.bridgeBinary ?? defaultBridgeBinary();
  const cacheDir = options.cacheDir ?? defaultProfileCacheDir();
  const env = buildQwen3ProfileEnv(cacheDir, bridgeBinary);
  await mkdir(cacheDir, { recursive: true });
  const pool = createQwen3ProfileWorkerPool();
  const targets: Qwen3TargetProfile[] = [];

  try {
    for (const target of options.targets) {
      try {
        if (target === "sglang") {
          targets.push(await runSglangTarget(options));
        } else {
          targets.push(await runBridgeTarget(target, { ...options, bridgeBinary, cacheDir, env }, pool));
        }
      } catch (err) {
        targets.push({
          target,
          backend: backendForTarget(target),
          runs: [],
          summary: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    await pool.shutdownAll();
  }

  const reportedOptions = Object.fromEntries(
    Object.entries(options).filter(([key]) => key !== "text"),
  ) as Omit<Qwen3ProfileArgs, "text">;
  return {
    runner: {
      generatedAt: new Date().toISOString(),
      platform: process.platform,
      arch: os.arch(),
      node: process.version,
      cwd: process.cwd(),
      bridgeBinary,
      cacheDir,
    },
    options: {
      ...reportedOptions,
      textLength: options.text.length,
    },
    targets,
  };
}

export async function writeQwen3ProfileReport(
  report: Qwen3ProfileReport,
  options: Qwen3ProfileArgs,
): Promise<string> {
  if (options.output) {
    await mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
    await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
    return path.resolve(options.output);
  }
  const reportDir = path.resolve(options.reportDir ?? path.join("reports", "qwen3-profile"));
  await mkdir(reportDir, { recursive: true });
  const stamp = report.runner.generatedAt.replace(/[:.]/g, "-");
  const reportPath = path.join(reportDir, `qwen3-profile-${stamp}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return reportPath;
}

function formatNullableSeconds(value: number | null): string {
  return value == null ? "n/a" : `${value.toFixed(3)}s`;
}

function formatNullableNumber(value: number | null): string {
  return value == null ? "n/a" : value.toFixed(3);
}

export function formatQwen3ProfileConsoleLines(
  report: Qwen3ProfileReport,
  reportPath: string,
): string[] {
  const lines = [`Qwen3 profile report: ${reportPath}`];
  for (const target of report.targets) {
    if (target.error) {
      lines.push(`${target.target}: ERROR ${target.error}`);
      continue;
    }
    const summary = target.summary;
    if (!summary) {
      lines.push(`${target.target}: no measured runs`);
      continue;
    }
    lines.push([
      `${target.target}: mean wall ${summary.meanWallSec.toFixed(3)}s`,
      `RTF ${formatNullableNumber(summary.meanRtf)}`,
      `first audio ${formatNullableSeconds(summary.meanFirstAudioSec)}`,
      `model load ${formatNullableSeconds(summary.meanModelLoadSec)}`,
      `inference ${formatNullableSeconds(summary.meanInferenceSec)}`,
      `chunks ${summary.totalAudioChunks}`,
    ].join(", "));
  }
  return lines;
}
