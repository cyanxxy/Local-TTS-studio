import { describe, expect, it } from "vitest";
import { createLoadProgress } from "./progress";

function collect() {
  const reports: number[] = [];
  return { report: (percent: number) => reports.push(percent), reports };
}

describe("createLoadProgress", () => {
  it("weights pinned files by their exact byte sizes from the start", () => {
    const { report, reports } = collect();
    const progress = createLoadProgress({ report, expectedBytes: { "config.json": 100, "model.onnx": 900 } });

    progress.complete("config.json");
    progress.update("model.onnx", 450);
    progress.complete("model.onnx");

    // A per-file average would have read 50% as soon as the tiny config finished.
    expect(reports).toEqual([10, 55, 100]);
  });

  it("counts unlisted files with the totals they report and never moves backwards", () => {
    const { report, reports } = collect();
    const progress = createLoadProgress({ report });

    progress.update("a.bin", 50, 100);
    progress.update("b.bin", 0, 300);
    progress.update("b.bin", 300);
    progress.complete("a.bin");

    // b.bin announcing its size drops the true fraction to 12.5%; that is not reported.
    expect(reports).toEqual([50, 87.5, 100]);
  });

  it("weighs a file of unknown size only once it completes", () => {
    const { report, reports } = collect();
    const progress = createLoadProgress({ report, expectedBytes: { "model.onnx": 100 } });

    progress.update("streamed.json", 100);
    progress.update("model.onnx", 50);
    progress.complete("streamed.json");
    progress.complete("model.onnx");

    expect(reports).toEqual([50, 75, 100]);
  });

  it("maps progress into the configured range and clamps overshooting byte counts", () => {
    const { report, reports } = collect();
    const progress = createLoadProgress({ report, range: [0, 94], expectedBytes: { "model.onnx": 200 } });

    progress.update("model.onnx", 100);
    progress.update("model.onnx", 10_000);

    expect(reports).toEqual([47, 94]);
  });

  it("follows Transformers.js events, preferring byte-weighted progress_total once seen", () => {
    const { report, reports } = collect();
    const progress = createLoadProgress({ report, range: [0, 84] });

    progress.handleTransformersEvent({ status: "initiate", file: "onnx/model.onnx" });
    progress.handleTransformersEvent({ status: "progress", file: "onnx/model.onnx", loaded: 5, total: 10 });
    progress.handleTransformersEvent({ status: "progress_total", progress: 75, loaded: 75, total: 100 });
    progress.handleTransformersEvent({ status: "progress", file: "onnx/model.onnx", loaded: 9, total: 10 });
    progress.handleTransformersEvent({ status: "done", file: "config.json" });
    progress.handleTransformersEvent(null);
    progress.handleTransformersEvent("progress");

    expect(reports).toEqual([42, 63]);
  });

  it("counts per-file Transformers.js done events and ignores events without a file", () => {
    const { report, reports } = collect();
    const progress = createLoadProgress({ report });

    progress.handleTransformersEvent({ status: "progress", loaded: 5, total: 10 });
    progress.handleTransformersEvent({ status: "progress", file: "model.onnx", loaded: 5, total: 10 });
    progress.handleTransformersEvent({ status: "done", file: "model.onnx" });

    expect(reports).toEqual([50, 100]);
  });

  it("starts over on reset and reports the start of the range", () => {
    const { report, reports } = collect();
    const progress = createLoadProgress({ report, range: [10, 90], expectedBytes: { "model.onnx": 100 } });

    progress.update("model.onnx", 100);
    progress.reset();
    progress.update("model.onnx", 50);

    expect(reports).toEqual([90, 10, 50]);
  });

  it("reports nothing once closed, even when abandoned downloads keep going", () => {
    const { report, reports } = collect();
    const progress = createLoadProgress({ report, expectedBytes: { "model.onnx": 100 } });

    progress.update("model.onnx", 40);
    progress.close();
    progress.update("model.onnx", 80);
    progress.complete("model.onnx");
    progress.handleTransformersEvent({ status: "progress_total", progress: 90 });
    progress.reset();

    expect(reports).toEqual([40]);
  });
});
