import { describe, expect, it } from "vitest";
import { parseInferenceSpeedOptions } from "./inferenceSpeedOptions";

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
});
