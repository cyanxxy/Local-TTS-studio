/**
 * Generation epochs and the model run lock.
 *
 * A worker owns one model, and ONNX Runtime sessions must never run two
 * inferences at once. Every GENERATE therefore runs as a task: starting a task
 * invalidates the previous generation immediately (its loop stops posting at
 * its next epoch check), and the new task waits until every earlier task has
 * settled before it touches the model. ABORT invalidates a generation the same
 * way without starting another, which is what lets hosts stop a generation
 * without closing the worker and reloading the model.
 */

export interface GenerationTicket {
  readonly generationId: string | undefined;
  /**
   * False once a newer GENERATE, an ABORT, a CANCEL, or a forced reload
   * superseded this generation. Check it after every await and before every
   * post: a superseded generation must post nothing more.
   */
  isCurrent(): boolean;
  /** Aborted at the moment `isCurrent` turns false, to stop downloads the generation no longer needs. */
  readonly signal: AbortSignal;
}

export interface GenerationController {
  /**
   * Starts a generation task. Resolves when the task has settled and never
   * rejects; the task reports its own errors (see createWorkerRuntime).
   * The task starts synchronously when no earlier task is pending.
   */
  run(generationId: string | undefined, task: (ticket: GenerationTicket) => Promise<void>): Promise<void>;
  /**
   * Soft abort. Invalidates the named generation when it is the current one
   * (the latest pending one when `generationId` is omitted). `onSettled` runs
   * once that generation has settled, i.e. its in-flight inference returned
   * and it will post nothing more, and before any later generation starts.
   * When no pending generation matches, `onSettled` runs in a microtask; a
   * stale id never invalidates a newer generation. The returned promise
   * resolves after `onSettled` has run.
   */
  abort(generationId?: string, onSettled?: () => void): Promise<void>;
  /** Invalidates every generation started so far (hard cancel, forced reload). */
  invalidate(): void;
  /** Resolves once every generation started so far has settled. */
  idle(): Promise<void>;
}

interface PendingGeneration {
  readonly generationId: string | undefined;
  readonly epoch: number;
  /** Abort callbacks, run when this generation settles. */
  readonly onSettled: Array<() => void>;
  settled: Promise<void>;
}

function latestPending(
  pending: readonly PendingGeneration[],
  generationId: string | undefined,
): PendingGeneration | undefined {
  if (generationId === undefined) return pending.at(-1);
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    if (pending[index].generationId === generationId) return pending[index];
  }
  return undefined;
}

function runSettledCallback(callback: () => void): void {
  try {
    callback();
  } catch (error) {
    // A failing callback must not wedge the generations queued behind it.
    console.error("[worker] abort callback failed", error);
  }
}

export function createGenerationController(): GenerationController {
  let epoch = 0;
  const controllers = new Map<number, AbortController>();
  /** Moves to the next epoch, which supersedes every generation of an earlier one. */
  const advance = (): void => {
    epoch += 1;
    for (const [ticketEpoch, controller] of controllers) {
      if (ticketEpoch < epoch) {
        controllers.delete(ticketEpoch);
        controller.abort();
      }
    }
  };
  let tail: Promise<void> = Promise.resolve();
  // Unsettled generations in start order. Only the last one can be current.
  const pending: PendingGeneration[] = [];

  const run: GenerationController["run"] = (generationId, task) => {
    advance();
    const ticketEpoch = epoch;
    const controller = new AbortController();
    controllers.set(ticketEpoch, controller);
    const ticket: GenerationTicket = {
      generationId,
      isCurrent: () => epoch === ticketEpoch,
      signal: controller.signal,
    };
    const start = async (): Promise<void> => {
      // A generation superseded while it queued never touches the model.
      if (ticket.isCurrent()) await task(ticket);
    };
    const entry: PendingGeneration = { generationId, epoch: ticketEpoch, onSettled: [], settled: tail };
    const done = pending.length === 0 ? start() : tail.then(start);
    pending.push(entry);
    entry.settled = done
      .catch((error: unknown) => {
        // Tasks catch their own errors; reaching this is a worker bug, and the
        // chain must keep going so later generations are not wedged behind it.
        console.error("[worker] generation task failed unexpectedly", error);
      })
      .then(() => {
        // Part of the settle step itself, so the next generation, which is
        // chained on it, starts only after the abort callbacks have run.
        controllers.delete(ticketEpoch);
        pending.splice(pending.indexOf(entry), 1);
        entry.onSettled.forEach(runSettledCallback);
      });
    tail = entry.settled;
    return entry.settled;
  };

  return {
    run,
    abort(generationId, onSettled) {
      const target = latestPending(pending, generationId);
      if (!target) {
        return Promise.resolve().then(() => {
          if (onSettled) runSettledCallback(onSettled);
        });
      }
      if (target.epoch === epoch) advance();
      if (onSettled) target.onSettled.push(onSettled);
      return target.settled;
    },
    invalidate() {
      advance();
    },
    idle() {
      return tail;
    },
  };
}
