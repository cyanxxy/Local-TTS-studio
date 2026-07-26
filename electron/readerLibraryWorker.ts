import { parentPort, workerData } from "node:worker_threads";
import { ReaderLibraryDatabase } from "./readerLibraryDatabase";

type ReaderLibraryOperation =
  | "listDocuments"
  | "getDocument"
  | "saveDocument"
  | "deleteDocument"
  | "getActiveDocumentId"
  | "setActiveDocumentId"
  | "deleteAudio";

interface WorkerRequest {
  type: "request";
  requestId: string;
  operation: ReaderLibraryOperation;
  args: unknown[];
}

interface SaveAudioStart {
  type: "save-audio-start";
  requestId: string;
  metadata: unknown;
  chunkCount: number;
}

interface SaveAudioChunk {
  type: "save-audio-chunk";
  requestId: string;
  order: number;
  chunk: unknown;
}

interface SaveAudioEnd {
  type: "save-audio-end";
  requestId: string;
}

interface SaveAudioCancel {
  type: "save-audio-cancel";
  requestId: string;
}

interface GetAudioStart {
  type: "get-audio-start";
  requestId: string;
  documentId: unknown;
  sectionId: unknown;
}

interface GetAudioNext {
  type: "get-audio-next";
  requestId: string;
  order: number;
}

interface GetAudioCancel {
  type: "get-audio-cancel";
  requestId: string;
}

interface ShutdownRequest {
  type: "shutdown";
}

type WorkerMessage =
  | WorkerRequest
  | SaveAudioStart
  | SaveAudioChunk
  | SaveAudioEnd
  | SaveAudioCancel
  | GetAudioStart
  | GetAudioNext
  | GetAudioCancel
  | ShutdownRequest;

interface PendingAudioSave {
  metadata: unknown;
  chunks: unknown[];
  chunkCount: number;
  // Chunk ordering tracks arrivals, not buffered payloads, so an invalidated
  // save can release its PCM and still validate the rest of the stream.
  receivedCount: number;
  invalidated: boolean;
}

interface PendingAudioRead {
  chunks: Array<Record<string, unknown> & { audio: ArrayBuffer }>;
  nextOrder: number;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (!parentPort) throw new Error("Reader library worker requires a parent port.");
const port = parentPort as NonNullable<typeof parentPort>;
const databasePath = isRecord(workerData) ? workerData.databasePath : undefined;
if (typeof databasePath !== "string" || databasePath.length === 0) {
  throw new Error("Reader library worker requires a database path.");
}

const database = new ReaderLibraryDatabase(databasePath);
const pendingAudioSaves = new Map<string, PendingAudioSave>();
const pendingAudioReads = new Map<string, PendingAudioRead>();

/**
 * A delete request lands between the chunks of a streamed save, so the save has
 * to be told its rows are gone before it re-inserts them. Marking runs *before*
 * the delete executes: a delete that removed rows and then failed on commit
 * would otherwise skip the marking entirely and let the save resurrect an
 * orphaned entry. Dropping a cache entry the delete never reached is cheap —
 * the audio is regenerated on demand — while a resurrected row belongs to no
 * document and survives until LRU pruning reclaims it.
 *
 * An id shape that `deleteDocument`/`deleteAudio` reject cannot remove rows, so
 * it invalidates nothing.
 */
function invalidatePendingSaves(documentIdValue: unknown, sectionIdValue?: unknown): void {
  if (typeof documentIdValue !== "string" || documentIdValue.length === 0) return;
  if (sectionIdValue !== undefined && typeof sectionIdValue !== "string") return;
  for (const pending of pendingAudioSaves.values()) {
    if (!isRecord(pending.metadata)) continue;
    if (pending.metadata.documentId !== documentIdValue) continue;
    // No section id clears the whole document, matching `deleteAudio`.
    if (sectionIdValue !== undefined && pending.metadata.sectionId !== sectionIdValue) continue;
    pending.invalidated = true;
    pending.chunks.length = 0;
  }
}

function handleRequest(request: WorkerRequest): unknown {
  switch (request.operation) {
    case "listDocuments":
      return database.listDocuments();
    case "getDocument":
      return database.getDocument(request.args[0]);
    case "saveDocument":
      return database.saveDocument(request.args[0]);
    case "deleteDocument":
      invalidatePendingSaves(request.args[0]);
      return database.deleteDocument(request.args[0]);
    case "getActiveDocumentId":
      return database.getActiveDocumentId();
    case "setActiveDocumentId":
      return database.setActiveDocumentId(request.args[0]);
    case "deleteAudio":
      invalidatePendingSaves(request.args[0], request.args[1]);
      return database.deleteAudio(request.args[0], request.args[1]);
  }
}

function handleSaveAudioStart(message: SaveAudioStart): void {
  if (!Number.isInteger(message.chunkCount) || message.chunkCount < 0 || message.chunkCount > 16_384) {
    throw new TypeError("Reader audio chunk count is invalid.");
  }
  pendingAudioSaves.set(message.requestId, {
    metadata: message.metadata,
    chunks: [],
    chunkCount: message.chunkCount,
    receivedCount: 0,
    invalidated: false,
  });
  port.postMessage({ type: "save-audio-ready", requestId: message.requestId });
}

function handleSaveAudioChunk(message: SaveAudioChunk): void {
  const pending = pendingAudioSaves.get(message.requestId);
  if (!pending || message.order !== pending.receivedCount || message.order >= pending.chunkCount) {
    throw new Error("Reader audio chunks arrived out of order.");
  }
  pending.receivedCount += 1;
  // The client still drives the stream to its end, so keep acknowledging chunks
  // an invalidated save will never write and let their payloads go now.
  if (!pending.invalidated) pending.chunks.push(message.chunk);
  port.postMessage({
    type: "save-audio-chunk-accepted",
    requestId: message.requestId,
    order: message.order,
  });
}

function handleSaveAudioEnd(message: SaveAudioEnd): void {
  const pending = pendingAudioSaves.get(message.requestId);
  if (!pending || pending.receivedCount !== pending.chunkCount || !isRecord(pending.metadata)) {
    throw new Error("Reader audio stream ended before every chunk arrived.");
  }
  pendingAudioSaves.delete(message.requestId);
  // The delete is the newer intent, so drop the write — and still report
  // success, because the renderer must not surface an error for a save it
  // deliberately made obsolete.
  if (!pending.invalidated) database.saveAudio({ ...pending.metadata, chunks: pending.chunks });
  port.postMessage({ type: "save-audio-result", requestId: message.requestId, ok: true });
}

function handleGetAudioStart(message: GetAudioStart): void {
  const audio = database.getAudio(message.documentId, message.sectionId);
  if (!audio) {
    port.postMessage({
      type: "get-audio-header",
      requestId: message.requestId,
      audio: null,
      chunkCount: 0,
    });
    return;
  }
  const { chunks, ...metadata } = audio;
  pendingAudioReads.set(message.requestId, {
    chunks: chunks as unknown as Array<Record<string, unknown> & { audio: ArrayBuffer }>,
    nextOrder: 0,
  });
  port.postMessage({
    type: "get-audio-header",
    requestId: message.requestId,
    audio: metadata,
    chunkCount: chunks.length,
  });
  if (chunks.length === 0) pendingAudioReads.delete(message.requestId);
}

function handleGetAudioNext(message: GetAudioNext): void {
  const pending = pendingAudioReads.get(message.requestId);
  if (!pending || message.order !== pending.nextOrder) {
    throw new Error("Reader audio chunk request is out of order.");
  }
  const chunk = pending.chunks[message.order];
  if (!chunk) throw new Error("Reader audio chunk is missing.");
  pending.nextOrder += 1;
  const done = pending.nextOrder === pending.chunks.length;
  if (done) pendingAudioReads.delete(message.requestId);
  port.postMessage(
    {
      type: "get-audio-chunk",
      requestId: message.requestId,
      order: message.order,
      chunk,
      done,
    },
    [chunk.audio],
  );
}

port.on("message", (message: WorkerMessage) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "shutdown") {
    pendingAudioSaves.clear();
    pendingAudioReads.clear();
    database.close();
    port.postMessage({ type: "shutdown-complete" });
    port.close();
    return;
  }

  try {
    switch (message.type) {
      case "request":
        port.postMessage({
          type: "result",
          requestId: message.requestId,
          ok: true,
          value: handleRequest(message),
        });
        break;
      case "save-audio-start":
        handleSaveAudioStart(message);
        break;
      case "save-audio-chunk":
        handleSaveAudioChunk(message);
        break;
      case "save-audio-end":
        handleSaveAudioEnd(message);
        break;
      case "save-audio-cancel":
        pendingAudioSaves.delete(message.requestId);
        break;
      case "get-audio-start":
        handleGetAudioStart(message);
        break;
      case "get-audio-next":
        handleGetAudioNext(message);
        break;
      case "get-audio-cancel":
        pendingAudioReads.delete(message.requestId);
        break;
    }
  } catch (cause) {
    pendingAudioSaves.delete("requestId" in message ? message.requestId : "");
    pendingAudioReads.delete("requestId" in message ? message.requestId : "");
    port.postMessage({
      type: "result",
      requestId: "requestId" in message ? message.requestId : "",
      ok: false,
      error: errorMessage(cause),
    });
  }
});
