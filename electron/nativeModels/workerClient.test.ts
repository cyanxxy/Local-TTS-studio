// @vitest-environment node

import { EventEmitter } from "node:events";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeModelDescriptor } from "./descriptor";
import { NativeModelWorkerClient, type NativeModelWorkerFactory, type NativeModelWorkerLike } from "./workerClient";
import { startNativeModelWorker, type NativeModelWorkerPort } from "./workerHost";
import type { NativeModelWorkerRequest } from "./workerProtocol";

interface SpeakRequest {
  type: "speak";
  requestId: string;
  text: string;
}

interface SpeakResult {
  ready?: boolean;
  spoken?: string;
}

const KITTEN: NativeModelDescriptor = {
  label: "Kitten",
  cacheNamespace: "kitten",
  revision: "0123456789abcdef0123456789abcdef01234567",
  workerEntry: "kittenNativeWorker.js",
};

class FakeWorker extends EventEmitter {
  readonly posted: NativeModelWorkerRequest<SpeakRequest>[] = [];
  readonly terminate = vi.fn(async () => 0);
  readonly unref = vi.fn();

  postMessage(message: NativeModelWorkerRequest<SpeakRequest>): void {
    this.posted.push(message);
  }

  send(message: unknown): void {
    this.emit("message", message);
  }
}

/** A second consumer: the framework, not Audio8, owns everything but `speak`. */
class KittenClient extends NativeModelWorkerClient<SpeakRequest, SpeakResult> {
  speak(requestId: string, text: string): Promise<SpeakResult> {
    return this.request({ type: "speak", requestId, text });
  }
}

function harness() {
  const workers: FakeWorker[] = [];
  const factory = vi.fn((() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }) satisfies NativeModelWorkerFactory<SpeakRequest>);
  const client = new KittenClient({
    descriptor: KITTEN,
    modelDir: "/cache/kitten/revision",
    isResult: (result) => result.ready === true || typeof result.spoken === "string",
    createWorker: factory,
  });
  return { client, factory, workers };
}

/**
 * A client wired to the real worker host over in-memory ports, so requests are
 * queued the way the worker thread queues them.
 */
function hostedHarness(inactivityTimeoutMs: number) {
  const toClient = new Set<(message: unknown) => void>();
  const toHost = new Set<(message: unknown) => void>();
  const port: NativeModelWorkerPort<SpeakResult> = {
    on: (_event, listener) => toHost.add(listener),
    postMessage: (message) => queueMicrotask(() => {
      for (const listener of toClient) listener(message);
    }),
  };
  const worker = {
    on(event: string, listener: (value: never) => void) {
      if (event === "message") toClient.add(listener as (message: unknown) => void);
      return this;
    },
    postMessage: (message: NativeModelWorkerRequest<SpeakRequest>) => queueMicrotask(() => {
      for (const listener of toHost) listener(message);
    }),
    terminate: vi.fn(async () => 0),
    unref: () => {},
  } as unknown as NativeModelWorkerLike<SpeakRequest> & { terminate: ReturnType<typeof vi.fn> };
  const client = new KittenClient({
    descriptor: KITTEN,
    modelDir: "/cache/kitten/revision",
    isResult: (result) => typeof result.spoken === "string",
    createWorker: () => worker,
    inactivityTimeoutMs,
  });
  return { client, port, worker };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("NativeModelWorkerClient", () => {
  it("starts the descriptor's worker from the Electron output root", async () => {
    const { client, factory, workers } = harness();
    const load = client.load("load-1", () => {});

    expect(factory).toHaveBeenCalledWith(
      path.join(path.resolve(__dirname, ".."), "kittenNativeWorker.js"),
      { workerData: { modelDir: "/cache/kitten/revision" } },
    );
    workers[0].send({ type: "result", requestId: "load-1", result: { ready: true } });
    await expect(load).resolves.toEqual({ ready: true });
  });

  it("sends the model's own requests and settles them with recognised results only", async () => {
    const { client, workers } = harness();
    const spoken = client.speak("speak-1", "Hello");

    expect(workers[0].posted).toEqual([{ type: "speak", requestId: "speak-1", text: "Hello" }]);
    workers[0].send({ type: "result", requestId: "speak-1", result: { sampleRate: 44100 } });
    workers[0].send({ type: "result", requestId: "speak-1", result: { spoken: "Hello" } });

    await expect(spoken).resolves.toEqual({ spoken: "Hello" });
  });

  it("names the model in every error it raises itself", async () => {
    const { client, workers } = harness();
    const first = client.speak("speak-1", "Hello");

    await expect(client.speak("speak-1", "Again")).rejects.toThrow("Kitten request speak-1 is already in flight.");
    workers[0].send({ type: "error", requestId: "speak-1" });
    await expect(first).rejects.toThrow("Kitten native worker failed.");

    const crashed = client.speak("speak-2", "Hello");
    workers[0].emit("exit", 9);
    await expect(crashed).rejects.toThrow("Kitten native worker exited with code 9.");

    await client.destroy();
    await expect(client.load("load-1", () => {})).rejects.toThrow("Kitten native worker is shutting down.");
  });

  it("wraps a non-Error thrown while starting the worker", async () => {
    const client = new KittenClient({
      descriptor: KITTEN,
      modelDir: "/cache/kitten/revision",
      isResult: () => true,
      createWorker: () => {
        throw "no worker for you";
      },
    });

    await expect(client.load("load-1", () => {})).rejects.toThrow("no worker for you");
  });

  it("does not let a request queued behind a long, progressing one expire and kill the worker", async () => {
    vi.useFakeTimers();
    const { client, port, worker } = hostedHarness(2_000);
    startNativeModelWorker(port, {
      descriptor: KITTEN,
      load: async () => ({}),
      loadCancelledError: () => new Error("cancelled"),
      describeLoaded: () => ({ ready: true }),
      handlers: {
        // Takes 9 s, reporting progress every 0.5 s: alive the whole time.
        speak: async (request, { report }) => {
          for (let tick = 1; tick <= 18; tick += 1) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            report((tick / 18) * 100);
          }
          return { result: { spoken: String(request.text) } };
        },
      },
    });

    const first = client.speak("speak-1", "a long passage");
    // A second request (Reader look-ahead, a second window) waits its turn.
    const second = client.speak("speak-2", "the next passage");

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(first).resolves.toEqual({ spoken: "a long passage" });
    expect(worker.terminate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(second).resolves.toEqual({ spoken: "the next passage" });
  });

  it("still gives up on every request when a worker with a queue goes silent", async () => {
    vi.useFakeTimers();
    const { client, port, worker } = hostedHarness(2_000);
    startNativeModelWorker(port, {
      descriptor: KITTEN,
      load: async () => ({}),
      loadCancelledError: () => new Error("cancelled"),
      describeLoaded: () => ({ ready: true }),
      handlers: {
        // Reports once, then wedges inside the "native call".
        speak: async (_request, { report }) => {
          report(10);
          return new Promise(() => {});
        },
      },
    });

    const rejections = Promise.all([
      expect(client.speak("speak-1", "wedged")).rejects.toThrow("Kitten native worker stopped responding after 2s."),
      expect(client.speak("speak-2", "queued")).rejects.toThrow("Kitten native worker stopped responding after 2s."),
    ]);
    await vi.advanceTimersByTimeAsync(2_500);

    await rejections;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});
