import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import { createServer } from "vite";
import {
  createElectronOutputParser,
  getRequestedModelExitCode,
} from "./inference-speed-output.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(scriptPath), "..");
export const REPORT_SCHEMA_VERSION = 3;
const BENCHMARK_MODELS = new Set(["both", "kokoro", "supertonic"]);

const COMPARISON_FIELD_LABELS = {
  schemaVersion: "report schema version",
  model: "model",
  modelId: "model identifier",
  modelRevision: "immutable model revision",
  backend: "model backend",
  voice: "voice",
  selectedModels: "selected model set",
  inputTextSha256: "input text",
  warmups: "warm-up count",
  iterations: "measured iteration count",
  quality: "quality",
  speed: "speed",
  userAgent: "Electron/Chromium/OS user agent",
  crossOriginIsolated: "cross-origin isolation",
  backgroundThrottling: "benchmark background-throttling mode",
  webgpuFeatureMode: "benchmark WebGPU feature switches",
  hostPlatform: "host platform",
  hostArch: "host architecture",
  cpuModel: "CPU model",
  logicalCpuCount: "logical CPU count",
  totalMemoryBytes: "total system memory",
  webgpuAvailable: "WebGPU availability",
  webgpuReason: "WebGPU status",
};

export function parseArgs(argv) {
  const options = {
    model: "both",
    iterations: 3,
    warmups: 1,
    quality: 5,
    speed: 1,
    timeoutMs: 15 * 60 * 1000,
    port: 5174,
    reportDir: path.join(rootDir, "reports", "inference-speed"),
    baseline: null,
    text: null,
    textFile: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = (name) => {
      if (arg.startsWith(`${name}=`)) {
        const value = arg.slice(name.length + 1);
        if (!value) throw new Error(`${name} requires a value.`);
        return value;
      }
      if (arg !== name) return null;
      index += 1;
      const value = argv[index];
      if (value == null || value === "") throw new Error(`${name} requires a value.`);
      return value;
    };

    let value;
    if ((value = readValue("--model")) !== null) options.model = value;
    else if ((value = readValue("--iterations")) !== null) options.iterations = Number(value);
    else if ((value = readValue("--warmups")) !== null) options.warmups = Number(value);
    else if ((value = readValue("--quality")) !== null) options.quality = Number(value);
    else if ((value = readValue("--speed")) !== null) options.speed = Number(value);
    else if ((value = readValue("--timeout-ms")) !== null) options.timeoutMs = Number(value);
    else if ((value = readValue("--port")) !== null) options.port = Number(value);
    else if ((value = readValue("--report-dir")) !== null) options.reportDir = path.resolve(rootDir, value);
    else if ((value = readValue("--baseline")) !== null) options.baseline = path.resolve(rootDir, value);
    else if ((value = readValue("--text-file")) !== null) options.textFile = path.resolve(rootDir, value);
    else if ((value = readValue("--text")) !== null) options.text = value;
    else throw new Error(`Unknown inference benchmark option: ${arg}`);
  }

  if (!BENCHMARK_MODELS.has(options.model)) {
    throw new Error(`--model must be one of: ${[...BENCHMARK_MODELS].join(", ")}.`);
  }
  if (!Number.isInteger(options.iterations) || options.iterations < 1 || options.iterations > 100) {
    throw new Error("--iterations must be an integer between 1 and 100.");
  }
  if (!Number.isInteger(options.warmups) || options.warmups < 0 || options.warmups > 100) {
    throw new Error("--warmups must be an integer between 0 and 100.");
  }
  if (!Number.isInteger(options.quality) || options.quality < 1 || options.quality > 20) {
    throw new Error("--quality must be an integer between 1 and 20.");
  }
  if (!Number.isFinite(options.speed) || options.speed < 0.85 || options.speed > 1.15) {
    throw new Error("--speed must be between 0.85 and 1.15.");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1_000) {
    throw new Error("--timeout-ms must be at least 1000.");
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new Error("--port must be an integer between 1 and 65535.");
  }

  return options;
}

export function encodeParams(options) {
  const params = new URLSearchParams({
    model: options.model,
    iterations: String(options.iterations),
    warmups: String(options.warmups),
    quality: String(options.quality),
    speed: String(options.speed),
    timeoutMs: String(options.timeoutMs),
  });

  if (options.text) {
    params.set("text", options.text);
  }

  return params;
}

function runElectron(targetUrl, timeoutMs) {
  const runnerPath = path.join(rootDir, "scripts", "inference-speed-electron.mjs");

  return new Promise((resolve, reject) => {
    const child = spawn(electronPath, [
      runnerPath,
      `--target=${targetUrl}`,
      `--timeout-ms=${timeoutMs}`,
    ], {
      cwd: rootDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      },
    });

    const output = createElectronOutputParser((line) => process.stdout.write(`${line}\n`));

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => output.pushStdout(chunk));
    child.stderr.on("data", (chunk) => output.pushStderr(chunk));

    child.on("error", reject);
    child.on("close", (code) => {
      const { result, stderr, parseError } = output.finish();
      if (parseError) {
        reject(parseError);
        return;
      }
      if (result) {
        resolve(result);
        return;
      }
      reject(new Error(stderr.trim() || `Electron benchmark exited with code ${code}.`));
    });
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function webgpuReason(report) {
  if (report.webgpu?.reason !== undefined && report.webgpu.reason !== null) {
    return report.webgpu.reason;
  }
  return report.webgpu?.available === true ? "available" : undefined;
}

export function createComparisonFingerprint(report, modelResult) {
  const text = report.options?.text;
  return {
    schemaVersion: report.runner?.benchmarkSchemaVersion,
    model: modelResult?.model,
    modelId: modelResult?.modelId,
    modelRevision: modelResult?.modelRevision,
    backend: modelResult?.backend,
    voice: modelResult?.voice,
    selectedModels: report.options?.model,
    inputTextSha256: typeof text === "string" ? sha256(text) : undefined,
    warmups: report.options?.warmups,
    iterations: report.options?.iterations,
    quality: report.options?.quality,
    speed: report.options?.speed,
    userAgent: report.runner?.userAgent,
    crossOriginIsolated: report.runner?.crossOriginIsolated,
    backgroundThrottling: report.runner?.backgroundThrottling,
    webgpuFeatureMode: report.runner?.webgpuFeatureMode,
    hostPlatform: report.runner?.host?.platform,
    hostArch: report.runner?.host?.arch,
    cpuModel: report.runner?.host?.cpuModel,
    logicalCpuCount: report.runner?.host?.logicalCpuCount,
    totalMemoryBytes: report.runner?.host?.totalMemoryBytes,
    webgpuAvailable: report.webgpu?.available,
    webgpuReason: webgpuReason(report),
  };
}

function fingerprintHash(fingerprint) {
  return Object.values(fingerprint).some((value) => value === undefined || value === null)
    ? null
    : sha256(JSON.stringify(fingerprint));
}

function comparisonMismatchReasons(currentFingerprint, baselineFingerprint) {
  const reasons = [];
  for (const [field, label] of Object.entries(COMPARISON_FIELD_LABELS)) {
    const current = currentFingerprint[field];
    const previous = baselineFingerprint[field];
    if (current === undefined || current === null || previous === undefined || previous === null) {
      const missingFrom = [
        ...(current === undefined || current === null ? ["current"] : []),
        ...(previous === undefined || previous === null ? ["baseline"] : []),
      ].join(" and ");
      reasons.push(`${label} is missing from the ${missingFrom} report.`);
    } else if (!Object.is(current, previous)) {
      reasons.push(`${label} differs.`);
    }
  }
  return reasons;
}

function validMeanGenerationMs(modelResult) {
  const value = modelResult?.summary?.meanGenerationMs;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function summarizeComparison(result, baseline) {
  const comparisons = [];
  for (const current of result.models) {
    const previous = baseline.models?.find((entry) => entry.model === current.model);
    if (!previous) {
      comparisons.push({
        model: current.model,
        status: "skipped",
        compatible: false,
        reasons: ["The baseline report has no result for this model."],
      });
      continue;
    }

    const failureReasons = [];
    if (current.error) failureReasons.push(`Current benchmark failed: ${current.error}`);
    if (previous.error) failureReasons.push(`Baseline benchmark failed: ${previous.error}`);
    const currentMs = validMeanGenerationMs(current);
    const previousMs = validMeanGenerationMs(previous);
    if (currentMs === null && !current.error) {
      failureReasons.push("Current benchmark has no valid mean generation time.");
    }
    if (previousMs === null && !previous.error) {
      failureReasons.push("Baseline benchmark has no valid mean generation time.");
    }
    if (failureReasons.length > 0) {
      comparisons.push({
        model: current.model,
        status: "skipped",
        compatible: false,
        reasons: failureReasons,
      });
      continue;
    }

    const currentFingerprint = createComparisonFingerprint(result, current);
    const baselineFingerprint = createComparisonFingerprint(baseline, previous);
    const reasons = comparisonMismatchReasons(currentFingerprint, baselineFingerprint);
    const currentFingerprintHash = fingerprintHash(currentFingerprint);
    const baselineFingerprintHash = fingerprintHash(baselineFingerprint);
    if (reasons.length > 0 || currentFingerprintHash !== baselineFingerprintHash) {
      comparisons.push({
        model: current.model,
        status: "incompatible",
        compatible: false,
        currentFingerprint: currentFingerprintHash,
        baselineFingerprint: baselineFingerprintHash,
        reasons: reasons.length > 0 ? reasons : ["Compatibility fingerprints differ."],
      });
      continue;
    }

    const improvement = ((previousMs - currentMs) / previousMs) * 100;
    comparisons.push({
      model: current.model,
      status: "compared",
      compatible: true,
      compatibilityFingerprint: currentFingerprintHash,
      previousMeanGenerationMs: previousMs,
      currentMeanGenerationMs: currentMs,
      improvementPercent: Math.round(improvement * 100) / 100,
    });
  }
  return comparisons;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.textFile) {
    options.text = await readFile(options.textFile, "utf8");
  }

  const server = await createServer({
    configFile: path.join(rootDir, "vite.config.ts"),
    root: rootDir,
    server: {
      host: "127.0.0.1",
      port: options.port,
      strictPort: false,
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      },
    },
  });

  await server.listen();

  try {
    const localUrl = server.resolvedUrls?.local?.[0];
    if (!localUrl) throw new Error("Vite did not expose a local server URL.");

    const target = new URL("/inference-speed.html", localUrl);
    target.search = encodeParams(options).toString();

    const result = await runElectron(target.toString(), options.timeoutMs);
    const cpus = os.cpus();
    result.runner = {
      ...result.runner,
      benchmarkSchemaVersion: REPORT_SCHEMA_VERSION,
      host: {
        platform: process.platform,
        arch: process.arch,
        cpuModel: cpus[0]?.model ?? null,
        logicalCpuCount: cpus.length,
        totalMemoryBytes: os.totalmem(),
      },
      backgroundThrottling: false,
      webgpuFeatureMode: process.platform === "linux" ? "unsafe-webgpu+vulkan" : "unsafe-webgpu",
      reportGeneratedAt: new Date().toISOString(),
      targetUrl: target.toString(),
    };

    if (options.baseline) {
      const baseline = JSON.parse(await readFile(options.baseline, "utf8"));
      result.comparison = summarizeComparison(result, baseline);
    }

    await mkdir(options.reportDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const reportPath = path.join(options.reportDir, `inference-speed-${stamp}.json`);
    await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`);

    console.log(`Inference speed report: ${reportPath}`);
    for (const model of result.models) {
      if (model.error) {
        console.log(`${model.model}: ERROR ${model.error}`);
        continue;
      }
      console.log(`${model.model}: mean ${model.summary.meanGenerationMs.toFixed(1)}ms, ${model.summary.meanCharsPerSec.toFixed(1)} chars/s, RTF ${model.summary.meanRtf.toFixed(3)}, backend ${model.backend}`);
    }

    if (result.comparison?.length) {
      for (const comparison of result.comparison) {
        if (comparison.status === "compared") {
          const percent = comparison.improvementPercent;
          const outcome = percent > 0
            ? `${percent.toFixed(2)}% faster`
            : percent < 0
              ? `${Math.abs(percent).toFixed(2)}% slower`
              : "unchanged";
          console.log(`${comparison.model}: ${outcome} versus baseline`);
        } else {
          console.log(`${comparison.model}: comparison ${comparison.status}: ${comparison.reasons.join(" ")}`);
        }
      }
    }

    const resultExitCode = getRequestedModelExitCode(result, options.model);
    if (resultExitCode !== 0) {
      process.exitCode = resultExitCode;
    }
  } finally {
    await server.close();
  }
}

const isDirectRun = process.argv[1] !== undefined && path.resolve(process.argv[1]) === scriptPath;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
