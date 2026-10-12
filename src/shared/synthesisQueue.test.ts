import { describe, expect, it, vi } from "vitest";
import { createAbortError, createAsyncChannel, isAbortError, type AsyncChannel } from "./asyncChannel";
import { SynthesisQueue } from "./synthesisQueue";

/** A task whose chunks the test pushes by hand, and which honours its signal. */
function controllableTask() {
  let channel: AsyncChannel<string> | null = null;
  const started = vi.fn();
  const stopped = vi.fn();
  const task = (signal: AbortSignal) => {
    started();
    const output = createAsyncChannel<string>();
    channel = output;
    signal.addEventListener("abort", () => {
      stopped();
      output.fail(signal.reason);
    }, { once: true });
    return output;
  };
  return {
    task,
    started,
    stopped,
    push: (value: string) => channel?.push(value),
    finish: () => channel?.close(),
    fail: (error: unknown) => channel?.fail(error),
  };
}

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const values: string[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

/** Lets queued microtasks (task start, channel hand-offs) run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("SynthesisQueue", () => {
  it("runs requests one at a time in the order they were made", async () => {
    const queue = new SynthesisQueue<string>();
    const first = controllableTask();
    const second = controllableTask();
    const firstResult = collect(queue.enqueue(first.task));
    const secondResult = collect(queue.enqueue(second.task));

    expect(first.started).toHaveBeenCalledOnce();
    expect(second.started).not.toHaveBeenCalled();
    expect(queue.busy).toBe(true);
    expect(queue.waiting).toBe(1);

    first.push("first-a");
    first.push("first-b");
    first.finish();
    await expect(firstResult).resolves.toEqual(["first-a", "first-b"]);
    await settle();
    expect(second.started).toHaveBeenCalledOnce();
    expect(queue.waiting).toBe(0);

    second.push("second-a");
    second.finish();
    await expect(secondResult).resolves.toEqual(["second-a"]);
    await settle();
    expect(queue.busy).toBe(false);
  });

  it("buffers a request nobody reads so later requests still run", async () => {
    const queue = new SynthesisQueue<string>();
    const unread = controllableTask();
    const next = controllableTask();
    queue.enqueue(unread.task);
    const result = collect(queue.enqueue(next.task));

    unread.push("ignored");
    unread.finish();
    await settle();
    next.push("ok");
    next.finish();
    await expect(result).resolves.toEqual(["ok"]);
  });

  it("removes an aborted waiting request without disturbing the order", async () => {
    const queue = new SynthesisQueue<string>();
    const running = controllableTask();
    const aborted = controllableTask();
    const last = controllableTask();
    const controller = new AbortController();
    queue.enqueue(running.task);
    const abortedResult = collect(queue.enqueue(aborted.task, controller.signal));
    const lastResult = collect(queue.enqueue(last.task));

    const reason = createAbortError("Preview closed.");
    controller.abort(reason);
    await expect(abortedResult).rejects.toBe(reason);
    expect(queue.waiting).toBe(1);

    running.finish();
    await settle();
    expect(aborted.started).not.toHaveBeenCalled();
    expect(last.started).toHaveBeenCalledOnce();
    last.finish();
    await expect(lastResult).resolves.toEqual([]);
  });

  it("stops a running request on abort and starts the next one after it winds down", async () => {
    const queue = new SynthesisQueue<string>();
    const running = controllableTask();
    const next = controllableTask();
    const controller = new AbortController();
    const runningResult = collect(queue.enqueue(running.task, controller.signal));
    queue.enqueue(next.task);
    running.push("partial");
    await settle();

    controller.abort();
    expect(running.stopped).toHaveBeenCalledOnce();
    await expect(runningResult).rejects.toSatisfy(isAbortError);
    await settle();
    expect(next.started).toHaveBeenCalledOnce();
  });

  it("rejects at once for an already-aborted signal without running the task", async () => {
    const queue = new SynthesisQueue<string>();
    const task = controllableTask();
    const reason = new Error("Too late.");

    await expect(collect(queue.enqueue(task.task, AbortSignal.abort(reason)))).rejects.toBe(reason);
    expect(task.started).not.toHaveBeenCalled();
    expect(queue.busy).toBe(false);
  });

  it("surfaces a task failure on that request only", async () => {
    const queue = new SynthesisQueue<string>();
    const failing = controllableTask();
    const next = controllableTask();
    const failingResult = collect(queue.enqueue(failing.task));
    const nextResult = collect(queue.enqueue(next.task));
    const error = new Error("Model not loaded yet");

    failing.fail(error);
    await expect(failingResult).rejects.toBe(error);
    await settle();
    next.push("fine");
    next.finish();
    await expect(nextResult).resolves.toEqual(["fine"]);
  });

  it("treats a task that throws before streaming as a failed request", async () => {
    const queue = new SynthesisQueue<string>();
    const error = new Error("No worker.");
    const result = collect(queue.enqueue((): AsyncIterable<string> => {
      throw error;
    }));

    await expect(result).rejects.toBe(error);
  });

  it("aborts the task when the reader stops early", async () => {
    const queue = new SynthesisQueue<string>();
    const task = controllableTask();
    const stream = queue.enqueue(task.task);
    task.push("first");
    task.push("second");

    for await (const chunk of stream) {
      expect(chunk).toBe("first");
      break;
    }
    expect(task.stopped).toHaveBeenCalledOnce();
    await settle();
    expect(queue.busy).toBe(false);
  });

  it("ignores chunks a task yields after its signal aborted", async () => {
    const queue = new SynthesisQueue<string>();
    const controller = new AbortController();
    const result = collect(queue.enqueue(async function* (signal) {
      controller.abort();
      yield signal.aborted ? "late" : "early";
    }, controller.signal));

    await expect(result).rejects.toSatisfy(isAbortError);
  });

  it("holds requests while the surface generation runs", async () => {
    const queue = new SynthesisQueue<string>();
    const task = controllableTask();
    queue.setForegroundBusy(true);
    queue.setForegroundBusy(true);
    queue.enqueue(task.task);

    expect(task.started).not.toHaveBeenCalled();
    expect(queue.busy).toBe(false);
    queue.setForegroundBusy(false);
    expect(task.started).toHaveBeenCalledOnce();
    expect(queue.busy).toBe(true);
  });

  it("notifies subscribers when it becomes busy and idle", async () => {
    const queue = new SynthesisQueue<string>();
    const listener = vi.fn(() => queue.getBusy());
    const unsubscribe = queue.subscribe(listener);
    const task = controllableTask();
    queue.enqueue(task.task);
    task.finish();
    await settle();

    expect(listener.mock.results.map((entry) => entry.value)).toEqual([true, false]);
    unsubscribe();
    queue.enqueue(controllableTask().task);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("aborts every queued and running request", async () => {
    const queue = new SynthesisQueue<string>();
    const running = controllableTask();
    const waiting = controllableTask();
    const runningResult = collect(queue.enqueue(running.task));
    const waitingResult = collect(queue.enqueue(waiting.task));

    queue.abortAll();
    await expect(runningResult).rejects.toSatisfy(isAbortError);
    await expect(waitingResult).rejects.toSatisfy(isAbortError);
    expect(waiting.started).not.toHaveBeenCalled();

    const reason = new Error("Unmounted.");
    const later = collect(queue.enqueue(controllableTask().task));
    await settle();
    queue.abortAll(reason);
    await expect(later).rejects.toBe(reason);
    queue.abortAll();
  });
});
