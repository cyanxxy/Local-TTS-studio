// @vitest-environment node

import { EventEmitter } from "node:events";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Audio8NativeClient,
  type Audio8WorkerFactory,
  type Audio8WorkerRequest,
} from "./audio8NativeClient";

class FakeWorker extends EventEmitter {
  readonly posted: Audio8WorkerRequest[] = [];
  readonly terminate = vi.fn(async () => 0);
  readonly unref = vi.fn();

  postMessage(message: Audio8WorkerRequest): void {
    this.posted.push(message);
  }

  send(message: unknown): void {
    this.emit("message", message);
  }

  fail(error: Error): void {
    this.emit("error", error);
  }

  exit(code: number): void {
    this.emit("exit", code);
  }
}

function harness(inactivityTimeoutMs = 300_000) {
  const workers: FakeWorker[] = [];
  const factory = vi.fn(((workerPath, options) => {
    expect(workerPath).toBe(path.join(__dirname, "audio8NativeWorker.js"));
    expect(options.workerData).toEqual({ modelDir: "/cache/audio8/revision" });
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }) satisfies Audio8WorkerFactory);
  const client = new Audio8NativeClient("/cache/audio8/revision", factory, inactivityTimeoutMs);
  return { client, factory, workers };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Audio8NativeClient", () => {
  it("starts one unreferenced worker and resolves the load result", async () => {
    const { client, factory, workers } = harness();
    const load = client.load("load-1", () => {});

    expect(factory).toHaveBeenCalledTimes(1);
    expect(workers[0].unref).toHaveBeenCalledTimes(1);
    expect(workers[0].posted).toEqual([{ type: "load", requestId: "load-1" }]);
    workers[0].send({ type: "result", requestId: "load-1", result: { ready: true, sampleRate: 44100 } });

    await expect(load).resolves.toEqual({ ready: true, sampleRate: 44100 });
  });

  it("hands synthesis results back with their transferred audio", async () => {
    const { client, workers } = harness();
    const audio = new Float32Array([0.25, -0.5]).buffer;
    const generate = client.generate("gen-1", "Hello there", "iris");

    expect(workers[0].posted).toEqual([
      { type: "generate", requestId: "gen-1", text: "Hello there", voice: "iris" },
    ]);
    workers[0].send({ type: "result", requestId: "gen-1", result: { sampleRate: 44100, elapsedSec: 1.5, audio } });

    await expect(generate).resolves.toEqual({ sampleRate: 44100, elapsedSec: 1.5, audio });
  });

  it("routes progress to the request that caused it", async () => {
    const { client, workers } = harness();
    const first: number[] = [];
    const second: number[] = [];
    const firstLoad = client.load("load-1", (percent) => first.push(percent));
    const secondLoad = client.load("load-2", (percent) => second.push(percent));

    workers[0].send({ type: "progress", requestId: "load-1", percent: 12 });
    workers[0].send({ type: "progress", requestId: "load-2", percent: 34 });
    // A generation reports token progress under its own id; no load is listening.
    workers[0].send({ type: "progress", requestId: "gen-1", percent: 99 });
    workers[0].send({ type: "result", requestId: "load-1", result: { ready: true, sampleRate: 44100 } });
    workers[0].send({ type: "result", requestId: "load-2", result: { ready: true, sampleRate: 44100 } });

    await Promise.all([firstLoad, secondLoad]);
    expect(first).toEqual([12]);
    expect(second).toEqual([34]);
  });

  it("routes generation progress without fanning it out to loads", async () => {
    const { client, workers } = harness();
    const loadProgress: number[] = [];
    const generationProgress: number[] = [];
    const load = client.load("load-1", (percent) => loadProgress.push(percent));
    const generated = client.generate("gen-1", "Hello", "clara", (percent) => generationProgress.push(percent));

    workers[0].send({ type: "progress", requestId: "gen-1", percent: 25 });
    workers[0].send({ type: "result", requestId: "load-1", result: { ready: true, sampleRate: 44100 } });
    workers[0].send({ type: "result", requestId: "gen-1", result: { sampleRate: 44100, audio: new ArrayBuffer(4) } });
    await Promise.all([load, generated]);

    expect(generationProgress).toEqual([25]);
    expect(loadProgress).toEqual([]);
  });

  it("stops reporting progress once its request has settled", async () => {
    const { client, workers } = harness();
    const seen: number[] = [];
    const load = client.load("load-1", (percent) => seen.push(percent));

    workers[0].send({ type: "result", requestId: "load-1", result: { ready: true, sampleRate: 44100 } });
    await load;
    workers[0].send({ type: "progress", requestId: "load-1", percent: 50 });

    expect(seen).toEqual([]);
  });

  it("rejects with the worker's own error text", async () => {
    const { client, workers } = harness();
    const load = client.load("load-1", () => {});

    workers[0].send({ type: "error", requestId: "load-1", error: "Audio8 slow_ar_int4.onnx failed integrity verification." });

    await expect(load).rejects.toThrow("Audio8 slow_ar_int4.onnx failed integrity verification.");
  });

  it("ignores malformed messages and answers for unknown requests", async () => {
    const { client, workers } = harness();
    const load = client.load("load-1", () => {});

    workers[0].send(null);
    workers[0].send({ type: "result" });
    workers[0].send({ type: "result", requestId: "load-1", result: { sampleRate: "nope" } });
    workers[0].send({ type: "surprise", requestId: "load-1" });
    workers[0].send({ type: "result", requestId: "other", result: { sampleRate: 44100 } });
    workers[0].send({ type: "result", requestId: "load-1", result: { ready: true, sampleRate: 44100 } });

    await expect(load).resolves.toEqual({ ready: true, sampleRate: 44100 });
  });

  it("rejects a request id that is already in flight", async () => {
    const { client, workers } = harness();
    const load = client.load("load-1", () => {});

    await expect(client.load("load-1", () => {})).rejects.toThrow(
      "Audio8 request load-1 is already in flight.",
    );
    workers[0].send({ type: "result", requestId: "load-1", result: { ready: true, sampleRate: 44100 } });
    await load;
  });

  it("fails in-flight work when the worker crashes and starts a fresh one on retry", async () => {
    const { client, factory, workers } = harness();
    const load = client.load("load-1", () => {});

    workers[0].fail(new Error("worker heap out of memory"));
    // "exit" always trails "error"; it must not double-report.
    workers[0].exit(1);

    await expect(load).rejects.toThrow("worker heap out of memory");

    const retry = client.load("load-2", () => {});
    expect(factory).toHaveBeenCalledTimes(2);
    workers[1].send({ type: "result", requestId: "load-2", result: { ready: true, sampleRate: 44100 } });
    await expect(retry).resolves.toEqual({ ready: true, sampleRate: 44100 });
  });

  it("fails in-flight work when the worker exits on its own", async () => {
    const { client, workers } = harness();
    const load = client.load("load-1", () => {});

    workers[0].exit(3);

    await expect(load).rejects.toThrow("Audio8 native worker exited with code 3.");
  });

  it("forwards cancellation to the worker and reports that it landed", async () => {
    const { client, workers } = harness();
    const generate = client.generate("gen-1", "Hello", "clara");

    expect(client.cancel("gen-1")).toBe(true);
    expect(workers[0].posted.at(-1)).toEqual({ type: "cancel", requestId: "gen-1" });

    workers[0].send({ type: "error", requestId: "gen-1", error: "Audio8 synthesis cancelled." });
    await expect(generate).rejects.toThrow("Audio8 synthesis cancelled.");
  });

  it("reports that there was nothing to cancel", async () => {
    const { client, factory, workers } = harness();

    // Never started.
    expect(client.cancel("gen-1")).toBe(false);
    expect(factory).not.toHaveBeenCalled();

    // Already settled: the stop arrived as the last chunk finished.
    const generate = client.generate("gen-1", "Hello", "clara");
    workers[0].send({ type: "result", requestId: "gen-1", result: { sampleRate: 44100 } });
    await generate;
    expect(client.cancel("gen-1")).toBe(false);

    // Worker gone.
    const second = client.generate("gen-2", "Hello", "clara");
    workers[0].exit(1);
    await expect(second).rejects.toThrow("exited with code 1");
    expect(client.cancel("gen-2")).toBe(false);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("keeps waiting while the worker reports progress and gives up when it goes silent", async () => {
    vi.useFakeTimers();
    const { client, workers } = harness(300_000);
    const load = client.load("load-1", () => {});

    await vi.advanceTimersByTimeAsync(200_000);
    workers[0].send({ type: "progress", requestId: "load-1", percent: 40 });
    await vi.advanceTimersByTimeAsync(200_000);
    expect(workers[0].terminate).not.toHaveBeenCalled();

    const rejection = expect(load).rejects.toThrow("Audio8 native worker stopped responding after 300s.");
    await vi.advanceTimersByTimeAsync(300_000);

    await rejection;
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  it("replaces a wedged worker so the next request is not stuck behind it", async () => {
    vi.useFakeTimers();
    const { client, factory, workers } = harness(1_000);
    const load = client.load("load-1", () => {});
    const generate = client.generate("gen-1", "Hello", "clara");
    const rejections = Promise.all([
      expect(load).rejects.toThrow("stopped responding"),
      expect(generate).rejects.toThrow("stopped responding"),
    ]);

    await vi.advanceTimersByTimeAsync(1_000);

    await rejections;

    const retry = client.load("load-2", () => {});
    expect(factory).toHaveBeenCalledTimes(2);
    workers[1].send({ type: "result", requestId: "load-2", result: { ready: true, sampleRate: 44100 } });
    await expect(retry).resolves.toEqual({ ready: true, sampleRate: 44100 });
  });

  it("terminates the worker on shutdown and refuses later requests", async () => {
    const { client, factory, workers } = harness();
    const load = client.load("load-1", () => {});
    const rejection = expect(load).rejects.toThrow("Audio8 native worker stopped.");

    const destroyed = client.destroy();
    // Pending work is rejected before the terminate is awaited, so a caller
    // racing the teardown never waits on a thread that is going away.
    await rejection;
    await destroyed;

    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    await expect(client.generate("gen-1", "Hello", "clara")).rejects.toThrow(
      "Audio8 native worker is shutting down.",
    );
    // Contract for main.ts's clear-cache: a request after destroy() must never
    // resurrect a worker that would re-map the graphs under the rm.
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("rejects the request when the worker cannot be started at all", async () => {
    const client = new Audio8NativeClient("/cache/audio8/revision", () => {
      throw new Error("Cannot find module 'audio8NativeWorker.js'");
    });

    await expect(client.load("load-1", () => {})).rejects.toThrow("Cannot find module");
  });
});
