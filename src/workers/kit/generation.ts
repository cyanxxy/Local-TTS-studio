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
}

export interface GenerationController {
  /**
   * Starts a generation task. Resolves when the task has settled and never
   * rejects; the task reports its own errors (see createWorkerMessageHandler).
   * The task starts synchronously when no earlier task is pending.
   */
  run(generationId: string | undefined, task: (ticket: GenerationTicket) => Promise<void>): Promise<void>;
  /**
   * Soft abort. Invalidates the named generation when it is the current one
   * (the latest pending one when `generationId` is omitted) and resolves once
   * that generation has settled, i.e. its in-flight inference returned and it
   * will post nothing more. Resolves immediately when no pending generation
   * matches; a stale id never invalidates a newer generation.
   */
  abort(generationId?: string): Promise<void>;
  /** Invalidates every generation started so far (hard cancel, forced reload). */
  invalidate(): void;
  /** Resolves once every generation started so far has settled. */
  idle(): Promise<void>;
}

interface PendingGeneration {
  readonly generationId: string | undefined;
  readonly epoch: number;
  readonly settled: Promise<void>;
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

export function createGenerationController(): GenerationController {
  let epoch = 0;
  let tail: Promise<void> = Promise.resolve();
  // Unsettled generations in start order. Only the last one can be current.
  const pending: PendingGeneration[] = [];

  const run: GenerationController["run"] = (generationId, task) => {
    epoch += 1;
    const ticketEpoch = epoch;
    const ticket: GenerationTicket = {
      generationId,
      isCurrent: () => epoch === ticketEpoch,
    };
    const start = async (): Promise<void> => {
      // A generation superseded while it queued never touches the model.
      if (ticket.isCurrent()) await task(ticket);
    };
    const done = pending.length === 0 ? start() : tail.then(start);
    const settled = done.catch((error: unknown) => {
      // Tasks catch their own errors; reaching this is a worker bug, and the
      // chain must keep going so later generations are not wedged behind it.
      console.error("[worker] generation task failed unexpectedly", error);
    });
    const entry: PendingGeneration = { generationId, epoch: ticketEpoch, settled };
    pending.push(entry);
    tail = settled;
    void settled.then(() => {
      pending.splice(pending.indexOf(entry), 1);
    });
    return settled;
  };

  return {
    run,
    abort(generationId) {
      const target = latestPending(pending, generationId);
      if (!target) return Promise.resolve();
      if (target.epoch === epoch) epoch += 1;
      return target.settled;
    },
    invalidate() {
      epoch += 1;
    },
    idle() {
      return tail;
    },
  };
}
