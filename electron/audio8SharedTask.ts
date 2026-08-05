/**
 * Work that several callers wait on without it running twice.
 *
 * The Audio8 worker is a process-wide singleton every window talks to, and the
 * renderer re-issues `load` on React StrictMode's double effect, on model
 * toggles, and from its retry button. Guarding only the *finished* state let
 * two loads run at once: both downloaded the same 572 MiB and both wrote to the
 * same `.partial` path, interleaving chunks into corrupt bytes.
 *
 * Progress fans out to every participant. The shared work is abandoned only
 * once the last participant has given up, so one window pressing Stop cannot
 * cancel a transfer another window is still waiting on.
 */

export interface SharedTaskContext<TProgress> {
  /** Aborted once every participant has left. */
  signal: AbortSignal;
  report: (progress: TProgress) => void;
}

export type SharedTaskBody<TResult, TProgress> = (
  context: SharedTaskContext<TProgress>,
) => Promise<TResult>;

export interface SharedTaskParticipant<TProgress> {
  onProgress?: (progress: TProgress) => void;
  signal?: AbortSignal;
}

interface Participant<TProgress> {
  onProgress?: (progress: TProgress) => void;
}

interface ActiveRun<TResult, TProgress> {
  promise: Promise<TResult>;
  controller: AbortController;
  participants: Set<Participant<TProgress>>;
  settled: boolean;
}

export class SharedTask<TResult, TProgress = never> {
  readonly #cancelledError: () => Error;
  #active: ActiveRun<TResult, TProgress> | null = null;

  constructor(cancelledError: () => Error) {
    this.#cancelledError = cancelledError;
  }

  /** True while a run is in flight, including one every participant has left. */
  get running(): boolean {
    return this.#active !== null;
  }

  run(
    body: SharedTaskBody<TResult, TProgress>,
    { onProgress, signal }: SharedTaskParticipant<TProgress> = {},
  ): Promise<TResult> {
    if (signal?.aborted) return Promise.reject(this.#cancelledError());
    if (this.#active?.controller.signal.aborted) {
      return this.#restartAfterAbandonedRun(body, { onProgress, signal }, this.#active);
    }
    const run = this.#active ?? this.#begin(body);
    const participant: Participant<TProgress> = { onProgress };
    run.participants.add(participant);

    return new Promise<TResult>((resolve, reject) => {
      const leave = () => {
        if (!run.participants.delete(participant)) return;
        if (run.participants.size === 0 && !run.settled) run.controller.abort();
      };
      const abandon = () => {
        leave();
        reject(this.#cancelledError());
      };
      signal?.addEventListener("abort", abandon, { once: true });
      run.promise.then(
        (value) => {
          signal?.removeEventListener("abort", abandon);
          leave();
          resolve(value);
        },
        (error: unknown) => {
          signal?.removeEventListener("abort", abandon);
          leave();
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  #restartAfterAbandonedRun(
    body: SharedTaskBody<TResult, TProgress>,
    participant: SharedTaskParticipant<TProgress>,
    abandoned: ActiveRun<TResult, TProgress>,
  ): Promise<TResult> {
    return new Promise<TResult>((resolve, reject) => {
      const signal = participant.signal;
      let settled = false;
      const cancel = () => {
        if (settled) return;
        settled = true;
        reject(this.#cancelledError());
      };
      signal?.addEventListener("abort", cancel, { once: true });
      void abandoned.promise.catch(() => undefined).then(() => {
        if (settled) return;
        signal?.removeEventListener("abort", cancel);
        if (signal?.aborted) {
          cancel();
          return;
        }
        settled = true;
        this.run(body, participant).then(resolve, reject);
      });
    });
  }

  #begin(body: SharedTaskBody<TResult, TProgress>): ActiveRun<TResult, TProgress> {
    const controller = new AbortController();
    const participants = new Set<Participant<TProgress>>();
    const run: Partial<ActiveRun<TResult, TProgress>> = { controller, participants, settled: false };
    // Snapshot the participant set per report: a listener may join or leave
    // while an earlier listener is still running.
    const report = (progress: TProgress) => {
      for (const participant of [...participants]) participant.onProgress?.(progress);
    };
    run.promise = (async () => body({ signal: controller.signal, report }))().finally(() => {
      run.settled = true;
      if (this.#active === run) this.#active = null;
    });
    const active = run as ActiveRun<TResult, TProgress>;
    this.#active = active;
    return active;
  }
}

/**
 * A `SharedTask` per key. Used for per-asset downloads, where two voices are
 * independent but two requests for the same voice must share one transfer.
 */
export class SharedTaskGroup<TResult, TProgress = never> {
  readonly #cancelledError: () => Error;
  readonly #tasks = new Map<string, SharedTask<TResult, TProgress>>();

  constructor(cancelledError: () => Error) {
    this.#cancelledError = cancelledError;
  }

  run(
    key: string,
    body: SharedTaskBody<TResult, TProgress>,
    participant: SharedTaskParticipant<TProgress> = {},
  ): Promise<TResult> {
    const task = this.#tasks.get(key) ?? new SharedTask<TResult, TProgress>(this.#cancelledError);
    this.#tasks.set(key, task);
    const forget = () => {
      // A later caller may already have restarted this key; dropping a running
      // task would let a second transfer open on the same `.partial` path.
      if (!task.running && this.#tasks.get(key) === task) this.#tasks.delete(key);
    };
    return task.run(body, participant).then(
      (value) => {
        forget();
        return value;
      },
      (error: unknown) => {
        forget();
        throw error;
      },
    );
  }
}

/** A process-local FIFO for heavyweight work that must never overlap. */
export class SerialTaskQueue {
  #tail: Promise<void> = Promise.resolve();

  run<TResult>(body: () => Promise<TResult>): Promise<TResult> {
    const result = this.#tail.then(body);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
