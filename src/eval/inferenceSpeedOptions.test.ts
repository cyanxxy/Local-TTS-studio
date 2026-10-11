import { describe, expect, it } from "vitest";
import {
  BENCHMARK_MODEL_SELECTIONS,
  BENCHMARK_MODELS,
  isBenchmarkModelSelection,
  parseInferenceSpeedOptions,
  resolveBenchmarkModels,
} from "./inferenceSpeedOptions";

describe("parseInferenceSpeedOptions", () => {
  it("accepts zero warmup iterations", () => {
    expect(parseInferenceSpeedOptions("?model=kokoro&iterations=2&warmups=0")).toMatchObject({
      model: "kokoro",
      iterations: 2,
      warmups: 0,
    });
  });

  it("keeps the default warmup for missing, negative, or non-numeric values", () => {
    expect(parseInferenceSpeedOptions("").warmups).toBe(1);
    expect(parseInferenceSpeedOptions("?warmups=-1").warmups).toBe(1);
    expect(parseInferenceSpeedOptions("?warmups=invalid").warmups).toBe(1);
  });

  it("defaults to Kokoro and Supertonic 2 when no model is given", () => {
    expect(parseInferenceSpeedOptions("").model).toBe("both");
    expect(parseInferenceSpeedOptions("?iterations=2").model).toBe("both");
  });

  it.each(BENCHMARK_MODEL_SELECTIONS)("accepts model=%s", (model) => {
    expect(parseInferenceSpeedOptions(`?model=${model}`).model).toBe(model);
  });

  it.each(["", "Kokoro", "supertonic2", "supertonic-3", "audio8", "both,all"])(
    "rejects model=%j instead of benchmarking a different set",
    (model) => {
      expect(() => parseInferenceSpeedOptions(`?model=${encodeURIComponent(model)}`))
        .toThrow("model must be one of: kokoro, supertonic, supertonic3, both, all.");
    },
  );
});

describe("isBenchmarkModelSelection", () => {
  it("recognizes only the documented selections", () => {
    expect(BENCHMARK_MODEL_SELECTIONS.every(isBenchmarkModelSelection)).toBe(true);
    expect(isBenchmarkModelSelection("audio8")).toBe(false);
    expect(isBenchmarkModelSelection("ALL")).toBe(false);
  });
});

describe("resolveBenchmarkModels", () => {
  it("benchmarks a single runtime on its own", () => {
    expect(resolveBenchmarkModels("kokoro")).toEqual(["kokoro"]);
    expect(resolveBenchmarkModels("supertonic")).toEqual(["supertonic"]);
    expect(resolveBenchmarkModels("supertonic3")).toEqual(["supertonic3"]);
  });

  it("keeps both as Kokoro and Supertonic 2 for older scripts and reports", () => {
    expect(resolveBenchmarkModels("both")).toEqual(["kokoro", "supertonic"]);
  });

  it("expands all to every browser runtime in run order", () => {
    expect(resolveBenchmarkModels("all")).toEqual(["kokoro", "supertonic", "supertonic3"]);
    expect(resolveBenchmarkModels("all")).toEqual([...BENCHMARK_MODELS]);
  });

  it("returns a fresh list each call", () => {
    const models = resolveBenchmarkModels("all");
    models.pop();
    expect(resolveBenchmarkModels("all")).toHaveLength(BENCHMARK_MODELS.length);
  });
});
