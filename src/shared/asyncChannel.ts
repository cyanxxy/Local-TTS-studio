/**
 * A single-consumer async queue. Producers `push` values; one consumer pulls
 * them with `for await`. Values pushed before the consumer asks are buffered.
 *
 * `close` ends the stream after the buffered values. `fail` drops whatever is
 * buffered and makes the next pull reject: it is how a cancelled or broken
 * producer stops a consumer promptly, not a way to append a final value.
 */
export interface AsyncChannel<T> extends AsyncIterableIterator<T> {
  push(value: T): void;
  close(): void;
  fail(error: unknown): void;
  /** Stops consuming early: drops buffered values and ends the stream. */
  return(): Promise<IteratorResult<T>>;
  /** True once the channel was closed, failed or returned; later pushes are dropped. */
  readonly settled: boolean;
}

interface ChannelOptions {
  /** Runs when the consumer stops early (`break` in `for await`, or `return()`). */
  onReturn?: () => void;
}

interface Waiter<T> {
  resolve: (result: IteratorResult<T>) => void;
  reject: (error: unknown) => void;
}

const DONE: IteratorReturnResult<undefined> = { value: undefined, done: true };

export function createAsyncChannel<T>({ onReturn }: ChannelOptions = {}): AsyncChannel<T> {
  const buffer: T[] = [];
  const waiters: Waiter<T>[] = [];
  let state: "open" | "closed" | "failed" = "open";
  let failure: unknown;

  const settle = (next: "closed" | "failed", error?: unknown) => {
    if (state !== "open") return false;
    state = next;
    failure = error;
    return true;
  };

  const channel: AsyncChannel<T> = {
    get settled() {
      return state !== "open";
    },
    push(value) {
      if (state !== "open") return;
      const waiter = waiters.shift();
      if (waiter) waiter.resolve({ value, done: false });
      else buffer.push(value);
    },
    close() {
      if (!settle("closed")) return;
      for (const waiter of waiters.splice(0)) waiter.resolve(DONE);
    },
    fail(error) {
      if (!settle("failed", error)) return;
      buffer.length = 0;
      const pending = waiters.splice(0);
      if (pending.length === 0) return;
      // The failure is delivered once; anyone else waiting just sees the end.
      state = "closed";
      pending[0].reject(error);
      for (const waiter of pending.slice(1)) waiter.resolve(DONE);
    },
    next() {
      if (buffer.length > 0) return Promise.resolve({ value: buffer.shift() as T, done: false });
      if (state === "failed") {
        state = "closed";
        return Promise.reject(failure);
      }
      if (state === "closed") return Promise.resolve(DONE);
      return new Promise<IteratorResult<T>>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
    return() {
      const stoppedEarly = settle("closed");
      buffer.length = 0;
      for (const waiter of waiters.splice(0)) waiter.resolve(DONE);
      if (stoppedEarly) onReturn?.();
      return Promise.resolve(DONE);
    },
    [Symbol.asyncIterator]() {
      return channel;
    },
  };
  return channel;
}

/** The `AbortError` an abandoned request rejects with when its signal gave no reason. */
export function createAbortError(message = "The request was aborted."): DOMException {
  return new DOMException(message, "AbortError");
}

export function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

/**
 * Settles with `promise`, or rejects with the signal's reason as soon as it
 * aborts. The underlying work is not cancelled; pair this with whatever stops
 * the transport.
 */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
