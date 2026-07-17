// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createComparisonFingerprint,
  encodeParams,
  parseArgs,
  REPORT_SCHEMA_VERSION,
  summarizeComparison,
} from "./scripts/inference-speed-eval.mjs";
import {
  createElectronOutputParser,
  getRequestedModelFailures,
  getRequestedModelExitCode,
  RESULT_PREFIX,
} from "./scripts/inference-speed-output.mjs";

function benchmarkReport(meanGenerationMs = 100) {
  return {
    runner: {
      benchmarkSchemaVersion: REPORT_SCHEMA_VERSION,
      userAgent: "Mozilla/5.0 Chrome/146.0.0.0 Electron/42.3.0",
      crossOriginIsolated: true,
      backgroundThrottling: false,
      webgpuFeatureMode: "unsafe-webgpu",
      host: {
        platform: "darwin",
        arch: "arm64",
        cpuModel: "Apple M4",
        logicalCpuCount: 10,
        totalMemoryBytes: 17_179_869_184,
      },
    },
    options: {
      model: "kokoro",
      iterations: 3,
      warmups: 1,
      quality: 5,
      speed: 1,
      text: "A stable benchmark sentence.",
    },
    webgpu: {
      available: true,
      reason: null,
      message: null,
    },
    models: [{
      model: "kokoro",
      modelId: "onnx-community/Kokoro-82M-v1.0-ONNX",
      modelRevision: "1939ad2a8e416c0acfeecc08a694d14ef25f2231",
      backend: "webgpu",
      voice: "af_heart",
      summary: { meanGenerationMs },
    }],
  };
}

describe("inference speed CLI", () => {
  it("preserves --warmups 0 in the benchmark URL", () => {
    const options = parseArgs(["--model", "kokoro", "--warmups", "0"]);
    expect(options.warmups).toBe(0);
    expect(encodeParams(options).get("warmups")).toBe("0");
  });

  it("rejects invalid, missing, or unknown CLI options before launching Electron", () => {
    expect(() => parseArgs(["--model", "bogus"])).toThrow(/--model must be one of/);
    expect(() => parseArgs(["--model"])).toThrow(/requires a value/);
    expect(() => parseArgs(["--warmups", "-1"])).toThrow(/between 0 and 100/);
    expect(() => parseArgs(["--unknown", "value"])).toThrow(/Unknown inference benchmark option/);
    expect(() => getRequestedModelExitCode({ models: [] }, "bogus")).toThrow(/Unsupported/);
  });

  it("mirrors production WebGPU flags and disables hidden-window throttling", () => {
    const runner = readFileSync("scripts/inference-speed-electron.mjs", "utf8");
    expect(runner).toContain('appendSwitch("enable-unsafe-webgpu")');
    expect(runner).toContain('appendSwitch("enable-features", "Vulkan")');
    expect(runner).toContain("backgroundThrottling: false");
  });

  it("buffers child stdout until a complete result line is available", () => {
    const output = createElectronOutputParser();
    const payload = { models: [{ model: "kokoro", summary: { meanGenerationMs: 10 } }] };
    const line = `${RESULT_PREFIX}${JSON.stringify(payload)}`;

    output.pushStdout(line.slice(0, 12));
    output.pushStdout(line.slice(12, 37));
    output.pushStdout(`${line.slice(37)}\n`);

    expect(output.finish()).toMatchObject({ result: payload, stderr: "", parseError: null });
  });

  it("flushes a result line that has no trailing newline", () => {
    const output = createElectronOutputParser();
    const payload = { models: [] };
    output.pushStdout(`${RESULT_PREFIX}${JSON.stringify(payload)}`);
    expect(output.finish().result).toEqual(payload);
  });

  it("identifies errors only for requested models", () => {
    const result = {
      models: [
        { model: "kokoro", error: "load failed" },
        { model: "supertonic", summary: { meanGenerationMs: 10 } },
      ],
    };

    expect(getRequestedModelFailures(result, "both")).toEqual([result.models[0]]);
    expect(getRequestedModelFailures(result, "kokoro")).toEqual([result.models[0]]);
    expect(getRequestedModelFailures(result, "supertonic")).toEqual([]);
    expect(getRequestedModelExitCode(result, "both")).toBe(1);
    expect(getRequestedModelExitCode(result, "kokoro")).toBe(1);
    expect(getRequestedModelExitCode(result, "supertonic")).toBe(0);
    expect(getRequestedModelExitCode({ models: [] }, "both")).toBe(1);
  });

  it("compares only reports with identical compatibility fingerprints", () => {
    const baseline = benchmarkReport(100);
    const current = benchmarkReport(90);

    const [comparison] = summarizeComparison(current, baseline);
    expect(comparison).toMatchObject({
      model: "kokoro",
      status: "compared",
      compatible: true,
      previousMeanGenerationMs: 100,
      currentMeanGenerationMs: 90,
      improvementPercent: 10,
    });
    expect(comparison.compatibilityFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(createComparisonFingerprint(current, current.models[0]).inputTextSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("marks option, runtime, hardware, and backend mismatches incompatible", () => {
    const baseline = benchmarkReport(100);
    const current = benchmarkReport(90);
    current.runner.benchmarkSchemaVersion += 1;
    current.models[0].modelId = "different/model";
    current.models[0].modelRevision = "different-revision";
    current.models[0].backend = "wasm";
    current.models[0].voice = "af_bella";
    current.options.model = "both";
    current.options.text = "Different text.";
    current.options.warmups = 0;
    current.options.iterations = 5;
    current.options.quality = 6;
    current.options.speed = 1.1;
    current.runner.userAgent = "Mozilla/5.0 Chrome/147.0.0.0 Electron/43.0.0";
    current.runner.crossOriginIsolated = false;
    current.runner.host.platform = "win32";
    current.runner.host.arch = "x64";
    current.runner.host.cpuModel = "Different CPU";
    current.runner.host.logicalCpuCount = 12;
    current.runner.host.totalMemoryBytes *= 2;
    current.webgpu.available = false;
    current.webgpu.reason = "unsupported";

    const [comparison] = summarizeComparison(current, baseline);
    expect(comparison.status).toBe("incompatible");
    expect(comparison.compatible).toBe(false);
    expect(comparison.reasons).toEqual(expect.arrayContaining([
      "report schema version differs.",
      "model identifier differs.",
      "model backend differs.",
      "voice differs.",
      "selected model set differs.",
      "input text differs.",
      "warm-up count differs.",
      "measured iteration count differs.",
      "quality differs.",
      "speed differs.",
      "Electron/Chromium/OS user agent differs.",
      "cross-origin isolation differs.",
      "host platform differs.",
      "host architecture differs.",
      "CPU model differs.",
      "logical CPU count differs.",
      "total system memory differs.",
      "WebGPU availability differs.",
      "WebGPU status differs.",
    ]));
    expect(comparison).not.toHaveProperty("improvementPercent");
  });

  it("skips failed, invalid, or missing baseline model results", () => {
    const baseline = benchmarkReport(100);
    const failed = benchmarkReport(90);
    failed.models[0].error = "load failed";
    failed.models[0].summary = null;

    const [failedComparison] = summarizeComparison(failed, baseline);
    expect(failedComparison).toMatchObject({ status: "skipped", compatible: false });
    expect(failedComparison.reasons).toContain("Current benchmark failed: load failed");
    expect(failedComparison).not.toHaveProperty("improvementPercent");

    const invalid = benchmarkReport(90);
    invalid.models[0].summary.meanGenerationMs = 0;
    const [invalidComparison] = summarizeComparison(invalid, benchmarkReport(100));
    expect(invalidComparison).toMatchObject({ status: "skipped", compatible: false });
    expect(invalidComparison.reasons).toContain("Current benchmark has no valid mean generation time.");
    expect(invalidComparison).not.toHaveProperty("improvementPercent");

    baseline.models = [];
    const [missingComparison] = summarizeComparison(benchmarkReport(90), baseline);
    expect(missingComparison).toMatchObject({
      status: "skipped",
      compatible: false,
      reasons: ["The baseline report has no result for this model."],
    });
  });

  it("does not compare legacy reports missing strict fingerprint fields", () => {
    const baseline = benchmarkReport(100);
    delete baseline.runner.benchmarkSchemaVersion;
    delete baseline.runner.host;
    delete baseline.models[0].modelId;
    delete baseline.models[0].modelRevision;

    const [comparison] = summarizeComparison(benchmarkReport(90), baseline);
    expect(comparison.status).toBe("incompatible");
    expect(comparison.baselineFingerprint).toBeNull();
    expect(comparison.reasons).toEqual(expect.arrayContaining([
      "report schema version is missing from the baseline report.",
      "model identifier is missing from the baseline report.",
      "host platform is missing from the baseline report.",
    ]));
    expect(comparison).not.toHaveProperty("improvementPercent");
  });
});
