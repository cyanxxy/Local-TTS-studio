export const RESULT_PREFIX = "INFERENCE_SPEED_RESULT_JSON:";
export const ERROR_PREFIX = "INFERENCE_SPEED_ERROR_JSON:";
const BENCHMARK_MODELS = new Set(["both", "kokoro", "supertonic"]);

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
  if (!BENCHMARK_MODELS.has(requestedModel)) {
    throw new Error(`Unsupported requested benchmark model: ${requestedModel}`);
  }
  const requested = requestedModel === "both" ? ["kokoro", "supertonic"] : [requestedModel];
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
