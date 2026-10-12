export const RESULT_PREFIX = "INFERENCE_SPEED_RESULT_JSON:";
export const ERROR_PREFIX = "INFERENCE_SPEED_ERROR_JSON:";
// Mirrors BENCHMARK_MODELS and BENCHMARK_MODEL_SELECTIONS in
// src/eval/inferenceSpeedOptions.ts; vite.inferenceSpeedEval.test.ts keeps them equal.
export const BENCHMARK_MODELS = Object.freeze(["kokoro", "supertonic", "supertonic3"]);
export const BENCHMARK_MODEL_SELECTIONS = Object.freeze([...BENCHMARK_MODELS, "both", "all"]);

/** The runtimes a `--model` selection benchmarks, in run order. */
export function resolveRequestedModels(requestedModel) {
  if (!BENCHMARK_MODEL_SELECTIONS.includes(requestedModel)) {
    throw new Error(`Unsupported requested benchmark model: ${requestedModel}`);
  }
  if (requestedModel === "all") return [...BENCHMARK_MODELS];
  if (requestedModel === "both") return ["kokoro", "supertonic"];
  return [requestedModel];
}

function formatMs(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)}ms` : "n/a";
}

function formatFixed(value, digits) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

/**
 * One CLI line per model result. Values a runtime could not produce (no audio,
 * or a report from before the cold/warm split) print as `n/a`.
 */
export function formatModelSummary(model) {
  if (model.error) return `${model.model}: ERROR ${model.error}`;
  const summary = model.summary ?? {};
  // Reports from before schema 4 recorded only `loadMs`, which was the cold load.
  const coldLoadMs = model.coldLoadMs ?? model.loadMs;
  return [
    `${model.model}: cold load ${formatMs(coldLoadMs)}`,
    `warm load ${formatMs(model.warmLoadMs)}`,
    `first audio ${formatMs(model.firstChunkMs)}`,
    `mean ${formatMs(summary.meanGenerationMs)}`,
    `mean first chunk ${formatMs(summary.meanFirstChunkMs)}`,
    `${formatFixed(summary.meanCharsPerSec, 1)} chars/s`,
    `RTF ${formatFixed(summary.meanRtf, 3)}`,
    `backend ${model.backend ?? "n/a"}`,
  ].join(", ");
}

export function createLineBuffer(handleLine) {
  let buffered = "";

  return {
    push(chunk) {
      buffered += String(chunk);
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        handleLine(line);
      }
    },

    flush() {
      if (!buffered) return;
      const line = buffered;
      buffered = "";
      handleLine(line);
    },
  };
}

export function createElectronOutputParser(writeOutput = () => {}) {
  let result = null;
  let stderr = "";
  let parseError = null;

  const handleLine = (line) => {
    if (line.startsWith(RESULT_PREFIX)) {
      try {
        result = JSON.parse(line.slice(RESULT_PREFIX.length));
      } catch (error) {
        parseError = new Error(
          `Failed to parse Electron benchmark result: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }

    if (line.startsWith(ERROR_PREFIX)) {
      stderr += `${line.slice(ERROR_PREFIX.length)}\n`;
      return;
    }

    if (line.trim()) {
      writeOutput(line);
    }
  };

  const stdoutLines = createLineBuffer(handleLine);
  const stderrLines = createLineBuffer((line) => {
    if (!line) return;
    if (line.startsWith(ERROR_PREFIX)) handleLine(line);
    else stderr += `${line}\n`;
  });

  return {
    pushStdout: (chunk) => stdoutLines.push(chunk),
    pushStderr: (chunk) => stderrLines.push(chunk),
    finish() {
      stdoutLines.flush();
      stderrLines.flush();
      return { result, stderr, parseError };
    },
  };
}

export function getRequestedModelFailures(result, requestedModel) {
  const requested = resolveRequestedModels(requestedModel);
  const failures = [];
  for (const model of requested) {
    const matches = result.models.filter((entry) => entry.model === model);
    if (matches.length !== 1) {
      failures.push({
        model,
        error: matches.length === 0
          ? "The benchmark returned no result for this requested model."
          : "The benchmark returned duplicate results for this requested model.",
      });
      continue;
    }
    const [entry] = matches;
    if (entry.error || !entry.summary || typeof entry.summary !== "object") {
      failures.push(entry.error ? entry : {
        ...entry,
        error: "The benchmark result did not contain a measurement summary.",
      });
    }
  }
  return failures;
}

export function getRequestedModelExitCode(result, requestedModel) {
  return getRequestedModelFailures(result, requestedModel).length > 0 ? 1 : 0;
}
