import { Worker, type WorkerOptions } from "node:worker_threads";
import { stopLiteParseConverters } from "./documentConverterProcesses";
import type { DocumentParseOutcome, DocumentParser } from "./documentImport";

interface WorkerLike {
  on(event: "message", listener: (message: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  terminate(): Promise<number>;
}

export type DocumentParseWorkerFactory = (
  workerPath: string,
  options: WorkerOptions,
) => WorkerLike;

interface ActiveParse {
  worker: WorkerLike;
  reject: (error: Error) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWorkerResult(message: unknown, maxPages: number): DocumentParseOutcome {
  if (!isRecord(message)) throw new Error("Document parser worker returned an invalid response.");
  if (message.ok !== true) {
    throw new Error(typeof message.error === "string" ? message.error : "Document parser worker failed.");
  }
  const { pages } = message;
  if (!Array.isArray(pages) || !pages.every((page): page is string => typeof page === "string")) {
    throw new Error("Document parser worker returned invalid text.");
  }
  const pageCount = Number(message.pageCount);
  if (!Number.isSafeInteger(pageCount) || pageCount !== pages.length || pageCount > maxPages) {
    throw new Error("Document parser worker returned an invalid page count.");
  }
  return { pages, pageCount };
}

export class DocumentParseWorkerClient implements DocumentParser {
  readonly #workerPath: string;
  readonly #timeoutMs: number;
  readonly #maxPages: number;
  readonly #createWorker: DocumentParseWorkerFactory;
  readonly #stopConverters: () => Promise<unknown>;
  #active: ActiveParse | null = null;
  // Set while the processes an abandoned parse left behind are being stopped.
  #converterCleanup: Promise<void> | null = null;
  #closed = false;

  constructor(
    workerPath: string,
    timeoutMs: number,
    maxPages: number,
    createWorker: DocumentParseWorkerFactory = (path, options) => new Worker(path, options),
    stopConverters: () => Promise<unknown> = stopLiteParseConverters,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Document parser timeout must be positive.");
    }
    if (!Number.isSafeInteger(maxPages) || maxPages <= 0) {
      throw new Error("Document parser page limit must be a positive integer.");
    }
    this.#workerPath = workerPath;
    this.#timeoutMs = timeoutMs;
    this.#maxPages = maxPages;
    this.#createWorker = createWorker;
    this.#stopConverters = stopConverters;
  }

  parse(filePath: string): Promise<DocumentParseOutcome> {
    if (this.#closed) return Promise.reject(new Error("Document parser is shutting down."));
    if (this.#active) return Promise.reject(new Error("Another document import is still running."));
    // The cleanup kills every converter this process has running, so the next
    // import must not start one until it is done.
    const cleanup = this.#converterCleanup;
    if (cleanup) return cleanup.then(() => this.parse(filePath));

    const worker = this.#createWorker(this.#workerPath, {
      workerData: { filePath, maxPages: this.#maxPages },
    });

    return new Promise<DocumentParseOutcome>((resolve, reject) => {
      let settled = false;
      let answered = false;
      const settle = (outcome: { value: DocumentParseOutcome } | { error: Error }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.#active?.worker === worker) this.#active = null;
        const terminated = worker.terminate().catch(() => {});
        // A parse given up on (deadline, quit, worker crash) may still have
        // LibreOffice converting the document. Terminating the worker does not
        // stop it: a process started from a worker thread belongs to this
        // process. One that answered has nothing left running.
        if (!answered) this.#cleanUpConverters(terminated);
        if ("value" in outcome) resolve(outcome.value);
        else reject(outcome.error);
      };

      const timer = setTimeout(() => {
        const minutes = Math.ceil(this.#timeoutMs / 60_000);
        settle({ error: new Error(`Import timed out after ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`) });
      }, this.#timeoutMs);
      timer.unref();

      this.#active = {
        worker,
        reject: (error) => settle({ error }),
      };
      worker.on("message", (message) => {
        answered = true;
        try {
          settle({ value: parseWorkerResult(message, this.#maxPages) });
        } catch (cause) {
          settle({ error: cause instanceof Error ? cause : new Error(String(cause)) });
        }
      });
      worker.on("error", (error) => settle({ error }));
      worker.on("exit", (code) => {
        if (!settled) settle({ error: new Error(`Document parser worker exited with code ${code}.`) });
      });
    });
  }

  /**
   * Refuses further imports and abandons the one running. Returns the stop of
   * the converter processes it leaves behind, for the quit to wait on, or null
   * when there is nothing to stop.
   */
  close(): Promise<void> | null {
    this.#closed = true;
    this.#active?.reject(new Error("Document parser is shutting down."));
    return this.#converterCleanup;
  }

  #cleanUpConverters(terminated: Promise<unknown>): void {
    const cleanup: Promise<void> = Promise.all([terminated, this.#converterCleanup])
      .then(() => this.#stopConverters())
      .then(() => undefined, () => undefined)
      .finally(() => {
        if (this.#converterCleanup === cleanup) this.#converterCleanup = null;
      });
    this.#converterCleanup = cleanup;
  }
}
