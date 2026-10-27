// @vitest-environment node

import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LITEPARSE_CONVERTER_MARKER } from "./documentConverterProcesses";
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

/**
 * Running, not merely present: a killed child of a terminated worker thread is
 * never reaped, so it lingers as a zombie that `process.kill(pid, 0)` still finds.
 */
function isRunning(pid: number): boolean {
  try {
    return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z");
  } catch {
    return false;
  }
}

function harness(timeoutMs = 300_000) {
  const workers: FakeWorker[] = [];
  const stopConverters = vi.fn(async () => []);
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
    stopConverters,
  );
  return { client, factory, workers, stopConverters };
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
    workers[0].send({ ok: true, pages: ["Book", "text"], pageCount: 2 });

    await expect(result).resolves.toEqual({ pages: ["Book", "text"], pageCount: 2 });
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
    workers[0].send({ ok: true, pages: ["First"], pageCount: 1 });
    await expect(first).resolves.toEqual({ pages: ["First"], pageCount: 1 });
  });

  it("rejects malformed responses and worker failures", async () => {
    const { client, workers } = harness();
    const malformed = client.parse("/tmp/bad.pdf");
    workers[0].send({ ok: true, pages: ["Page one", 42], pageCount: 2 });
    await expect(malformed).rejects.toThrow("invalid text");

    const failed = client.parse("/tmp/fail.pdf");
    workers[1].fail(new Error("native parser crashed"));
    await expect(failed).rejects.toThrow("native parser crashed");
  });

  it("rejects page counts that disagree with the pages or exceed the limit", async () => {
    const { client, workers } = harness();
    const legacy = client.parse("/tmp/legacy.pdf");
    workers[0].send({ ok: true, text: "Joined text only", pageCount: 1 });
    await expect(legacy).rejects.toThrow("invalid text");

    const mismatched = client.parse("/tmp/mismatched.pdf");
    workers[1].send({ ok: true, pages: ["One", "Two"], pageCount: 3 });
    await expect(mismatched).rejects.toThrow("invalid page count");

    const oversized = client.parse("/tmp/oversized.pdf");
    const pages = Array.from({ length: 801 }, (_, index) => `Page ${index + 1}`);
    workers[2].send({ ok: true, pages, pageCount: pages.length });
    await expect(oversized).rejects.toThrow("invalid page count");
  });

  it("terminates an active parse during shutdown and rejects future work", async () => {
    const { client, workers, stopConverters } = harness();
    const active = client.parse("/tmp/active.pdf");

    const stopped = client.close();

    await expect(active).rejects.toThrow("Document parser is shutting down.");
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    // The quit waits for the conversion it abandoned to be stopped.
    expect(stopped).toBeInstanceOf(Promise);
    await stopped;
    expect(stopConverters).toHaveBeenCalledTimes(1);
    await expect(client.parse("/tmp/later.pdf")).rejects.toThrow(
      "Document parser is shutting down.",
    );
  });

  it("gives the quit nothing to wait for when no import is running", () => {
    const { client, stopConverters } = harness();

    expect(client.close()).toBeNull();
    expect(stopConverters).not.toHaveBeenCalled();
  });

  it("stops the converters only of a parse that was abandoned", async () => {
    vi.useFakeTimers();
    const { client, workers, stopConverters } = harness(60_000);
    const answered = client.parse("/tmp/slides.pptx");
    workers[0].send({ ok: false, error: "LibreOffice is not installed." });
    await expect(answered).rejects.toThrow("LibreOffice is not installed.");
    expect(stopConverters).not.toHaveBeenCalled();

    const abandoned = client.parse("/tmp/slides.pptx");
    const rejection = expect(abandoned).rejects.toThrow("Import timed out after 1 minute.");
    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;
    expect(stopConverters).toHaveBeenCalledTimes(1);
  });

  it("starts the next import only once the last one's converters are stopped", async () => {
    vi.useFakeTimers();
    const { client, workers, stopConverters } = harness(60_000);
    let finishStopping!: () => void;
    stopConverters.mockImplementationOnce(() => new Promise((resolve) => {
      finishStopping = () => resolve([]);
    }));
    const abandoned = client.parse("/tmp/first.docx");
    const rejection = expect(abandoned).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;

    // A converter the next import starts would otherwise be killed with them.
    const next = client.parse("/tmp/second.docx");
    await vi.advanceTimersByTimeAsync(0);
    expect(workers).toHaveLength(1);

    finishStopping();
    await vi.advanceTimersByTimeAsync(0);
    expect(workers).toHaveLength(2);
    workers[1].send({ ok: true, pages: ["Second"], pageCount: 1 });
    await expect(next).resolves.toEqual({ pages: ["Second"], pageCount: 1 });
  });

  // Reads the process state with `ps`, which Windows does not have.
  it.skipIf(process.platform === "win32")("stops the converter process a timed-out parse started", async () => {
    // A real worker thread starts a stand-in for LibreOffice the way LiteParse
    // does, carrying a conversion profile on its command line, and then never
    // finishes. Terminating the worker alone leaves that process running.
    const shared = new Int32Array(new SharedArrayBuffer(4));
    // Long enough for a worker thread to boot and spawn under a loaded test
    // run: a timeout that fires first finds no converter to stop.
    const client = new DocumentParseWorkerClient("unused", 2_000, 10, () => new Worker(
      `const { spawn } = require("child_process");
       const { workerData } = require("worker_threads");
       const child = spawn(process.execPath, [
         "-e", "setInterval(() => {}, 1000)",
         "--", "-env:UserInstallation=file:///tmp/" + workerData.marker + "test", "--headless", "--convert-to", "pdf",
       ], { stdio: "ignore" });
       Atomics.store(workerData.shared, 0, child.pid);
       setInterval(() => {}, 1000);`,
      { eval: true, workerData: { shared, marker: LITEPARSE_CONVERTER_MARKER } },
    ));

    let converterPid = 0;
    try {
      await expect(client.parse("/tmp/slides.pptx")).rejects.toThrow(/timed out/);
      converterPid = Atomics.load(shared, 0);
      expect(converterPid).toBeGreaterThan(0);
      const deadline = Date.now() + 3_000;
      while (isRunning(converterPid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(isRunning(converterPid)).toBe(false);
    } finally {
      converterPid ||= Atomics.load(shared, 0);
      if (converterPid && isRunning(converterPid)) process.kill(converterPid, "SIGKILL");
    }
  }, 15_000);
});
