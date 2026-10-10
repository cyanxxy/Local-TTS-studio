import type { WebContents } from "electron";
import type { BridgeAction, LocalModel } from "../localTtsIpc";

export interface BridgeRequestOwner {
  model: LocalModel;
  senderId: number;
  kind: BridgeAction | "warm";
}

/**
 * The renderer that started a request. The registry watches it so a crashed,
 * navigating or closed renderer cannot leave its requests running.
 */
export type RequestSender = Pick<WebContents, "id" | "on" | "once" | "removeListener">;

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
  readonly #monitored = new WeakSet<RequestSender>();
  readonly #stop: (requestId: string) => void;

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
    if (sender) this.#monitor(sender);
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

  #monitor(sender: RequestSender): void {
    if (this.#monitored.has(sender)) return;
    this.#monitored.add(sender);
    const senderId = sender.id;
    const cancelOwnedRequests = () => this.#cancelForSender(senderId);
    const cancelForNavigation = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
      if (details.isMainFrame && !details.isSameDocument) cancelOwnedRequests();
    };
    sender.on("render-process-gone", cancelOwnedRequests);
    sender.on("did-start-navigation", cancelForNavigation);
    sender.once("destroyed", () => {
      cancelOwnedRequests();
      sender.removeListener("render-process-gone", cancelOwnedRequests);
      sender.removeListener("did-start-navigation", cancelForNavigation);
    });
  }
}
