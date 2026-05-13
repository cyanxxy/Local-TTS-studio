import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import { createServer } from "vite";

const RESULT_PREFIX = "INFERENCE_SPEED_RESULT_JSON:";
const ERROR_PREFIX = "INFERENCE_SPEED_ERROR_JSON:";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
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
    const readValue = () => {
      const inline = arg.indexOf("=");
      if (inline !== -1) return arg.slice(inline + 1);
      index += 1;
      return argv[index];
    };

    if (arg.startsWith("--model")) options.model = readValue();
    else if (arg.startsWith("--iterations")) options.iterations = Number(readValue());
    else if (arg.startsWith("--warmups")) options.warmups = Number(readValue());
    else if (arg.startsWith("--quality")) options.quality = Number(readValue());
    else if (arg.startsWith("--speed")) options.speed = Number(readValue());
    else if (arg.startsWith("--timeout-ms")) options.timeoutMs = Number(readValue());
    else if (arg.startsWith("--port")) options.port = Number(readValue());
    else if (arg.startsWith("--report-dir")) options.reportDir = path.resolve(rootDir, readValue());
    else if (arg.startsWith("--baseline")) options.baseline = path.resolve(rootDir, readValue());
    else if (arg.startsWith("--text-file")) options.textFile = path.resolve(rootDir, readValue());
    else if (arg.startsWith("--text")) options.text = readValue();
  }

  return options;
}

function encodeParams(options) {
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

    let result = null;
    let stderr = "";

    const handleLine = (line) => {
      if (line.startsWith(RESULT_PREFIX)) {
        result = JSON.parse(line.slice(RESULT_PREFIX.length));
        return;
      }

      if (line.startsWith(ERROR_PREFIX)) {
        stderr += `${line.slice(ERROR_PREFIX.length)}\n`;
        return;
      }

      if (line.trim()) {
        process.stdout.write(`${line}\n`);
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => chunk.split(/\r?\n/).forEach((line) => line && handleLine(line)));
    child.stderr.on("data", (chunk) => chunk.split(/\r?\n/).forEach((line) => {
      if (!line) return;
      if (line.startsWith(ERROR_PREFIX)) handleLine(line);
      else stderr += `${line}\n`;
    }));

    child.on("error", reject);
    child.on("close", (code) => {
      if (result) {
        resolve(result);
        return;
      }
      reject(new Error(stderr.trim() || `Electron benchmark exited with code ${code}.`));
    });
  });
}

function summarizeComparison(result, baseline) {
  const comparisons = [];
  for (const current of result.models) {
    const previous = baseline.models?.find((entry) => entry.model === current.model);
    if (!previous?.summary || !current.summary) continue;

    const previousMs = previous.summary.meanGenerationMs;
    const currentMs = current.summary.meanGenerationMs;
    const improvement = previousMs > 0 ? ((previousMs - currentMs) / previousMs) * 100 : 0;
    comparisons.push({
      model: current.model,
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
    result.runner = {
      ...result.runner,
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
        console.log(`${comparison.model}: ${comparison.improvementPercent.toFixed(2)}% faster than baseline`);
      }
    }
  } finally {
    await server.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
