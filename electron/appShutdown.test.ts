// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { createShutdownCoordinator, type ShutdownParticipant } from "./appShutdown";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function participant(name: string, work: () => Promise<unknown> | null): ShutdownParticipant & { calls: number } {
  const entry = {
    name,
    calls: 0,
    beginShutdown: () => {
      entry.calls += 1;
      return work();
    },
  };
  return entry;
}

async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createShutdownCoordinator", () => {
  it("lets the quit proceed untouched when nothing is outstanding", () => {
    const quit = vi.fn();
    const coordinator = createShutdownCoordinator({ timeoutMs: 1_000, quit });
    const idle = participant("idle", () => null);
    coordinator.register(idle);
    const event = { preventDefault: vi.fn() };

    coordinator.handleBeforeQuit(event);

    expect(idle.calls).toBe(1);
    expect(coordinator.shuttingDown).toBe(true);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });

  it("starts every participant in registration order within the same turn", () => {
    const order: string[] = [];
    const coordinator = createShutdownCoordinator({ timeoutMs: 1_000, quit: vi.fn() });
    for (const name of ["reader", "documents", "runtime"]) {
      coordinator.register(participant(name, () => {
        order.push(name);
        return null;
      }));
    }

    coordinator.handleBeforeQuit({ preventDefault: vi.fn() });

    expect(order).toEqual(["reader", "documents", "runtime"]);
  });

  it("holds the quit until every participant settles, then quits once", async () => {
    const quit = vi.fn();
    const coordinator = createShutdownCoordinator({ timeoutMs: 60_000, quit });
    const first = deferred();
    const second = deferred();
    coordinator.register(participant("first", () => first.promise));
    coordinator.register(participant("second", () => second.promise));
    const event = { preventDefault: vi.fn() };

    coordinator.handleBeforeQuit(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);

    first.resolve();
    await flushMicrotasks();
    expect(quit).not.toHaveBeenCalled();

    second.resolve();
    await flushMicrotasks();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("ignores the before-quit its own quit triggers", async () => {
    const quit = vi.fn();
    const coordinator = createShutdownCoordinator({ timeoutMs: 60_000, quit });
    const work = participant("work", () => Promise.resolve());
    coordinator.register(work);

    coordinator.handleBeforeQuit({ preventDefault: vi.fn() });
    await flushMicrotasks();
    const reentrant = { preventDefault: vi.fn() };
    coordinator.handleBeforeQuit(reentrant);

    expect(work.calls).toBe(1);
    expect(reentrant.preventDefault).not.toHaveBeenCalled();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("holds a second quit that arrives while the barrier is still waiting", async () => {
    vi.useFakeTimers();
    const quit = vi.fn();
    const coordinator = createShutdownCoordinator({ timeoutMs: 2_500, quit });
    const flush = deferred();
    coordinator.register(participant("reader-library", () => flush.promise));
    coordinator.handleBeforeQuit({ preventDefault: vi.fn() });

    // The user presses Cmd+Q again (or closes the last window) 300 ms later.
    await vi.advanceTimersByTimeAsync(300);
    const second = { preventDefault: vi.fn() };
    coordinator.handleBeforeQuit(second);

    expect(second.preventDefault).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
    flush.resolve();
    await flushMicrotasks();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("keeps holding while it finishes up, then lets only its own quit through", async () => {
    const quit = vi.fn();
    const finished = deferred();
    const finish = vi.fn(() => finished.promise);
    const coordinator = createShutdownCoordinator({ timeoutMs: 60_000, quit, finish });
    coordinator.register(participant("work", () => Promise.resolve()));

    coordinator.handleBeforeQuit({ preventDefault: vi.fn() });
    await flushMicrotasks();
    expect(finish).toHaveBeenCalledTimes(1);
    const duringFinish = { preventDefault: vi.fn() };
    coordinator.handleBeforeQuit(duringFinish);
    expect(duringFinish.preventDefault).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();

    finished.resolve();
    await flushMicrotasks();
    expect(quit).toHaveBeenCalledTimes(1);
    const own = { preventDefault: vi.fn() };
    coordinator.handleBeforeQuit(own);
    expect(own.preventDefault).not.toHaveBeenCalled();
  });

  it("still quits when finishing up fails", async () => {
    const quit = vi.fn();
    const coordinator = createShutdownCoordinator({
      timeoutMs: 60_000,
      quit,
      finish: () => Promise.reject(new Error("log disk full")),
    });
    coordinator.register(participant("work", () => Promise.resolve()));

    coordinator.handleBeforeQuit({ preventDefault: vi.fn() });
    await new Promise((resolve) => setImmediate(resolve));

    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("never holds a later quit when nothing was outstanding", () => {
    const coordinator = createShutdownCoordinator({ timeoutMs: 1_000, quit: vi.fn() });
    coordinator.register(participant("idle", () => null));
    coordinator.handleBeforeQuit({ preventDefault: vi.fn() });

    const again = { preventDefault: vi.fn() };
    coordinator.handleBeforeQuit(again);

    expect(again.preventDefault).not.toHaveBeenCalled();
  });

  it("quits at the timeout when a participant never settles", async () => {
    vi.useFakeTimers();
    const quit = vi.fn();
    const coordinator = createShutdownCoordinator({ timeoutMs: 2_500, quit });
    coordinator.register(participant("wedged", () => new Promise(() => undefined)));

    coordinator.handleBeforeQuit({ preventDefault: vi.fn() });
    await vi.advanceTimersByTimeAsync(2_499);
    expect(quit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("keeps waiting for the others when one participant's work rejects", async () => {
    const quit = vi.fn();
    const onParticipantError = vi.fn();
    const coordinator = createShutdownCoordinator({ timeoutMs: 60_000, quit, onParticipantError });
    const failure = new Error("close failed");
    const slow = deferred();
    coordinator.register(participant("failing", () => Promise.reject(failure)));
    coordinator.register(participant("slow", () => slow.promise));

    coordinator.handleBeforeQuit({ preventDefault: vi.fn() });
    await flushMicrotasks();

    expect(onParticipantError).toHaveBeenCalledWith("failing", failure);
    expect(quit).not.toHaveBeenCalled();
    slow.resolve();
    await flushMicrotasks();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("still starts later participants when one throws synchronously", async () => {
    const quit = vi.fn();
    const onParticipantError = vi.fn();
    const coordinator = createShutdownCoordinator({ timeoutMs: 60_000, quit, onParticipantError });
    const failure = new Error("latch failed");
    coordinator.register(participant("throwing", () => {
      throw failure;
    }));
    const later = participant("later", () => Promise.resolve());
    coordinator.register(later);

    coordinator.handleBeforeQuit({ preventDefault: vi.fn() });
    await flushMicrotasks();

    expect(onParticipantError).toHaveBeenCalledWith("throwing", failure);
    expect(later.calls).toBe(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("quits even when error reporting itself throws", async () => {
    const quit = vi.fn();
    const coordinator = createShutdownCoordinator({
      timeoutMs: 60_000,
      quit,
      onParticipantError: () => {
        throw new Error("logger down");
      },
    });
    coordinator.register(participant("failing", () => Promise.reject(new Error("close failed"))));

    coordinator.handleBeforeQuit({ preventDefault: vi.fn() });
    await flushMicrotasks();

    expect(quit).toHaveBeenCalledTimes(1);
  });
});
