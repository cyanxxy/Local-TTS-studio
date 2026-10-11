import { createAbortError, createAsyncChannel, type AsyncChannel } from "./asyncChannel";

/**
 * Produces one request's audio. It must stop promptly once `signal` aborts:
 * end its iteration (or reject) and release whatever transport it holds,
 * because the queue starts the next request only after this one has wound down.
 */
export type SynthesisTask<Chunk> = (signal: AbortSignal) => AsyncIterable<Chunk>;

interface Job<Chunk> {
  task: SynthesisTask<Chunk>;
  controller: AbortController;
  channel: AsyncChannel<Chunk>;
  detach: () => void;
}

/**
 * Serializes one engine's synthesize requests.
 *
 * Requests run one at a time in the order they were made, and never while the
 * engine's own surface generation runs (`setForegroundBusy`): every engine
 * transport produces one generation at a time, and a second request would
 * silently supersede the first. Each request starts as soon as its turn comes
 * and buffers its chunks until they are read, so a caller that is slow to read
 * — or never reads — cannot stall the requests behind it.
 *
 * A request ends when its audio is complete, when it fails (the iteration
 * rejects with that error), when its signal aborts (the iteration rejects with
 * the signal's reason), or when the caller stops iterating early.
 */
export class SynthesisQueue<Chunk> {
  private readonly pending: Job<Chunk>[] = [];
  private running: Job<Chunk> | null = null;
  private foregroundBusy = false;
  private readonly listeners = new Set<() => void>();

  /** True while a request runs; the engine's own generation must not start then. */
  get busy(): boolean {
    return this.running !== null;
  }

  /** Requests waiting for their turn. */
  get waiting(): number {
    return this.pending.length;
  }

  /** `useSyncExternalStore` subscription to `busy`. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getBusy = (): boolean => this.busy;

  /** Holds queued requests while the engine's own surface generation runs. */
  setForegroundBusy(busy: boolean): void {
    if (this.foregroundBusy === busy) return;
    this.foregroundBusy = busy;
    this.pump();
  }

  enqueue(task: SynthesisTask<Chunk>, signal?: AbortSignal): AsyncIterable<Chunk> {
    const controller = new AbortController();
    const channel = createAsyncChannel<Chunk>({
      onReturn: () => controller.abort(createAbortError("The synthesis request was abandoned.")),
    });
    const job: Job<Chunk> = { task, controller, channel, detach: () => undefined };
    controller.signal.addEventListener("abort", () => this.handleAbort(job), { once: true });
    if (signal?.aborted) {
      controller.abort(signal.reason);
      return channel;
    }
    if (signal) {
      const forwardAbort = () => controller.abort(signal.reason);
      signal.addEventListener("abort", forwardAbort, { once: true });
      job.detach = () => signal.removeEventListener("abort", forwardAbort);
    }
    this.pending.push(job);
    this.pump();
    return channel;
  }

  /** Aborts every queued and running request, e.g. when the engine unmounts. */
  abortAll(reason: unknown = createAbortError("The engine stopped.")): void {
    const jobs = this.running ? [...this.pending, this.running] : [...this.pending];
    for (const job of jobs) job.controller.abort(reason);
  }

  private handleAbort(job: Job<Chunk>): void {
    // The reader learns at once; a running task winds down through `execute`,
    // which starts the next request only after the task has stopped.
    job.channel.fail(job.controller.signal.reason);
    const index = this.pending.indexOf(job);
    if (index === -1) return;
    this.pending.splice(index, 1);
    job.detach();
  }

  private pump(): void {
    if (this.running || this.foregroundBusy) return;
    const job = this.pending.shift();
    if (job) void this.execute(job);
  }

  private async execute(job: Job<Chunk>): Promise<void> {
    this.running = job;
    this.notify();
    const { signal } = job.controller;
    try {
      for await (const chunk of job.task(signal)) {
        if (signal.aborted) break;
        job.channel.push(chunk);
      }
      signal.throwIfAborted();
      job.channel.close();
    } catch (error) {
      job.channel.fail(signal.aborted ? signal.reason : error);
    } finally {
      job.detach();
      this.running = null;
      this.notify();
      this.pump();
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
