/**
 * Main-process owner of a native model's inference worker.
 *
 * Owns the single worker thread, routes request/response pairs by id, and
 * keeps the renderer's promises honest: a worker that dies, is terminated, or
 * stops answering must reject the requests waiting on it rather than leave the
 * model panel spinning at "loading" forever.
 */

import path from "path";
import { Worker } from "worker_threads";
import type { NativeModelDescriptor } from "./descriptor";
import {
  parseNativeModelWorkerResponse,
  type NativeModelRequest,
  type NativeModelWorkerData,
  type NativeModelWorkerRequest,
} from "./workerProtocol";

export interface NativeModelWorkerLike<TModelRequest extends NativeModelRequest> {
  on(event: "message", listener: (message: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  postMessage(message: NativeModelWorkerRequest<TModelRequest>): void;
  terminate(): Promise<number>;
  unref(): void;
}

export type NativeModelWorkerFactory<TModelRequest extends NativeModelRequest> = (
  workerPath: string,
  options: { workerData: NativeModelWorkerData },
) => NativeModelWorkerLike<TModelRequest>;

/**
 * How long a request may go without any word from the worker. Loads report
 * download percentages and generations report token percentages, so silence
 * this long means the worker is wedged rather than busy — a generation that
 * legitimately runs for minutes keeps ticking and is never cut off.
 */
export const NATIVE_MODEL_REQUEST_INACTIVITY_TIMEOUT_MS = 300_000;

/** Compiled worker scripts sit at the root of the Electron output, one level above this module. */
const ELECTRON_OUTPUT_DIR = path.resolve(__dirname, "..");

export interface NativeModelWorkerClientOptions<TModelRequest extends NativeModelRequest> {
  descriptor: NativeModelDescriptor;
  /** The revision directory handed to the worker. */
  modelDir: string;
  /** Recognises a well-formed result; anything else is ignored as noise. */
  isResult: (result: Record<string, unknown>) => boolean;
  /** Seam for tests; production starts a real worker thread. */
  createWorker?: NativeModelWorkerFactory<TModelRequest>;
  inactivityTimeoutMs?: number;
}

interface PendingRequest<TResult> {
  resolve: (value: TResult) => void;
  reject: (error: Error) => void;
  onProgress?: (percent: number) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class NativeModelWorkerClient<TModelRequest extends NativeModelRequest, TResult> {
  readonly #label: string;
  readonly #modelDir: string;
  readonly #workerPath: string;
  readonly #isResult: (result: Record<string, unknown>) => boolean;
  readonly #createWorker: NativeModelWorkerFactory<TModelRequest>;
  readonly #inactivityTimeoutMs: number;
  readonly #pending = new Map<string, PendingRequest<TResult>>();
  #worker: NativeModelWorkerLike<TModelRequest> | null = null;
  /**
   * Contract, not hygiene: once `destroy()` has run this client is finished for
   * good and every later request rejects. `main.ts`'s clear-cache relies on it —
   * it drops its reference to this client and then awaits `destroy()`, so a
   * request racing the teardown can never resurrect a worker that would map the
   * ONNX graphs again while the cache directory is being unlinked. Callers that
   * want the model back after a clear must construct a new client.
   */
  #closed = false;

  constructor({
    descriptor,
    modelDir,
    isResult,
    createWorker = (workerPath, options) => new Worker(workerPath, options),
    inactivityTimeoutMs = NATIVE_MODEL_REQUEST_INACTIVITY_TIMEOUT_MS,
  }: NativeModelWorkerClientOptions<TModelRequest>) {
    this.#label = descriptor.label;
    this.#modelDir = modelDir;
    this.#workerPath = path.join(ELECTRON_OUTPUT_DIR, descriptor.workerEntry);
    this.#isResult = isResult;
    this.#createWorker = createWorker;
    this.#inactivityTimeoutMs = inactivityTimeoutMs;
  }

  load(requestId: string, onProgress: (percent: number) => void): Promise<TResult> {
    return this.request({ type: "load", requestId }, onProgress);
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
    this.#failAll(new Error(`${this.#label} native worker stopped.`));
    if (worker) await worker.terminate();
  }

  /** Sends a load or one of the model's own requests and waits for its answer. */
  protected request(
    message: Exclude<NativeModelWorkerRequest<TModelRequest>, { type: "cancel" }>,
    onProgress?: (percent: number) => void,
  ): Promise<TResult> {
    if (this.#closed) return Promise.reject(new Error(`${this.#label} native worker is shutting down.`));
    if (this.#pending.has(message.requestId)) {
      return Promise.reject(new Error(`${this.#label} request ${message.requestId} is already in flight.`));
    }
    let worker: NativeModelWorkerLike<TModelRequest>;
    try {
      // A crashed worker leaves no reference behind, so the next request starts
      // a fresh one. The renderer's retry button depends on this: the main
      // process caches the client for the lifetime of the app.
      worker = this.#worker ?? this.#spawn();
    } catch (cause) {
      return Promise.reject(cause instanceof Error ? cause : new Error(String(cause)));
    }
    return new Promise<TResult>((resolve, reject) => {
      this.#pending.set(message.requestId, { resolve, reject, onProgress });
      this.#extendDeadline(message.requestId);
      worker.postMessage(message);
    });
  }

  #spawn(): NativeModelWorkerLike<TModelRequest> {
    const worker = this.#createWorker(this.#workerPath, { workerData: { modelDir: this.#modelDir } });
    this.#worker = worker;
    // Electron's windows keep the app alive. The inference worker should not
    // keep a CLI test process or a closing app alive on its own.
    worker.unref();
    worker.on("message", (message) => this.#handleMessage(message));
    worker.on("error", (error) => this.#retireWorker(worker, error));
    worker.on("exit", (code) => this.#retireWorker(
      worker,
      new Error(`${this.#label} native worker exited with code ${code}.`),
    ));
    return worker;
  }

  #handleMessage(value: unknown): void {
    const message = parseNativeModelWorkerResponse<TResult>(
      value,
      this.#isResult,
      `${this.#label} native worker failed.`,
    );
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

  #retireWorker(worker: NativeModelWorkerLike<TModelRequest>, error: Error): void {
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
    const error = new Error(`${this.#label} native worker stopped responding after ${seconds}s.`);
    // A worker stuck inside a native ONNX call cannot be talked out of it, and
    // its sessions can hold a gigabyte or more. Replace it so the next request
    // starts clean.
    const worker = this.#worker;
    this.#worker = null;
    void worker?.terminate().catch(() => undefined);
    this.#settle(requestId, pending);
    pending.reject(error);
    this.#failAll(error);
  }

  #settle(requestId: string, pending: PendingRequest<TResult>): void {
    if (pending.timer) clearTimeout(pending.timer);
    this.#pending.delete(requestId);
  }

  #failAll(error: Error): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const request of pending) {
      if (request.timer) clearTimeout(request.timer);
      request.reject(error);
    }
  }
}
