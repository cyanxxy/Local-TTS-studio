// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { SerialTaskQueue, SharedTask, SharedTaskGroup, type SharedTaskContext } from "./audio8SharedTask";

function cancelled(): Error {
  return new Error("cancelled");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

describe("SharedTask", () => {
  it("runs the body once for every caller that joins in flight", async () => {
    const gate = deferred<string>();
    const body = vi.fn(() => gate.promise);
    const task = new SharedTask<string>(cancelled);

    const first = task.run(body);
    const second = task.run(body);
    gate.resolve("loaded");

    await expect(first).resolves.toBe("loaded");
    await expect(second).resolves.toBe("loaded");
    expect(body).toHaveBeenCalledTimes(1);
  });

  it("starts a new run once the previous one has settled", async () => {
    const body = vi.fn(() => Promise.resolve("loaded"));
    const task = new SharedTask<string>(cancelled);

    await task.run(body);
    expect(task.running).toBe(false);
    await task.run(body);

    expect(body).toHaveBeenCalledTimes(2);
  });

  it("fans progress out to every participant", async () => {
    const gate = deferred<void>();
    let report: ((percent: number) => void) | undefined;
    const task = new SharedTask<void, number>(cancelled);
    const body = (context: SharedTaskContext<number>) => {
      report = context.report;
      return gate.promise;
    };
    const first: number[] = [];
    const second: number[] = [];

    const firstRun = task.run(body, { onProgress: (percent) => first.push(percent) });
    report?.(10);
    const secondRun = task.run(body, { onProgress: (percent) => second.push(percent) });
    report?.(20);
    gate.resolve();
    await Promise.all([firstRun, secondRun]);

    expect(first).toEqual([10, 20]);
    expect(second).toEqual([20]);
  });

  it("abandons a participant without disturbing the others", async () => {
    const gate = deferred<string>();
    let taskSignal: AbortSignal | undefined;
    const task = new SharedTask<string>(cancelled);
    const body = (context: SharedTaskContext<never>) => {
      taskSignal = context.signal;
      return gate.promise;
    };
    const controller = new AbortController();

    const leaving = task.run(body, { signal: controller.signal });
    const staying = task.run(body);
    controller.abort();

    await expect(leaving).rejects.toThrow("cancelled");
    expect(taskSignal?.aborted).toBe(false);
    gate.resolve("loaded");
    await expect(staying).resolves.toBe("loaded");
  });

  it("aborts the shared work once the last participant leaves", async () => {
    const gate = deferred<string>();
    let taskSignal: AbortSignal | undefined;
    const task = new SharedTask<string>(cancelled);
    const body = (context: SharedTaskContext<never>) => {
      taskSignal = context.signal;
      context.signal.addEventListener("abort", () => gate.reject(cancelled()));
      return gate.promise;
    };
    const first = new AbortController();
    const second = new AbortController();

    const firstRun = task.run(body, { signal: first.signal });
    const secondRun = task.run(body, { signal: second.signal });
    first.abort();
    expect(taskSignal?.aborted).toBe(false);
    second.abort();

    await expect(firstRun).rejects.toThrow("cancelled");
    await expect(secondRun).rejects.toThrow("cancelled");
    expect(taskSignal?.aborted).toBe(true);
  });

  it("waits for abandoned work to unwind before starting a retry", async () => {
    const abandoned = deferred<string>();
    const retried = deferred<string>();
    const firstController = new AbortController();
    const firstBody = vi.fn(() => abandoned.promise);
    const retryBody = vi.fn(() => retried.promise);
    const task = new SharedTask<string>(cancelled);

    const first = task.run(firstBody, { signal: firstController.signal });
    firstController.abort();
    await expect(first).rejects.toThrow("cancelled");
    const retry = task.run(retryBody);
    await Promise.resolve();
    expect(retryBody).not.toHaveBeenCalled();

    abandoned.reject(cancelled());
    await vi.waitFor(() => expect(retryBody).toHaveBeenCalledTimes(1));
    retried.resolve("loaded");
    await expect(retry).resolves.toBe("loaded");
  });

  it("rejects a caller that has already given up before joining", async () => {
    const body = vi.fn(() => Promise.resolve("loaded"));
    const task = new SharedTask<string>(cancelled);

    await expect(task.run(body, { signal: AbortSignal.abort() })).rejects.toThrow("cancelled");
    expect(body).not.toHaveBeenCalled();
  });

  it("reports a failed run to every participant and allows a retry", async () => {
    const gate = deferred<string>();
    const task = new SharedTask<string>(cancelled);
    const failing = () => gate.promise;

    const first = task.run(failing);
    const second = task.run(failing);
    gate.reject(new Error("download failed"));

    await expect(first).rejects.toThrow("download failed");
    await expect(second).rejects.toThrow("download failed");
    await expect(task.run(() => Promise.resolve("loaded"))).resolves.toBe("loaded");
  });

  it("surfaces a body that throws synchronously as a rejection", async () => {
    const task = new SharedTask<string>(cancelled);

    await expect(task.run(() => {
      throw new Error("no model directory");
    })).rejects.toThrow("no model directory");
  });
});

describe("SharedTaskGroup", () => {
  it("shares work per key and keeps different keys independent", async () => {
    const gates = new Map([["a", deferred<string>()], ["b", deferred<string>()]]);
    const body = vi.fn((key: string) => () => gates.get(key)!.promise);
    const group = new SharedTaskGroup<string>(cancelled);

    const firstA = group.run("a", body("a"));
    const secondA = group.run("a", body("a"));
    const firstB = group.run("b", body("b"));
    gates.get("a")!.resolve("A");
    gates.get("b")!.resolve("B");

    await expect(Promise.all([firstA, secondA, firstB])).resolves.toEqual(["A", "A", "B"]);
    // Two bodies were created, but only one per key was ever invoked.
    expect(body).toHaveBeenCalledTimes(3);
  });

  it("forgets a settled key so the next caller starts fresh", async () => {
    const body = vi.fn(() => Promise.resolve("done"));
    const group = new SharedTaskGroup<string>(cancelled);

    await group.run("a", body);
    await group.run("a", body);

    expect(body).toHaveBeenCalledTimes(2);
  });

  it("keeps a restarted key alive when a previous participant settles late", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const group = new SharedTaskGroup<string>(cancelled);

    const initial = group.run("a", () => first.promise);
    first.reject(new Error("stalled"));
    await expect(initial).rejects.toThrow("stalled");

    const restarted = group.run("a", () => second.promise);
    const joined = group.run("a", () => Promise.resolve("never used"));
    second.resolve("done");

    await expect(restarted).resolves.toBe("done");
    await expect(joined).resolves.toBe("done");
  });
});

describe("SerialTaskQueue", () => {
  it("does not overlap heavyweight inference jobs", async () => {
    const queue = new SerialTaskQueue();
    const firstGate = deferred<void>();
    const order: string[] = [];

    const first = queue.run(async () => {
      order.push("first:start");
      await firstGate.promise;
      order.push("first:end");
    });
    const second = queue.run(async () => {
      order.push("second:start");
    });
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    firstGate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("continues after a failed job", async () => {
    const queue = new SerialTaskQueue();
    await expect(queue.run(() => Promise.reject(new Error("cancelled")))).rejects.toThrow("cancelled");
    await expect(queue.run(() => Promise.resolve("next"))).resolves.toBe("next");
  });
});
