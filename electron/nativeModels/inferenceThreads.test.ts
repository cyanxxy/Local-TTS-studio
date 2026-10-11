// @vitest-environment node

import { describe, expect, it } from "vitest";
import { selectInferenceThreads } from "./inferenceThreads";

const CAPS = { appleSilicon: 3, other: 8 };

describe("selectInferenceThreads", () => {
  it("applies the model's Apple silicon cap on top of the performance cores", () => {
    expect(selectInferenceThreads(CAPS, { arch: "arm64", parallelism: 10, performanceCores: 6, platform: "darwin" })).toBe(3);
    expect(selectInferenceThreads(CAPS, { arch: "arm64", parallelism: 10, performanceCores: 2, platform: "darwin" })).toBe(2);
    expect(selectInferenceThreads(CAPS, { arch: "arm64", parallelism: 10, performanceCores: null, platform: "darwin" })).toBe(3);
  });

  it("applies the model's cap everywhere else", () => {
    expect(selectInferenceThreads(CAPS, { arch: "x64", parallelism: 16, platform: "darwin" })).toBe(8);
    expect(selectInferenceThreads(CAPS, { parallelism: 5, platform: "linux" })).toBe(5);
  });

  it("reports at least one thread", () => {
    expect(selectInferenceThreads({ appleSilicon: 0, other: 0 }, { parallelism: 4, platform: "win32" })).toBe(1);
  });

  it("reads the machine when nothing is injected", () => {
    const threads = selectInferenceThreads(CAPS);

    expect(Number.isInteger(threads)).toBe(true);
    expect(threads).toBeGreaterThanOrEqual(1);
    expect(threads).toBeLessThanOrEqual(8);
  });
});
