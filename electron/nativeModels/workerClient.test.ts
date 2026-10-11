// @vitest-environment node

import { EventEmitter } from "node:events";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { NativeModelDescriptor } from "./descriptor";
import { NativeModelWorkerClient, type NativeModelWorkerFactory } from "./workerClient";
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
});
