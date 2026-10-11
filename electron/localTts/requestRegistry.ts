import type { BridgeAction, LocalModel } from "../localTtsIpc";
import { createSenderWatcher, type RequestSender } from "./senderLifecycle";

export type { RequestSender } from "./senderLifecycle";

export interface BridgeRequestOwner {
  model: LocalModel;
  senderId: number;
  kind: BridgeAction | "warm";
}

/**
 * Tracks which renderer owns each local-runtime request (generate, probe and
 * warm-up share one id space) and which of them have been cancelled.
 * Cancellation is recorded here first, so code that is still between await
 * points sees it, and is then handed to `stop`, which reaches the request
 * wherever it currently runs.
 */
export class BridgeRequestRegistry {
  readonly #owners = new Map<string, BridgeRequestOwner>();
  readonly #cancelled = new Set<string>();
  readonly #stop: (requestId: string) => void;
  // A renderer that goes away cancels every request it owns.
  readonly #watch = createSenderWatcher((senderId) => this.#cancelForSender(senderId));

  constructor(stop: (requestId: string) => void) {
    this.#stop = stop;
  }

  /** Claims `requestId` for its sender; throws if the id is already running. */
  register(
    requestId: string,
    model: LocalModel,
    kind: BridgeRequestOwner["kind"],
    sender?: RequestSender,
  ): BridgeRequestOwner {
    if (this.#owners.has(requestId)) {
      throw new Error(`A request with id ${requestId} is already running.`);
    }
    if (sender) this.#watch(sender);
    const owner = { model, senderId: sender?.id ?? -1, kind };
    this.#owners.set(requestId, owner);
    return owner;
  }

  release(requestId: string, owner: BridgeRequestOwner): void {
    if (this.#owners.get(requestId) === owner) {
      this.#owners.delete(requestId);
    }
    this.#cancelled.delete(requestId);
  }

  owner(requestId: string): BridgeRequestOwner | undefined {
    return this.#owners.get(requestId);
  }

  isCancelled(requestId: string): boolean {
    return this.#cancelled.has(requestId);
  }

  /** Records the cancellation, then stops the request wherever it runs. */
  cancel(requestId: string): void {
    this.#cancelled.add(requestId);
    this.#stop(requestId);
  }

  /** Records a cancellation the caller is stopping by other means. */
  markCancelled(requestId: string): void {
    this.#cancelled.add(requestId);
  }

  /** Records every registered request as cancelled (the quit). */
  markAllCancelled(): void {
    for (const requestId of this.#owners.keys()) {
      this.#cancelled.add(requestId);
    }
  }

  #cancelForSender(senderId: number): void {
    for (const [requestId, owner] of this.#owners) {
      if (owner.senderId !== senderId) continue;
      this.cancel(requestId);
    }
  }
}
