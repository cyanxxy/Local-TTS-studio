import { afterEach, describe, expect, it, vi } from "vitest";
import { createGenerationController, type GenerationTicket } from "./generation";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A generation task that holds the model until `release()` is called. */
function blockingTask() {
  const gate = deferred();
  const state = { started: false, finished: false, ticket: null as GenerationTicket | null };
  const task = async (ticket: GenerationTicket) => {
    state.started = true;
    state.ticket = ticket;
    await gate.promise;
    state.finished = true;
  };
  return { release: gate.resolve, state, task };
}

describe("createGenerationController", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts an idle task synchronously and queues later tasks until it settles", async () => {
    const generations = createGenerationController();
    const first = blockingTask();
    const second = blockingTask();

    void generations.run("a", first.task);
    expect(first.state.started).toBe(true);

    void generations.run("b", second.task);
    await flushPromises();
    expect(second.state.started).toBe(false);

    first.release();
    await flushPromises();
    expect(first.state.finished).toBe(true);
    expect(second.state.started).toBe(true);
  });

  it("supersedes the previous generation as soon as a new one starts", () => {
    const generations = createGenerationController();
    const first = blockingTask();

    void generations.run("a", first.task);
    expect(first.state.ticket?.isCurrent()).toBe(true);
    void generations.run("b", blockingTask().task);
    expect(first.state.ticket?.isCurrent()).toBe(false);
  });

  it("never runs a generation that was superseded while it waited", async () => {
    const generations = createGenerationController();
    const first = blockingTask();
    const skipped = vi.fn(async () => undefined);
    const last = blockingTask();

    void generations.run("a", first.task);
    void generations.run("b", skipped);
    void generations.run("c", last.task);
    first.release();
    await flushPromises();

    expect(skipped).not.toHaveBeenCalled();
    expect(last.state.started).toBe(true);
    expect(last.state.ticket?.generationId).toBe("c");
  });

  it("aborts the current generation and resolves only once it has settled", async () => {
    const generations = createGenerationController();
    const first = blockingTask();
    void generations.run("a", first.task);

    let aborted = false;
    void generations.abort("a").then(() => {
      aborted = true;
    });
    expect(first.state.ticket?.isCurrent()).toBe(false);
    await flushPromises();
    expect(aborted).toBe(false);

    first.release();
    await flushPromises();
    expect(aborted).toBe(true);
  });

  it("ignores a stale abort for a generation that was already superseded", async () => {
    const generations = createGenerationController();
    const first = blockingTask();
    const second = blockingTask();
    void generations.run("a", first.task);
    void generations.run("b", second.task);

    let staleAborted = false;
    void generations.abort("a").then(() => {
      staleAborted = true;
    });
    first.release();
    await flushPromises();

    // The stale abort waits only for "a" and never cancels "b".
    expect(staleAborted).toBe(true);
    expect(second.state.started).toBe(true);
    expect(second.state.ticket?.isCurrent()).toBe(true);
  });

  it("resolves an abort immediately when no pending generation matches", async () => {
    const generations = createGenerationController();
    await expect(generations.abort()).resolves.toBeUndefined();
    await expect(generations.abort("missing")).resolves.toBeUndefined();

    const done = blockingTask();
    void generations.run("a", done.task);
    done.release();
    await flushPromises();
    await expect(generations.abort("a")).resolves.toBeUndefined();
  });

  it("aborts the latest generation when the abort names none", async () => {
    const generations = createGenerationController();
    const first = blockingTask();
    void generations.run(undefined, first.task);

    const aborted = generations.abort();
    expect(first.state.ticket?.isCurrent()).toBe(false);
    first.release();
    await expect(aborted).resolves.toBeUndefined();
  });

  it("invalidates every generation and reports when the model is idle", async () => {
    const generations = createGenerationController();
    const first = blockingTask();
    void generations.run("a", first.task);

    generations.invalidate();
    expect(first.state.ticket?.isCurrent()).toBe(false);

    let idle = false;
    void generations.idle().then(() => {
      idle = true;
    });
    await flushPromises();
    expect(idle).toBe(false);
    first.release();
    await flushPromises();
    expect(idle).toBe(true);
  });

  it("keeps serving generations after a task rejects unexpectedly", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const generations = createGenerationController();
    const next = vi.fn(async () => undefined);

    await expect(generations.run("a", async () => {
      throw new Error("unhandled");
    })).resolves.toBeUndefined();
    await generations.run("b", next);

    expect(consoleError).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
  });
});
