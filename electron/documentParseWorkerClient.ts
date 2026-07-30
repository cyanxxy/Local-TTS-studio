import { Worker, type WorkerOptions } from "node:worker_threads";
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

function parseWorkerResult(message: unknown): DocumentParseOutcome {
  if (!isRecord(message)) throw new Error("Document parser worker returned an invalid response.");
  if (message.ok !== true) {
    throw new Error(typeof message.error === "string" ? message.error : "Document parser worker failed.");
  }
  if (typeof message.text !== "string") {
    throw new Error("Document parser worker returned invalid text.");
  }
  const pageCount = Number(message.pageCount);
  if (!Number.isSafeInteger(pageCount) || pageCount < 0) {
    throw new Error("Document parser worker returned an invalid page count.");
  }
  return { text: message.text, pageCount };
}

export class DocumentParseWorkerClient implements DocumentParser {
  readonly #workerPath: string;
  readonly #timeoutMs: number;
  readonly #maxPages: number;
  readonly #createWorker: DocumentParseWorkerFactory;
  #active: ActiveParse | null = null;
  #closed = false;

  constructor(
    workerPath: string,
    timeoutMs: number,
    maxPages: number,
    createWorker: DocumentParseWorkerFactory = (path, options) => new Worker(path, options),
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
  }

  parse(filePath: string): Promise<DocumentParseOutcome> {
    if (this.#closed) return Promise.reject(new Error("Document parser is shutting down."));
    if (this.#active) return Promise.reject(new Error("Another document import is still running."));

    const worker = this.#createWorker(this.#workerPath, {
      workerData: { filePath, maxPages: this.#maxPages },
    });

    return new Promise<DocumentParseOutcome>((resolve, reject) => {
      let settled = false;
      const settle = (outcome: { value: DocumentParseOutcome } | { error: Error }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.#active?.worker === worker) this.#active = null;
        void worker.terminate().catch(() => {});
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
        try {
          settle({ value: parseWorkerResult(message) });
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

  close(): void {
    this.#closed = true;
    this.#active?.reject(new Error("Document parser is shutting down."));
  }
}
