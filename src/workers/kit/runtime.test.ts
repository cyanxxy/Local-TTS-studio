import { describe, expect, it, vi } from "vitest";
import type { WorkerOutMessage } from "../../types";
import type { GenerationTicket } from "./generation";
import type { WorkerPort } from "./protocol";
import { createSerialQueue, createWorkerRuntime, type GenerateMessage } from "./runtime";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createPort() {
  const posted: WorkerOutMessage[] = [];
  const port: WorkerPort = {
    post: (message) => posted.push(message),
    postError: (scope, error, generationId) => posted.push({
      type: "ERROR",
      message: error instanceof Error ? error.message : String(error),
      scope,
      ...(scope === "generate" && generationId !== undefined ? { generationId } : {}),
    }),
  };
  return { port, posted };
}

const generateMessage = (generationId: string): GenerateMessage => ({
  type: "GENERATE",
  generationId,
  text: "Hello there.",
  voice: "af_heart",
  speed: 1,
  quality: 5,
});

describe("createSerialQueue", () => {
  it("runs tasks one at a time and keeps going after a failure", async () => {
    const queue = createSerialQueue();
    const order: string[] = [];
    const first = deferred();

    const a = queue.run(async () => {
      order.push("a:start");
      await first.promise;
      order.push("a:end");
    });
    const b = queue.run(async () => {
      order.push("b");
      throw new Error("b failed");
    });
    const c = queue.run(async () => {
      order.push("c");
      return "c result";
    });

    await flushPromises();
    expect(order).toEqual(["a:start"]);
    first.resolve();
    await a;
    await expect(b).rejects.toThrow("b failed");
    await expect(c).resolves.toBe("c result");
    expect(order).toEqual(["a:start", "a:end", "b", "c"]);
  });
});

describe("createWorkerRuntime", () => {
  it("serializes LOAD requests and reports load failures with the load scope", async () => {
    const { port, posted } = createPort();
    const firstLoad = deferred();
    const load = vi.fn()
      .mockImplementationOnce(() => firstLoad.promise)
      .mockImplementationOnce(async () => {
        throw new Error("download failed");
      });
    const runtime = createWorkerRuntime({ load, generate: vi.fn() }, { port, close: vi.fn() });

    runtime.handleMessage({ type: "LOAD" });
    runtime.handleMessage({ type: "LOAD", forceReload: true });
    await flushPromises();
    expect(load).toHaveBeenCalledOnce();

    firstLoad.resolve();
    await flushPromises();
    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenLastCalledWith({ type: "LOAD", forceReload: true });
    expect(posted).toEqual([{ type: "ERROR", message: "download failed", scope: "load" }]);
  });

  it("reports generate errors with their id only while the generation is current", async () => {
    const { port, posted } = createPort();
    const stale = deferred();
    const generate = vi.fn(async (message: GenerateMessage) => {
      if (message.generationId === "stale") await stale.promise;
      throw new Error(`${message.generationId} failed`);
    });
    const runtime = createWorkerRuntime({ load: vi.fn(), generate }, { port, close: vi.fn() });

    runtime.handleMessage(generateMessage("stale"));
    runtime.handleMessage(generateMessage("fresh"));
    stale.reject(new Error("stale failed"));
    await flushPromises();

    expect(posted).toEqual([
      { type: "ERROR", message: "fresh failed", scope: "generate", generationId: "fresh" },
    ]);
  });

  it("starts the next generation only after the previous one settled", async () => {
    const { port } = createPort();
    const first = deferred();
    const events: string[] = [];
    const generate = vi.fn(async (message: GenerateMessage) => {
      events.push(`${message.generationId}:start`);
      if (message.generationId === "a") await first.promise;
      events.push(`${message.generationId}:end`);
    });
    const runtime = createWorkerRuntime({ load: vi.fn(), generate }, { port, close: vi.fn() });

    runtime.handleMessage(generateMessage("a"));
    runtime.handleMessage(generateMessage("b"));
    await flushPromises();
    expect(events).toEqual(["a:start"]);

    first.resolve();
    await flushPromises();
    // "b" superseded "a" but still waited for its in-flight inference.
    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("supersedes only the generations sent before a forced reload, as soon as it arrives", async () => {
    const { port } = createPort();
    const tickets = new Map<string, GenerationTicket>();
    const firstLoad = deferred();
    const before = deferred();
    const load = vi.fn()
      .mockImplementationOnce(() => firstLoad.promise)
      .mockImplementationOnce(async () => undefined);
    const runtime = createWorkerRuntime({
      load,
      generate: vi.fn(async (message: GenerateMessage, ticket: GenerationTicket) => {
        tickets.set(message.generationId!, ticket);
        await (message.generationId === "before" ? before.promise : new Promise<void>(() => undefined));
      }),
    }, { port, close: vi.fn() });

    runtime.handleMessage({ type: "LOAD" });
    runtime.handleMessage(generateMessage("before"));
    runtime.handleMessage({ type: "LOAD", forceReload: true });
    // Superseded on arrival, although the reload is queued behind the first load.
    expect(tickets.get("before")?.isCurrent()).toBe(false);

    runtime.handleMessage(generateMessage("after"));
    before.resolve();
    await flushPromises();
    expect(tickets.get("after")?.isCurrent()).toBe(true);

    firstLoad.resolve();
    await flushPromises();
    expect(load).toHaveBeenCalledTimes(2);
    // Running the reload later does not cut short what was sent after it.
    expect(tickets.get("after")?.isCurrent()).toBe(true);
  });

  it("hard-cancels by invalidating generations, posting CANCELLED, and closing", async () => {
    const { port, posted } = createPort();
    const close = vi.fn();
    const pending = deferred();
    const captured: { ticket: GenerationTicket | null } = { ticket: null };
    const runtime = createWorkerRuntime({
      load: vi.fn(),
      generate: vi.fn(async (_message: GenerateMessage, current: GenerationTicket) => {
        captured.ticket = current;
        await pending.promise;
      }),
    }, { port, close });

    runtime.handleMessage(generateMessage("a"));
    runtime.handleMessage({ type: "CANCEL" });

    expect(captured.ticket?.isCurrent()).toBe(false);
    expect(posted).toEqual([{ type: "CANCELLED" }]);
    expect(close).toHaveBeenCalledOnce();
  });
});
