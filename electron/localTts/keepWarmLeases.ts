import type { LocalModel } from "../localTtsIpc";
import { createSenderWatcher, type RequestSender } from "./senderLifecycle";

// A window holding more leases than this is leaking them.
export const MAX_KEEP_WARM_LEASES_PER_SENDER = 8;

interface Lease {
  model: LocalModel;
  targetKey: string;
}

/**
 * Renderer leases that keep a selected model resident. A lease names one
 * model target (see warmTargetKey); while any lease names what a worker has
 * loaded, that worker idles for the longer keep-warm window instead of the
 * model's usual one. Lease ids are the renderer's own and are scoped to it,
 * and a renderer that crashes, navigates or closes drops all of its leases.
 *
 * `onChange(model)` runs after every change that can affect `model`, so its
 * idle worker can be re-timed.
 */
export class KeepWarmLeases {
  readonly #bySender = new Map<number, Map<string, Lease>>();
  readonly #onChange: (model: LocalModel) => void;
  readonly #watch = createSenderWatcher((senderId) => this.#releaseSender(senderId));

  constructor(onChange: (model: LocalModel) => void) {
    this.#onChange = onChange;
  }

  /** Takes out, or renews, the sender's lease `leaseId` on `targetKey`. */
  acquire(sender: RequestSender, leaseId: string, model: LocalModel, targetKey: string): void {
    const leases = this.#bySender.get(sender.id) ?? new Map<string, Lease>();
    const previous = leases.get(leaseId);
    if (!previous && leases.size >= MAX_KEEP_WARM_LEASES_PER_SENDER) {
      throw new Error(`A window can hold at most ${MAX_KEEP_WARM_LEASES_PER_SENDER} keep-warm leases.`);
    }
    this.#watch(sender);
    leases.set(leaseId, { model, targetKey });
    this.#bySender.set(sender.id, leases);
    if (previous && previous.model !== model) this.#onChange(previous.model);
    this.#onChange(model);
  }

  /** Drops the sender's lease `leaseId`; false when it holds no such lease. */
  release(senderId: number, leaseId: string): boolean {
    const leases = this.#bySender.get(senderId);
    const lease = leases?.get(leaseId);
    if (!leases || !lease) return false;
    leases.delete(leaseId);
    if (leases.size === 0) this.#bySender.delete(senderId);
    this.#onChange(lease.model);
    return true;
  }

  /** Whether any lease keeps `model` resident while it holds `targetKey`. */
  covers(model: LocalModel, targetKey: string | null): boolean {
    if (targetKey === null) return false;
    for (const leases of this.#bySender.values()) {
      for (const lease of leases.values()) {
        if (lease.model === model && lease.targetKey === targetKey) return true;
      }
    }
    return false;
  }

  #releaseSender(senderId: number): void {
    const leases = this.#bySender.get(senderId);
    if (!leases) return;
    this.#bySender.delete(senderId);
    for (const model of new Set([...leases.values()].map((lease) => lease.model))) {
      this.#onChange(model);
    }
  }
}
