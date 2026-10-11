// @vitest-environment node

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { SharedTaskContext } from "./sharedTask";
import {
  startNativeModelWorker,
  type NativeModelRequestContext,
  type NativeModelWorkerDefinition,
  type NativeModelWorkerPort,
} from "./workerHost";
import type { NativeModelWorkerResponse } from "./workerProtocol";

interface FakeRuntime {
  name: string;
}

interface FakeResult {
  ready?: boolean;
  text?: string;
  audio?: ArrayBuffer;
}

class FakePort extends EventEmitter implements NativeModelWorkerPort<FakeResult> {
  readonly sent: NativeModelWorkerResponse<FakeResult>[] = [];
  readonly transfers: (readonly ArrayBuffer[] | undefined)[] = [];

  postMessage(value: NativeModelWorkerResponse<FakeResult>, transfer?: readonly ArrayBuffer[]): void {
    this.sent.push(value);
    this.transfers.push(transfer);
  }

  receive(value: unknown): void {
    this.emit("message", value);
  }
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

/** Lets every pending microtask and the handlers' replies run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function loadCancelled(): Error {
  return new Error("Kitten model load cancelled.");
}

function harness(overrides: Partial<NativeModelWorkerDefinition<FakeRuntime, FakeResult>> = {}) {
  const port = new FakePort();
  const loads: SharedTaskContext<number>[] = [];
  const loadGate = deferred<FakeRuntime>();
  const load = vi.fn((context: SharedTaskContext<number>) => {
    loads.push(context);
    return loadGate.promise;
  });
  startNativeModelWorker<FakeRuntime, FakeResult>(port, {
    descriptor: { label: "Kitten" },
    load,
    loadCancelledError: loadCancelled,
    describeLoaded: (runtime) => ({ ready: true, text: runtime.name }),
    handlers: {
      speak: async (request, { loadRuntime }) => {
        const runtime = await loadRuntime();
        return { result: { text: `${runtime.name}:${String(request.text)}` } };
      },
    },
    ...overrides,
  });
  return { port, load, loads, loadGate };
}

describe("startNativeModelWorker", () => {
  it("builds the runtime once for every load in flight and answers each one", async () => {
    const { port, load, loadGate } = harness();

    port.receive({ type: "load", requestId: "load-1" });
    port.receive({ type: "load", requestId: "load-2" });
    loadGate.resolve({ name: "kitten" });
    await settle();

    expect(load).toHaveBeenCalledTimes(1);
    expect(port.sent).toEqual([
      { type: "result", requestId: "load-1", result: { ready: true, text: "kitten" } },
      { type: "result", requestId: "load-2", result: { ready: true, text: "kitten" } },
    ]);
  });

  it("keeps the runtime resident once it has loaded", async () => {
    const { port, load, loadGate } = harness();
    loadGate.resolve({ name: "kitten" });

    port.receive({ type: "load", requestId: "load-1" });
    await settle();
    port.receive({ type: "speak", requestId: "speak-1", text: "hi" });
    port.receive({ type: "load", requestId: "load-2" });
    await settle();

    expect(load).toHaveBeenCalledTimes(1);
    expect(port.sent).toContainEqual({ type: "result", requestId: "speak-1", result: { text: "kitten:hi" } });
    expect(port.sent).toContainEqual({ type: "result", requestId: "load-2", result: { ready: true, text: "kitten" } });
  });

  it("reports load progress under every request waiting on the load", async () => {
    const { port, loads, loadGate } = harness();

    port.receive({ type: "load", requestId: "load-1" });
    port.receive({ type: "speak", requestId: "speak-1", text: "hi" });
    await settle();
    loads[0].report(40);
    loadGate.resolve({ name: "kitten" });
    await settle();

    expect(port.sent.filter((message) => message.type === "progress")).toEqual([
      { type: "progress", requestId: "load-1", percent: 40 },
      { type: "progress", requestId: "speak-1", percent: 40 },
    ]);
  });

  it("routes a request's own progress to that request", async () => {
    const { port } = harness({
      load: () => Promise.resolve({ name: "kitten" }),
      handlers: {
        speak: async (_request, { report }) => {
          report(50);
          return { result: { text: "done" } };
        },
      },
    });

    port.receive({ type: "speak", requestId: "speak-1" });
    await settle();

    expect(port.sent).toEqual([
      { type: "progress", requestId: "speak-1", percent: 50 },
      { type: "result", requestId: "speak-1", result: { text: "done" } },
    ]);
  });

  it("moves transferred buffers rather than copying them", async () => {
    const audio = new ArrayBuffer(8);
    const { port } = harness({
      load: () => Promise.resolve({ name: "kitten" }),
      handlers: { speak: async () => ({ result: { audio }, transfer: [audio] }) },
    });

    port.receive({ type: "load", requestId: "load-1" });
    port.receive({ type: "speak", requestId: "speak-1" });
    await settle();

    const transferFor = (requestId: string) => port.transfers[port.sent.findIndex((message) => message.requestId === requestId)];
    expect(transferFor("load-1")).toEqual([]);
    expect(transferFor("speak-1")).toEqual([audio]);
    expect(transferFor("speak-1")?.[0]).toBe(audio);
  });

  it("runs the model's own requests one at a time, in arrival order", async () => {
    const gates = [deferred<void>(), deferred<void>()];
    const started: string[] = [];
    const { port } = harness({
      handlers: {
        speak: async (request) => {
          const index = Number(request.index);
          started.push(String(request.requestId));
          await gates[index].promise;
          return { result: { text: String(index) } };
        },
      },
    });

    port.receive({ type: "speak", requestId: "speak-0", index: 0 });
    port.receive({ type: "speak", requestId: "speak-1", index: 1 });
    await settle();
    expect(started).toEqual(["speak-0"]);

    gates[0].resolve();
    await settle();
    expect(started).toEqual(["speak-0", "speak-1"]);
    gates[1].resolve();
    await settle();

    expect(port.sent.map((message) => message.requestId)).toEqual(["speak-0", "speak-1"]);
  });

  it("aborts exactly the request a cancel names", async () => {
    const signals = new Map<string, AbortSignal>();
    const gate = deferred<void>();
    const { port } = harness({
      handlers: {
        speak: async (request, { signal }: NativeModelRequestContext<FakeRuntime>) => {
          signals.set(String(request.requestId), signal);
          await gate.promise;
          if (signal.aborted) throw new Error("Kitten synthesis cancelled.");
          return { result: { text: "spoken" } };
        },
      },
    });

    port.receive({ type: "speak", requestId: "speak-1" });
    await settle();
    port.receive({ type: "cancel", requestId: "speak-1" });
    port.receive({ type: "cancel", requestId: "never-sent" });
    gate.resolve();
    await settle();

    expect(signals.get("speak-1")?.aborted).toBe(true);
    expect(port.sent).toEqual([
      { type: "error", requestId: "speak-1", error: "Kitten synthesis cancelled." },
    ]);
  });

  it("abandons the load once its only caller cancels, and loads afresh next time", async () => {
    const { port, load, loads, loadGate } = harness();

    port.receive({ type: "load", requestId: "load-1" });
    await settle();
    port.receive({ type: "cancel", requestId: "load-1" });
    await settle();

    expect(loads[0].signal.aborted).toBe(true);
    expect(port.sent).toEqual([
      { type: "error", requestId: "load-1", error: "Kitten model load cancelled." },
    ]);

    loadGate.reject(new Error("Kitten model load cancelled."));
    await settle();
    port.receive({ type: "load", requestId: "load-2" });
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("answers a failed load with its error and retries the load on the next request", async () => {
    let attempts = 0;
    const { port } = harness({
      load: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("Kitten weights failed integrity verification.");
        return { name: "kitten" };
      },
    });

    port.receive({ type: "load", requestId: "load-1" });
    await settle();
    port.receive({ type: "load", requestId: "load-2" });
    await settle();

    expect(port.sent).toEqual([
      { type: "error", requestId: "load-1", error: "Kitten weights failed integrity verification." },
      { type: "result", requestId: "load-2", result: { ready: true, text: "kitten" } },
    ]);
  });

  it("answers unsupported request types, including inherited object keys", async () => {
    const { port } = harness();

    port.receive({ type: "sing", requestId: "odd-1" });
    port.receive({ type: "toString", requestId: "odd-2" });
    port.receive({ type: "__proto__", requestId: "odd-3" });
    port.receive({ type: 7, requestId: "odd-4" });
    await settle();

    expect(port.sent).toEqual([
      { type: "error", requestId: "odd-1", error: 'Unsupported Kitten request "sing".' },
      { type: "error", requestId: "odd-2", error: 'Unsupported Kitten request "toString".' },
      { type: "error", requestId: "odd-3", error: 'Unsupported Kitten request "__proto__".' },
      { type: "error", requestId: "odd-4", error: 'Unsupported Kitten request "7".' },
    ]);
  });

  it("reports a non-Error throw as text", async () => {
    const { port } = harness({
      handlers: {
        speak: () => Promise.reject("plain failure"),
      },
    });

    port.receive({ type: "speak", requestId: "speak-1" });
    await settle();

    expect(port.sent).toEqual([{ type: "error", requestId: "speak-1", error: "plain failure" }]);
  });

  it("ignores messages it cannot answer", async () => {
    const { port, load } = harness();

    port.receive(null);
    port.receive(["load"]);
    port.receive({ type: "load" });
    port.receive({ type: "load", requestId: 4 });
    await settle();

    expect(port.sent).toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });

  it("refuses a model that tries to redefine load or cancel", () => {
    for (const reserved of ["load", "cancel"]) {
      expect(() => harness({
        handlers: { [reserved]: async () => ({ result: {} }) },
      })).toThrow(`Kitten cannot redefine the "${reserved}" request.`);
    }
  });
});
