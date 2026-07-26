import { Worker } from "node:worker_threads";
import type { MessagePortMain } from "electron";

type ReaderLibraryOperation =
  | "listDocuments"
  | "getDocument"
  | "saveDocument"
  | "deleteDocument"
  | "getActiveDocumentId"
  | "setActiveDocumentId"
  | "deleteAudio";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (cause: Error) => void;
}

interface SaveAudioStream {
  kind: "save";
  port: MessagePortMain;
  chunkCount: number;
  nextOrder: number;
  totalBytes: number;
}

interface GetAudioStream {
  kind: "get";
  port: MessagePortMain;
  nextOrder: number;
}

type AudioStream = SaveAudioStream | GetAudioStream;

const MAX_AUDIO_CHUNKS = 16_384;
const MAX_AUDIO_CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_AUDIO_ENTRY_BYTES = 256 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function portMessageData(eventOrData: unknown): unknown {
  return isRecord(eventOrData) && "data" in eventOrData
    ? eventOrData.data
    : eventOrData;
}

export class ReaderLibraryWorkerClient {
  readonly #worker: Worker;
  readonly #pendingRequests = new Map<string, PendingRequest>();
  readonly #audioStreams = new Map<string, AudioStream>();
  readonly #exitPromise: Promise<void>;
  #resolveExit: (() => void) | null = null;
  #sequence = 0;
  #closing = false;
  #exited = false;
  #failed = false;

  constructor(workerPath: string, databasePath: string, onExit: () => void) {
    this.#worker = new Worker(workerPath, {
      workerData: { databasePath },
    });
    this.#exitPromise = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });
    this.#worker.on("message", (message: unknown) => this.#handleWorkerMessage(message));
    this.#worker.on("error", (cause) => {
      // "exit" trails "error" by at least a turn, so nothing may be posted in between.
      this.#failed = true;
      this.#failAll(cause);
    });
    this.#worker.on("exit", (code) => {
      this.#exited = true;
      this.#resolveExit?.();
      this.#resolveExit = null;
      if (!this.#closing) {
        this.#failAll(new Error(`Reader library worker exited with code ${code}.`));
      }
      onExit();
    });
  }

  request(operation: ReaderLibraryOperation, args: unknown[] = []): Promise<unknown> {
    const unavailable = this.#unavailableError();
    if (unavailable) return Promise.reject(unavailable);
    const requestId = this.#nextRequestId();
    const result = new Promise<unknown>((resolve, reject) => {
      this.#pendingRequests.set(requestId, { resolve, reject });
    });
    this.#worker.postMessage({ type: "request", requestId, operation, args });
    return result;
  }

  saveAudio(port: MessagePortMain, metadata: unknown, chunkCountValue: unknown): void {
    const unavailable = this.#unavailableError();
    if (unavailable) {
      this.#rejectPort(port, unavailable.message);
      return;
    }
    const chunkCount = Number(chunkCountValue);
    if (
      !isRecord(metadata)
      || !Number.isInteger(chunkCount)
      || chunkCount < 0
      || chunkCount > MAX_AUDIO_CHUNKS
    ) {
      this.#rejectPort(port, "Invalid Reader audio stream request.");
      return;
    }
    const requestId = this.#nextRequestId();
    const stream: SaveAudioStream = {
      kind: "save",
      port,
      chunkCount,
      nextOrder: 0,
      totalBytes: 0,
    };
    this.#audioStreams.set(requestId, stream);
    port.on("message", (event) => this.#handleSavePortMessage(requestId, portMessageData(event)));
    port.once("close", () => this.#cancelStream(requestId));
    port.start();
    this.#worker.postMessage({
      type: "save-audio-start",
      requestId,
      metadata,
      chunkCount,
    });
  }

  getAudio(port: MessagePortMain, documentId: unknown, sectionId: unknown): void {
    const unavailable = this.#unavailableError();
    if (unavailable) {
      this.#rejectPort(port, unavailable.message);
      return;
    }
    const requestId = this.#nextRequestId();
    const stream: GetAudioStream = {
      kind: "get",
      port,
      nextOrder: 0,
    };
    this.#audioStreams.set(requestId, stream);
    port.on("message", (event) => this.#handleGetPortMessage(requestId, portMessageData(event)));
    port.once("close", () => this.#cancelStream(requestId));
    port.start();
    this.#worker.postMessage({
      type: "get-audio-start",
      requestId,
      documentId,
      sectionId,
    });
  }

  async close(): Promise<void> {
    if (this.#exited) return;
    if (!this.#closing) {
      this.#closing = true;
      // Stream cancels have to reach the worker before it closes its port on shutdown.
      this.#failAll(new Error("Reader library worker is shutting down."));
      this.#worker.postMessage({ type: "shutdown" });
    }
    let timeout: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      this.#exitPromise.then(() => false),
      new Promise<true>((resolve) => {
        timeout = setTimeout(() => resolve(true), 2_000);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (timedOut && !this.#exited) await this.#worker.terminate();
  }

  // Null while the worker can still answer. Only a deliberate close reports the
  // wording `src/lib/readerLibrary.ts` silences at quit time — a crash has to stay
  // loud, so it gets a message that predicate does not match.
  #unavailableError(): Error | null {
    if (this.#closing) return new Error("Reader library worker is shutting down.");
    if (this.#exited || this.#failed) return new Error("Reader library worker is unavailable.");
    return null;
  }

  #nextRequestId(): string {
    this.#sequence += 1;
    return `reader-library-${process.pid}-${this.#sequence}`;
  }

  #handleSavePortMessage(requestId: string, value: unknown): void {
    const stream = this.#audioStreams.get(requestId);
    if (!stream || stream.kind !== "save" || !isRecord(value)) return;
    if (value.type === "cancel") {
      this.#cancelStream(requestId);
      return;
    }
    if (value.type === "end") {
      if (stream.nextOrder !== stream.chunkCount) {
        this.#failStream(requestId, "Reader audio stream ended before every chunk arrived.");
        return;
      }
      this.#worker.postMessage({ type: "save-audio-end", requestId });
      return;
    }
    if (
      value.type !== "chunk"
      || value.order !== stream.nextOrder
      || !isRecord(value.chunk)
      || !(value.chunk.audio instanceof ArrayBuffer)
      || value.chunk.audio.byteLength > MAX_AUDIO_CHUNK_BYTES
    ) {
      this.#failStream(requestId, "Reader audio chunk is invalid or out of order.");
      return;
    }
    const audio = value.chunk.audio;
    if (stream.totalBytes + audio.byteLength > MAX_AUDIO_ENTRY_BYTES) {
      this.#failStream(requestId, "Cached Reader audio exceeds the stream size limit.");
      return;
    }
    stream.totalBytes += audio.byteLength;
    stream.nextOrder += 1;
    this.#worker.postMessage(
      {
        type: "save-audio-chunk",
        requestId,
        order: value.order,
        chunk: value.chunk,
      },
      [audio],
    );
  }

  #handleGetPortMessage(requestId: string, value: unknown): void {
    const stream = this.#audioStreams.get(requestId);
    if (!stream || stream.kind !== "get" || !isRecord(value)) return;
    if (value.type === "cancel") {
      this.#cancelStream(requestId);
      return;
    }
    if (value.type !== "next" || value.order !== stream.nextOrder) {
      this.#failStream(requestId, "Reader audio chunk request is out of order.");
      return;
    }
    stream.nextOrder += 1;
    this.#worker.postMessage({
      type: "get-audio-next",
      requestId,
      order: value.order,
    });
  }

  #handleWorkerMessage(value: unknown): void {
    if (!isRecord(value)) return;
    const requestId = typeof value.requestId === "string" ? value.requestId : "";
    if (value.type === "result") {
      const request = this.#pendingRequests.get(requestId);
      if (request) {
        this.#pendingRequests.delete(requestId);
        if (value.ok === true) request.resolve(value.value);
        else request.reject(new Error(typeof value.error === "string" ? value.error : "Reader library request failed."));
        return;
      }
      if (value.ok !== true) {
        this.#failStream(
          requestId,
          typeof value.error === "string" ? value.error : "Reader library stream failed.",
        );
      }
      return;
    }

    const stream = this.#audioStreams.get(requestId);
    if (!stream) return;
    if (value.type === "save-audio-ready" && stream.kind === "save") {
      stream.port.postMessage({ type: "ready" });
      return;
    }
    if (value.type === "save-audio-chunk-accepted" && stream.kind === "save") {
      stream.port.postMessage({ type: "accepted", order: value.order });
      return;
    }
    if (value.type === "save-audio-result" && stream.kind === "save") {
      stream.port.postMessage({ type: "result", ok: true });
      this.#finishStream(requestId);
      return;
    }
    if (value.type === "get-audio-header" && stream.kind === "get") {
      stream.port.postMessage({
        type: "header",
        audio: value.audio,
        chunkCount: value.chunkCount,
      });
      if (value.audio === null || value.chunkCount === 0) this.#finishStream(requestId);
      return;
    }
    if (value.type === "get-audio-chunk" && stream.kind === "get") {
      // An Electron transfer list holds ports only, so PCM is copied on this hop;
      // handing it an ArrayBuffer throws and strands the renderer's stream.
      stream.port.postMessage({
        type: "chunk",
        order: value.order,
        chunk: value.chunk,
        done: value.done,
      });
      if (value.done === true) this.#finishStream(requestId);
    }
  }

  #finishStream(requestId: string): void {
    const stream = this.#audioStreams.get(requestId);
    if (!stream) return;
    this.#audioStreams.delete(requestId);
    stream.port.close();
  }

  #cancelStream(requestId: string): void {
    const stream = this.#audioStreams.get(requestId);
    if (!stream) return;
    this.#audioStreams.delete(requestId);
    if (stream.kind === "save") {
      this.#worker.postMessage({ type: "save-audio-cancel", requestId });
    } else {
      this.#worker.postMessage({ type: "get-audio-cancel", requestId });
    }
  }

  #failStream(requestId: string, message: string): void {
    const stream = this.#audioStreams.get(requestId);
    if (!stream) return;
    this.#audioStreams.delete(requestId);
    try {
      stream.port.postMessage({ type: "result", ok: false, error: message });
    } finally {
      stream.port.close();
      if (stream.kind === "save") {
        this.#worker.postMessage({ type: "save-audio-cancel", requestId });
      } else {
        this.#worker.postMessage({ type: "get-audio-cancel", requestId });
      }
    }
  }

  #rejectPort(port: MessagePortMain, message: string): void {
    port.postMessage({ type: "result", ok: false, error: message });
    port.close();
  }

  #failAll(cause: unknown): void {
    const error = toError(cause);
    for (const request of this.#pendingRequests.values()) request.reject(error);
    this.#pendingRequests.clear();
    for (const requestId of [...this.#audioStreams.keys()]) {
      this.#failStream(requestId, error.message);
    }
  }
}
