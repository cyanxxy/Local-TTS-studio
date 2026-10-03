// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { LocalModelLifecycle } from "./localModelLifecycle";

function deferred() {
  let resolve!: () => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function drain(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("LocalModelLifecycle", () => {
  it("cancels and joins active users before deletion, then admits new work", async () => {
    const lifecycle = new LocalModelLifecycle<string>();
    const stopped = deferred();
    const deleted = deferred();
    let signal!: AbortSignal;
    const first = lifecycle.run("qwen3", async (value) => { signal = value; await stopped.promise; });
    const remove = vi.fn(() => deleted.promise);
    const clearing = lifecycle.clear("qwen3", remove);
    const next = vi.fn(async () => "ready");
    const second = lifecycle.run("qwen3", next);

    expect(signal.aborted).toBe(true);
    await drain();
    expect(remove).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    stopped.resolve();
    await first;
    await drain();
    expect(remove).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
    deleted.resolve();
    await clearing;
    await expect(second).resolves.toBe("ready");
    expect(lifecycle.busy).toBe(false);
  });

  it("keeps consecutive clears exclusive even if the first deletion fails", async () => {
    const lifecycle = new LocalModelLifecycle<string>();
    const one = deferred();
    const two = deferred();
    const first = lifecycle.clear("qwen3", () => one.promise).catch(() => "failed");
    const secondRemove = vi.fn(() => two.promise);
    const second = lifecycle.clear("qwen3", secondRemove);
    const body = vi.fn(async () => "ready");
    const operation = lifecycle.run("qwen3", body);
    one.reject(new Error("unlink failed"));
    await expect(first).resolves.toBe("failed");
    await drain();
    expect(secondRemove).toHaveBeenCalledOnce();
    expect(body).not.toHaveBeenCalled();
    two.resolve();
    await second;
    await expect(operation).resolves.toBe("ready");
  });

  it("allows independent models and closes the gate before cancellation callbacks", async () => {
    const lifecycle = new LocalModelLifecycle<string>();
    const stopped = deferred();
    let nested: Promise<void> | undefined;
    const nestedBody = vi.fn(async () => undefined);
    const first = lifecycle.run("qwen3", async (signal) => {
      signal.addEventListener("abort", () => { nested = lifecycle.run("qwen3", nestedBody); });
      await stopped.promise;
    });
    const clearing = lifecycle.clear("qwen3", async () => undefined);
    await expect(lifecycle.run("neutts", async () => "independent")).resolves.toBe("independent");
    expect(nestedBody).not.toHaveBeenCalled();
    stopped.resolve();
    await Promise.all([first, clearing]);
    await nested;
    expect(nestedBody).toHaveBeenCalledOnce();
  });

  it("joins deletion at quit and refuses both queued and newly submitted work", async () => {
    const lifecycle = new LocalModelLifecycle<string>();
    const deleted = deferred();
    const clearing = lifecycle.clear("qwen3", () => deleted.promise);
    const body = vi.fn(async () => undefined);
    const queued = lifecycle.run("qwen3", body).catch((error: Error) => error.message);
    let closed = false;
    const closing = lifecycle.close().then(() => { closed = true; });
    await drain();
    expect(closed).toBe(false);
    expect(() => lifecycle.clear("qwen3", async () => undefined)).toThrow("shutting down");
    await expect(lifecycle.run("neutts", body)).rejects.toThrow("shutting down");
    deleted.resolve();
    await Promise.all([clearing, closing]);
    await expect(queued).resolves.toContain("shutting down");
    expect(body).not.toHaveBeenCalled();
  });
});
