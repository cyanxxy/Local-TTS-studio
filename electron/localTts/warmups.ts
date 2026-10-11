import type { LocalModel } from "../localTtsIpc";
import { NEUTTS_DEFAULT_MODEL_REPO } from "../localTtsLimits";

export interface PendingWarmup {
  requestId: string;
  targetKey: string;
  promise: Promise<void>;
}

/** Identifies what a warm-up loads, so a generate for the same target can wait on it. */
export function warmTargetKey(model: LocalModel, payload: Record<string, unknown>): string {
  if (model === "qwen3") {
    return [model, payload.mode, payload.modelRepo, payload.modelPath].map(String).join("\0");
  }
  return [model, payload.modelRepo ?? NEUTTS_DEFAULT_MODEL_REPO].map(String).join("\0");
}

/**
 * Best-effort model warm-ups. At most one warm-up runs per model; a generate
 * request that arrives while one is in flight waits for it (the warm-up is
 * doing exactly the model load the generation would otherwise pay) instead of
 * failing with "already running".
 */
export class WarmupCoordinator {
  readonly #pending = new Map<LocalModel, PendingWarmup>();
  // Generate requests currently waiting on a warm-up, so cancel can reach them
  // before they are registered with the worker pool.
  readonly #waiters = new Map<string, LocalModel>();
  readonly #cancelledWaiters = new Set<string>();

  pending(model: LocalModel): PendingWarmup | undefined {
    return this.#pending.get(model);
  }

  /**
   * Publishes a warm-up for `model`. `settle` releases everything waiting on it
   * and withdraws it, unless a newer warm-up has replaced it in the meantime.
   */
  begin(model: LocalModel, requestId: string, targetKey: string): { warmup: PendingWarmup; settle: () => void } {
    let resolveWarmCompletion!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveWarmCompletion = resolve;
    });
    const warmup = { requestId, targetKey, promise };
    this.#pending.set(model, warmup);
    return {
      warmup,
      settle: () => {
        resolveWarmCompletion();
        if (this.#pending.get(model) === warmup) this.#pending.delete(model);
      },
    };
  }

  addWaiter(requestId: string, model: LocalModel): void {
    this.#waiters.set(requestId, model);
  }

  removeWaiter(requestId: string): void {
    this.#waiters.delete(requestId);
    this.#cancelledWaiters.delete(requestId);
  }

  isWaiterCancelled(requestId: string): boolean {
    return this.#cancelledWaiters.has(requestId);
  }

  /**
   * Records a cancel for a generate request that is still in its pre-pool
   * window and returns the warm-up it is blocked on, so the caller can stop
   * that too and release the waiter promptly. Undefined when `requestId` is
   * not waiting.
   */
  cancelWaiter(requestId: string): PendingWarmup | undefined {
    const model = this.#waiters.get(requestId);
    if (model === undefined) return undefined;
    this.#cancelledWaiters.add(requestId);
    return this.#pending.get(model);
  }
}
