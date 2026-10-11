// @vitest-environment node

import { describe, expect, it } from "vitest";
import * as ort from "onnxruntime-node";
import { createCpuSessionOptions, initialiseOrtFloat16Compatibility, prepareOrtNodeWorker } from "./ortNode";

describe("ORT Node worker set-up", () => {
  it("keeps FP16 tensors on Uint16Array and leaves the global as it found it", () => {
    const before = Object.getOwnPropertyDescriptor(globalThis, "Float16Array");

    prepareOrtNodeWorker("Kitten");
    // Idempotent: a second worker module in the same thread changes nothing.
    prepareOrtNodeWorker("Kitten");
    const tensor = new ort.Tensor("float16", new Uint16Array(4), [4]);

    expect(tensor.data).toBeInstanceOf(Uint16Array);
    expect(Object.getOwnPropertyDescriptor(globalThis, "Float16Array")).toEqual(before);
    expect(ort.env.logLevel).toBe("error");
  });

  it("does nothing where the runtime has no Float16Array", () => {
    const scope = {};

    expect(() => initialiseOrtFloat16Compatibility("Kitten", scope)).not.toThrow();
    expect(scope).toEqual({});
  });

  it("refuses to run with a Float16Array it cannot hide, naming the model", () => {
    const scope = {};
    Object.defineProperty(scope, "Float16Array", { value: class Float16Array {}, configurable: false });

    expect(() => initialiseOrtFloat16Compatibility("Kitten", scope))
      .toThrow("Kitten cannot initialise ONNX Runtime FP16 compatibility.");
  });

  it("puts a hidden Float16Array back once the probe has run", () => {
    const original = class Float16Array {};
    const scope = { Float16Array: original };

    initialiseOrtFloat16Compatibility("Kitten", scope);

    expect(scope.Float16Array).toBe(original);
  });

  it("builds CPU session options around the requested thread count", () => {
    expect(createCpuSessionOptions(3)).toEqual({
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
      intraOpNumThreads: 3,
      interOpNumThreads: 2,
    });
  });
});
