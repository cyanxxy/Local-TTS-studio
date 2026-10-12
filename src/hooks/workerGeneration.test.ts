import { afterEach, describe, expect, it, vi } from "vitest";
import type { SynthesisChunk } from "../shared/engineRuntime";
import type { WorkerInMessage, WorkerOutMessage } from "../types";
import {
  WORKER_ABORT_TIMEOUT_MS,
  abortWorkerGeneration,
  observeWorkerGeneration,
  streamWorkerGeneration,
  workerEventMessage,
  workerGenerateRequest,
} from "./workerGeneration";

/** A worker that records its listeners, so tests can check none leak. */
class ListenerWorker extends EventTarget {
  posted: WorkerInMessage[] = [];
  listeners = 0;

  postMessage(message: WorkerInMessage) {
    this.posted.push(message);
  }

  override addEventListener(...args: Parameters<EventTarget["addEventListener"]>) {
    this.listeners += 1;
    super.addEventListener(...args);
  }

  override removeEventListener(...args: Parameters<EventTarget["removeEventListener"]>) {
    this.listeners -= 1;
    super.removeEventListener(...args);
  }

  emit(message: WorkerOutMessage) {
    this.dispatchEvent(new MessageEvent("message", { data: message }));
  }
}

const REQUEST = workerGenerateRequest("Hello there, listener.", "af_heart", { speed: 1.1, quality: 4, language: "en" });

function chunk(generationId: string, index: number): WorkerOutMessage {
  return {
    type: "AUDIO_CHUNK",
    generationId,
    audio: new Float32Array([index]),
    samplingRate: 24_000,
    text: `passage ${index}`,
    index,
    total: 2,
    textStart: index * 10,
    textEnd: index * 10 + 9,
    pauseAfterSec: 0.1,
    pauseKind: "sentence",
  };
}

async function collect(iterable: AsyncIterable<SynthesisChunk>): Promise<SynthesisChunk[]> {
  const values: SynthesisChunk[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe("workerGenerateRequest", () => {
  it("carries every Creator tuning field the workers read", () => {
    expect(workerGenerateRequest("Text", "M1", {
      speed: 0.9,
      quality: 7,
      language: "ko",
      pauseOverridesSec: { comma: 0.1 },
      sentenceSpeedVariance: 0.2,
      pronunciationRules: [{ from: "TTS", to: "tee tee ess" }],
      emphasisStrength: 0.5,
    })).toEqual({
      text: "Text",
      voice: "M1",
      language: "ko",
      speed: 0.9,
      quality: 7,
      pauseOverridesSec: { comma: 0.1 },
      sentenceSpeedVariance: 0.2,
      pronunciationRules: [{ from: "TTS", to: "tee tee ess" }],
      emphasisStrength: 0.5,
    });
  });
});

describe("workerEventMessage", () => {
  it("prefers the crash message and explains unreadable messages", () => {
    expect(workerEventMessage(new ErrorEvent("error", { message: "boom" }), "Failed.")).toBe("boom");
    expect(workerEventMessage(new Event("error"), "Failed.")).toBe("Failed.");
    expect(workerEventMessage(new Event("messageerror"), "Failed.")).toBe("Failed. The worker sent an unreadable message.");
  });
});

describe("observeWorkerGeneration", () => {
  it("posts one GENERATE and routes only its own replies", () => {
    const worker = new ListenerWorker();
    const observer = { onChunk: vi.fn(), onComplete: vi.fn(), onError: vi.fn() };

    observeWorkerGeneration(worker as unknown as Worker, "mine", REQUEST, observer, "Failed.");
    expect(worker.posted).toEqual([{ type: "GENERATE", generationId: "mine", ...REQUEST }]);

    worker.emit(chunk("theirs", 1));
    worker.emit({ type: "GENERATION_COMPLETE", generationId: "theirs" });
    expect(observer.onChunk).not.toHaveBeenCalled();
    expect(observer.onComplete).not.toHaveBeenCalled();

    worker.emit(chunk("mine", 1));
    worker.emit({ type: "LOAD_PROGRESS", percent: 50 });
    worker.emit({ type: "GENERATION_COMPLETE", generationId: "mine" });
    expect(observer.onChunk).toHaveBeenCalledOnce();
    expect(observer.onComplete).toHaveBeenCalledOnce();
    expect(worker.listeners).toBe(0);
  });

  it("reports generation errors, crashes and refused messages once, detached", () => {
    const failing = new ListenerWorker();
    const onError = vi.fn();
    observeWorkerGeneration(failing as unknown as Worker, "id", REQUEST, { onChunk: vi.fn(), onComplete: vi.fn(), onError }, "Failed.");
    failing.emit({ type: "ERROR", message: "Chunk failed", scope: "generate", generationId: "id" });
    failing.emit({ type: "ERROR", message: "again", generationId: "id" });
    expect(onError).toHaveBeenCalledExactlyOnceWith("Chunk failed");
    expect(failing.listeners).toBe(0);

    const crashing = new ListenerWorker();
    const onCrash = vi.fn();
    observeWorkerGeneration(crashing as unknown as Worker, "id", REQUEST, { onChunk: vi.fn(), onComplete: vi.fn(), onError: onCrash }, "Failed.");
    crashing.dispatchEvent(new Event("messageerror"));
    expect(onCrash).toHaveBeenCalledExactlyOnceWith("Failed. The worker sent an unreadable message.");
    expect(crashing.listeners).toBe(0);

    const refusing = new ListenerWorker();
    refusing.postMessage = () => {
      throw new Error("Could not clone.");
    };
    const onRefused = vi.fn();
    observeWorkerGeneration(refusing as unknown as Worker, "id", REQUEST, { onChunk: vi.fn(), onComplete: vi.fn(), onError: onRefused }, "Failed.");
    expect(onRefused).toHaveBeenCalledExactlyOnceWith("Could not clone.");
    expect(refusing.listeners).toBe(0);
  });

  it("stops listening on detach", () => {
    const worker = new ListenerWorker();
    const observer = { onChunk: vi.fn(), onComplete: vi.fn(), onError: vi.fn() };
    const detach = observeWorkerGeneration(worker as unknown as Worker, "id", REQUEST, observer, "Failed.");

    detach();
    detach();
    worker.emit(chunk("id", 1));
    expect(observer.onChunk).not.toHaveBeenCalled();
    expect(worker.listeners).toBe(0);
  });
});

describe("streamWorkerGeneration", () => {
  function stream(worker: ListenerWorker, overrides: Partial<Parameters<typeof streamWorkerGeneration>[0]> = {}) {
    const onUnresponsive = vi.fn();
    const controller = new AbortController();
    const lifetime = new AbortController();
    const iterable = streamWorkerGeneration({
      worker: worker as unknown as Worker,
      generationId: "request-1",
      request: REQUEST,
      signal: controller.signal,
      lifetime: lifetime.signal,
      onUnresponsive,
      failureMessage: "Kokoro worker failed.",
      stoppedMessage: "Kokoro stopped before the request finished.",
      ...overrides,
    });
    return { iterable, onUnresponsive, controller, lifetime };
  }

  it("yields each chunk as the player would schedule it and ends on completion", async () => {
    const worker = new ListenerWorker();
    const { iterable, onUnresponsive } = stream(worker);
    const result = collect(iterable);

    worker.emit(chunk("request-1", 1));
    worker.emit(chunk("request-1", 2));
    worker.emit({ type: "GENERATION_COMPLETE", generationId: "request-1" });

    const chunks = await result;
    expect(chunks.map((entry) => entry.text)).toEqual(["passage 1", "passage 2"]);
    expect(chunks[0]).toEqual({
      audio: new Float32Array([1]),
      samplingRate: 24_000,
      text: "passage 1",
      index: 1,
      total: 2,
      textStart: 10,
      textEnd: 19,
      pauseAfterSec: 0.1,
      pauseKind: "sentence",
    });
    expect(onUnresponsive).not.toHaveBeenCalled();
    expect(worker.posted.map((message) => message.type)).toEqual(["GENERATE"]);
    expect(worker.listeners).toBe(0);
  });

  it("rejects with the worker's error", async () => {
    const worker = new ListenerWorker();
    const { iterable } = stream(worker);
    const result = collect(iterable);

    worker.emit({ type: "ERROR", message: "Voice missing", scope: "generate", generationId: "request-1" });

    await expect(result).rejects.toThrow("Voice missing");
    expect(worker.listeners).toBe(0);
  });

  it("aborts the generation softly and rejects with the signal's reason when aborted", async () => {
    const worker = new ListenerWorker();
    const { iterable, onUnresponsive, controller } = stream(worker);
    const result = collect(iterable);
    worker.emit(chunk("request-1", 1));

    controller.abort(new Error("Preview closed."));

    await expect(result).rejects.toThrow("Preview closed.");
    expect(worker.posted.at(-1)).toEqual({ type: "ABORT", generationId: "request-1" });
    expect(worker.posted.some((message) => message.type === "CANCEL")).toBe(false);
    worker.emit({ type: "ABORTED", generationId: "request-1" });
    expect(onUnresponsive).not.toHaveBeenCalled();
    expect(worker.listeners).toBe(0);
  });

  it("aborts softly when the reader breaks off early", async () => {
    const worker = new ListenerWorker();
    const { iterable, onUnresponsive } = stream(worker);
    worker.emit(chunk("request-1", 1));

    for await (const entry of iterable) {
      expect(entry.index).toBe(1);
      break;
    }

    expect(worker.posted.at(-1)).toEqual({ type: "ABORT", generationId: "request-1" });
    worker.emit({ type: "ABORTED", generationId: "request-1" });
    expect(onUnresponsive).not.toHaveBeenCalled();
    expect(worker.listeners).toBe(0);
  });

  it("fails without stopping anything when the pool retires the worker", async () => {
    const worker = new ListenerWorker();
    const { iterable, onUnresponsive, lifetime } = stream(worker);
    const result = collect(iterable);

    lifetime.abort();

    await expect(result).rejects.toThrow("Kokoro stopped before the request finished.");
    expect(onUnresponsive).not.toHaveBeenCalled();
    expect(worker.posted.map((message) => message.type)).toEqual(["GENERATE"]);
    expect(worker.listeners).toBe(0);
  });

  it("posts nothing when the request or the worker is already gone", async () => {
    const aborted = new AbortController();
    aborted.abort(new Error("Too late."));
    const worker = new ListenerWorker();
    await expect(collect(stream(worker, { signal: aborted.signal }).iterable)).rejects.toThrow("Too late.");

    const retired = new AbortController();
    retired.abort();
    await expect(collect(stream(worker, { lifetime: retired.signal }).iterable))
      .rejects.toThrow("Kokoro stopped before the request finished.");
    expect(worker.posted).toEqual([]);
    expect(worker.listeners).toBe(0);
  });
});

describe("abortWorkerGeneration", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("posts one ABORT and stops watching once the generation's ABORTED arrives", () => {
    vi.useFakeTimers();
    const worker = new ListenerWorker();
    const onUnresponsive = vi.fn();
    abortWorkerGeneration(worker as unknown as Worker, "gen-1", onUnresponsive);

    expect(worker.posted).toEqual([{ type: "ABORT", generationId: "gen-1" }]);
    // Another generation's answer is not ours.
    worker.emit({ type: "ABORTED", generationId: "gen-0" });
    expect(worker.listeners).toBe(3);
    worker.emit({ type: "ABORTED", generationId: "gen-1" });
    expect(worker.listeners).toBe(0);
    vi.advanceTimersByTime(WORKER_ABORT_TIMEOUT_MS * 2);
    expect(onUnresponsive).not.toHaveBeenCalled();
  });

  it("reports a worker that never answers, once", () => {
    vi.useFakeTimers();
    const worker = new ListenerWorker();
    const onUnresponsive = vi.fn();
    abortWorkerGeneration(worker as unknown as Worker, "gen-1", onUnresponsive);

    vi.advanceTimersByTime(WORKER_ABORT_TIMEOUT_MS - 1);
    expect(onUnresponsive).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onUnresponsive).toHaveBeenCalledOnce();
    expect(worker.listeners).toBe(0);
    worker.emit({ type: "ABORTED", generationId: "gen-1" });
    expect(onUnresponsive).toHaveBeenCalledOnce();
  });

  it("leaves a worker that crashed meanwhile to its owner", () => {
    vi.useFakeTimers();
    const worker = new ListenerWorker();
    const onUnresponsive = vi.fn();
    abortWorkerGeneration(worker as unknown as Worker, "gen-1", onUnresponsive);

    worker.dispatchEvent(new Event("error"));
    vi.advanceTimersByTime(WORKER_ABORT_TIMEOUT_MS * 2);
    expect(onUnresponsive).not.toHaveBeenCalled();
    expect(worker.listeners).toBe(0);
  });

  it("reports a worker that refuses the message at once", () => {
    const worker = new ListenerWorker();
    worker.postMessage = () => {
      throw new Error("closed");
    };
    const onUnresponsive = vi.fn();
    abortWorkerGeneration(worker as unknown as Worker, "gen-1", onUnresponsive);

    expect(onUnresponsive).toHaveBeenCalledOnce();
    expect(worker.listeners).toBe(0);
  });
});
