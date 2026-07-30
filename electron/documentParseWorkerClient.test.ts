// @vitest-environment node

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DocumentParseWorkerClient,
  type DocumentParseWorkerFactory,
} from "./documentParseWorkerClient";

class FakeWorker extends EventEmitter {
  readonly terminate = vi.fn(async () => 0);

  send(message: unknown): void {
    this.emit("message", message);
  }

  fail(error: Error): void {
    this.emit("error", error);
  }

  exit(code: number): void {
    this.emit("exit", code);
  }
}

function harness(timeoutMs = 300_000) {
  const workers: FakeWorker[] = [];
  const factory = vi.fn(((workerPath, options) => {
    expect(workerPath).toBe("/app/documentParseWorker.js");
    expect(options.workerData).toMatchObject({ maxPages: 800 });
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }) satisfies DocumentParseWorkerFactory);
  const client = new DocumentParseWorkerClient(
    "/app/documentParseWorker.js",
    timeoutMs,
    800,
    factory,
  );
  return { client, factory, workers };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("DocumentParseWorkerClient", () => {
  it("returns a validated worker result and terminates the one-shot worker", async () => {
    const { client, factory, workers } = harness();
    const result = client.parse("/tmp/book.pdf");

    expect(factory).toHaveBeenCalledWith(
      "/app/documentParseWorker.js",
      { workerData: { filePath: "/tmp/book.pdf", maxPages: 800 } },
    );
    workers[0].send({ ok: true, text: "Book text", pageCount: 12 });

    await expect(result).resolves.toEqual({ text: "Book text", pageCount: 12 });
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  it("terminates native parser work when the deadline expires", async () => {
    vi.useFakeTimers();
    const { client, workers } = harness(60_000);
    const result = client.parse("/tmp/scan.pdf");
    const rejection = expect(result).rejects.toThrow("Import timed out after 1 minute.");

    await vi.advanceTimersByTimeAsync(60_000);

    await rejection;
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  it("prevents overlapping OCR jobs", async () => {
    const { client, workers } = harness();
    const first = client.parse("/tmp/first.pdf");

    await expect(client.parse("/tmp/second.pdf")).rejects.toThrow(
      "Another document import is still running.",
    );
    workers[0].send({ ok: true, text: "First", pageCount: 1 });
    await expect(first).resolves.toEqual({ text: "First", pageCount: 1 });
  });

  it("rejects malformed responses and worker failures", async () => {
    const { client, workers } = harness();
    const malformed = client.parse("/tmp/bad.pdf");
    workers[0].send({ ok: true, text: 42, pageCount: 1 });
    await expect(malformed).rejects.toThrow("invalid text");

    const failed = client.parse("/tmp/fail.pdf");
    workers[1].fail(new Error("native parser crashed"));
    await expect(failed).rejects.toThrow("native parser crashed");
  });

  it("terminates an active parse during shutdown and rejects future work", async () => {
    const { client, workers } = harness();
    const active = client.parse("/tmp/active.pdf");

    client.close();

    await expect(active).rejects.toThrow("Document parser is shutting down.");
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    await expect(client.parse("/tmp/later.pdf")).rejects.toThrow(
      "Document parser is shutting down.",
    );
  });
});
