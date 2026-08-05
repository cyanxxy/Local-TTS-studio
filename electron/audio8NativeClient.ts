/**
 * Main-process half of the Audio8 native runtime.
 *
 * Owns the single inference worker, routes request/response pairs by id, and
 * keeps the renderer's promises honest: a worker that dies, is terminated, or
 * stops answering must reject the requests waiting on it rather than leave the
 * model panel spinning at "loading" forever.
 */

import path from "path";
import { Worker } from "worker_threads";

export interface Audio8NativeResult {
  ready?: boolean;
  sampleRate: number;
  elapsedSec?: number;
  audio?: ArrayBuffer;
}

export type Audio8WorkerRequest =
  | { type: "load"; requestId: string }
  | { type: "generate"; requestId: string; text: string; voice: string }
  | { type: "cancel"; requestId: string };

export type Audio8WorkerResponse =
  | { type: "progress"; requestId: string; percent: number }
  | { type: "result"; requestId: string; result: Audio8NativeResult }
  | { type: "error"; requestId: string; error: string };

export interface Audio8WorkerLike {
  on(event: "message", listener: (message: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  postMessage(message: Audio8WorkerRequest): void;
  terminate(): Promise<number>;
  unref(): void;
}

export type Audio8WorkerFactory = (
  workerPath: string,
  options: { workerData: { modelDir: string } },
) => Audio8WorkerLike;

/**
 * How long a request may go without any word from the worker. Loads report
 * download percentages and generations report token percentages, so silence
 * this long means the worker is wedged rather than busy — a generation that
 * legitimately runs for minutes keeps ticking and is never cut off.
 */
export const AUDIO8_REQUEST_INACTIVITY_TIMEOUT_MS = 300_000;

interface PendingRequest {
  resolve: (value: Audio8NativeResult) => void;
  reject: (error: Error) => void;
  onProgress?: (percent: number) => void;
  timer?: ReturnType<typeof setTimeout>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asResponse(value: unknown): Audio8WorkerResponse | null {
  if (!isRecord(value) || typeof value.requestId !== "string") return null;
  if (value.type === "progress" && typeof value.percent === "number") {
    return { type: "progress", requestId: value.requestId, percent: value.percent };
  }
  if (value.type === "result" && isRecord(value.result) && typeof value.result.sampleRate === "number") {
    return { type: "result", requestId: value.requestId, result: value.result as unknown as Audio8NativeResult };
  }
  if (value.type === "error") {
    return {
      type: "error",
      requestId: value.requestId,
      error: typeof value.error === "string" && value.error ? value.error : "Audio8 native worker failed.",
    };
  }
  return null;
}

export class Audio8NativeClient {
  readonly #modelDir: string;
  readonly #workerPath: string;
  readonly #createWorker: Audio8WorkerFactory;
  readonly #inactivityTimeoutMs: number;
  readonly #pending = new Map<string, PendingRequest>();
  #worker: Audio8WorkerLike | null = null;
  /**
   * Contract, not hygiene: once `destroy()` has run this client is finished for
   * good and every later request rejects. `main.ts`'s clear-cache relies on it —
   * it drops its reference to this client and then awaits `destroy()`, so a
   * request racing the teardown can never resurrect a worker that would map the
   * ONNX graphs again while the cache directory is being unlinked. Callers that
   * want Audio8 back after a clear must construct a new client.
   */
  #closed = false;

  constructor(
    modelDir: string,
    createWorker: Audio8WorkerFactory = (workerPath, options) => new Worker(workerPath, options),
    inactivityTimeoutMs: number = AUDIO8_REQUEST_INACTIVITY_TIMEOUT_MS,
  ) {
    this.#modelDir = modelDir;
    this.#workerPath = path.join(__dirname, "audio8NativeWorker.js");
    this.#createWorker = createWorker;
    this.#inactivityTimeoutMs = inactivityTimeoutMs;
  }

  load(requestId: string, onProgress: (percent: number) => void): Promise<Audio8NativeResult> {
    return this.#request({ type: "load", requestId }, onProgress);
  }

  generate(
    requestId: string,
    text: string,
    voice: string,
    onProgress?: (percent: number) => void,
  ): Promise<Audio8NativeResult> {
    return this.#request({ type: "generate", requestId, text, voice }, onProgress);
  }

  /**
   * True when `requestId` was still in flight and the cancel was delivered.
   * False means there was nothing to cancel — the request had already settled,
   * or the worker it belonged to is gone — so callers can answer honestly
   * rather than reporting delivery as cancellation.
   */
  cancel(requestId: string): boolean {
    if (!this.#pending.has(requestId) || !this.#worker) return false;
    this.#worker.postMessage({ type: "cancel", requestId });
    return true;
  }

  /**
   * Rejects everything in flight, then resolves only once the worker thread has
   * actually exited. Callers unlink the cache directory behind this promise:
   * the graphs stay memory-mapped until the thread is gone, and Windows fails
   * the unlink outright rather than deferring it the way POSIX does. See the
   * `#closed` contract above — this client cannot be reused afterwards.
   */
  async destroy(): Promise<void> {
    this.#closed = true;
    const worker = this.#worker;
    this.#worker = null;
    this.#failAll(new Error("Audio8 native worker stopped."));
    if (worker) await worker.terminate();
  }

  #request(
    message: Extract<Audio8WorkerRequest, { type: "load" | "generate" }>,
    onProgress?: (percent: number) => void,
  ): Promise<Audio8NativeResult> {
    if (this.#closed) return Promise.reject(new Error("Audio8 native worker is shutting down."));
    if (this.#pending.has(message.requestId)) {
      return Promise.reject(new Error(`Audio8 request ${message.requestId} is already in flight.`));
    }
    let worker: Audio8WorkerLike;
    try {
      // A crashed worker leaves no reference behind, so the next request starts
      // a fresh one. The renderer's retry button depends on this: the main
      // process caches the client for the lifetime of the app.
      worker = this.#worker ?? this.#spawn();
    } catch (cause) {
      return Promise.reject(cause instanceof Error ? cause : new Error(String(cause)));
    }
    return new Promise<Audio8NativeResult>((resolve, reject) => {
      this.#pending.set(message.requestId, { resolve, reject, onProgress });
      this.#extendDeadline(message.requestId);
      worker.postMessage(message);
    });
  }

  #spawn(): Audio8WorkerLike {
    const worker = this.#createWorker(this.#workerPath, { workerData: { modelDir: this.#modelDir } });
    this.#worker = worker;
    // Electron's windows keep the app alive. The inference worker should not
    // keep a CLI test process or a closing app alive on its own.
    worker.unref();
    worker.on("message", (message) => this.#handleMessage(message));
    worker.on("error", (error) => this.#retireWorker(worker, error));
    worker.on("exit", (code) => this.#retireWorker(
      worker,
      new Error(`Audio8 native worker exited with code ${code}.`),
    ));
    return worker;
  }

  #handleMessage(value: unknown): void {
    const message = asResponse(value);
    if (!message) return;
    const pending = this.#pending.get(message.requestId);
    if (!pending) return;
    if (message.type === "progress") {
      // Progress is routed to the request that caused it. Fanning it out sent a
      // second window's download percentages — and a generation's token
      // percentages — into whichever progress bar happened to be listening.
      this.#extendDeadline(message.requestId);
      pending.onProgress?.(message.percent);
      return;
    }
    this.#settle(message.requestId, pending);
    if (message.type === "result") pending.resolve(message.result);
    else pending.reject(new Error(message.error));
  }

  #retireWorker(worker: Audio8WorkerLike, error: Error): void {
    // "exit" trails "error", and a terminate() during shutdown reports both.
    if (this.#worker !== worker) return;
    this.#worker = null;
    this.#failAll(error);
  }

  #extendDeadline(requestId: string): void {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => this.#expire(requestId), this.#inactivityTimeoutMs);
    pending.timer.unref?.();
  }

  #expire(requestId: string): void {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    const seconds = Math.round(this.#inactivityTimeoutMs / 1000);
    const error = new Error(`Audio8 native worker stopped responding after ${seconds}s.`);
    // A worker stuck inside a native ONNX call cannot be talked out of it, and
    // its session holds ~1 GiB. Replace it so the next request starts clean.
    const worker = this.#worker;
    this.#worker = null;
    void worker?.terminate().catch(() => undefined);
    this.#settle(requestId, pending);
    pending.reject(error);
    this.#failAll(error);
  }

  #settle(requestId: string, pending: PendingRequest): void {
    if (pending.timer) clearTimeout(pending.timer);
    this.#pending.delete(requestId);
  }

  #failAll(error: Error): void {
    const pending = [...this.#pending.entries()];
    this.#pending.clear();
    for (const [, request] of pending) {
      if (request.timer) clearTimeout(request.timer);
      request.reject(error);
    }
  }
}
