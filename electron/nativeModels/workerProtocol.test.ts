// @vitest-environment node

import path from "node:path";
import { describe, expect, it } from "vitest";
import { isRecord, parseNativeModelWorkerResponse, readWorkerModelDir } from "./workerProtocol";

const hasSampleRate = (result: Record<string, unknown>) => typeof result.sampleRate === "number";

describe("parseNativeModelWorkerResponse", () => {
  it("narrows progress, results the model recognises, and errors", () => {
    expect(parseNativeModelWorkerResponse({ type: "progress", requestId: "a", percent: 5 }, hasSampleRate, "failed"))
      .toEqual({ type: "progress", requestId: "a", percent: 5 });
    expect(parseNativeModelWorkerResponse({ type: "result", requestId: "a", result: { sampleRate: 1 } }, hasSampleRate, "failed"))
      .toEqual({ type: "result", requestId: "a", result: { sampleRate: 1 } });
    expect(parseNativeModelWorkerResponse({ type: "error", requestId: "a", error: "boom" }, hasSampleRate, "failed"))
      .toEqual({ type: "error", requestId: "a", error: "boom" });
  });

  it("substitutes the fallback for an error without text", () => {
    expect(parseNativeModelWorkerResponse({ type: "error", requestId: "a", error: "" }, hasSampleRate, "failed"))
      .toEqual({ type: "error", requestId: "a", error: "failed" });
    expect(parseNativeModelWorkerResponse({ type: "error", requestId: "a", error: 3 }, hasSampleRate, "failed"))
      .toEqual({ type: "error", requestId: "a", error: "failed" });
  });

  it("drops anything else", () => {
    for (const value of [
      null,
      [],
      { type: "result" },
      { type: "progress", requestId: "a", percent: "5" },
      { type: "result", requestId: "a", result: { sampleRate: "1" } },
      { type: "result", requestId: "a", result: [1] },
      { type: "surprise", requestId: "a" },
    ]) {
      expect(parseNativeModelWorkerResponse(value, hasSampleRate, "failed")).toBeNull();
    }
  });
});

describe("readWorkerModelDir", () => {
  it("resolves the model directory a worker was started with", () => {
    expect(readWorkerModelDir({ modelDir: "relative/revision" })).toBe(path.resolve("relative/revision"));
  });

  it("is null when the module was imported rather than started as a worker", () => {
    expect(readWorkerModelDir(null)).toBeNull();
    expect(readWorkerModelDir({ modelDir: 4 })).toBeNull();
  });
});

describe("isRecord", () => {
  it("accepts plain objects only", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("text")).toBe(false);
  });
});
