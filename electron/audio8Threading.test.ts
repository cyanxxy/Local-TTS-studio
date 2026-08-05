import { describe, expect, it } from "vitest";
import { selectAudio8InferenceThreads } from "./audio8Threading";

describe("selectAudio8InferenceThreads", () => {
  it.each([
    ["base M-series", 8, 4, 4],
    ["M-series Pro", 10, 6, 4],
    ["M-series Max", 16, 12, 4],
  ])("uses the %s performance cores", (_name, parallelism, performanceCores, expected) => {
    expect(selectAudio8InferenceThreads({
      arch: "arm64",
      parallelism,
      performanceCores,
      platform: "darwin",
    })).toBe(expected);
  });

  it("uses a bounded fallback when performance-core discovery is unavailable", () => {
    expect(selectAudio8InferenceThreads({
      arch: "arm64",
      parallelism: 8,
      performanceCores: null,
      platform: "darwin",
    })).toBe(4);
  });

  it("never reports more threads than the machine has", () => {
    expect(selectAudio8InferenceThreads({ parallelism: 4, platform: "win32" })).toBe(4);
    expect(selectAudio8InferenceThreads({
      arch: "arm64",
      parallelism: 2,
      performanceCores: 8,
      platform: "darwin",
    })).toBe(2);
  });

  it("reports at least one thread on an implausible machine", () => {
    expect(selectAudio8InferenceThreads({ parallelism: 0 })).toBe(1);
  });
});
