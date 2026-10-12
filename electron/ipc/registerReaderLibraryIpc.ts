import { BrowserWindow, type MessagePortMain } from "electron";
import { randomUUID } from "crypto";
import type { ShutdownParticipant } from "../appShutdown";
import { errorMessage } from "../errors";
import { isRecord } from "../guards";
import { ReaderLibraryWorkerClient } from "../readerLibraryWorkerClient";
import type { TrustedIpc } from "./trusted";

// Renderers debounce Reader writes for up to a second, so the quit has to hold
// long enough for a flush round trip. The outer quit race
// (RUST_CANCEL_KILL_AFTER_MS + 500) still caps the total, so a renderer that
// never answers cannot stretch the shutdown past that budget.
const READER_LIBRARY_FLUSH_TIMEOUT_MS = 1_500;
// src/lib/readerLibrary.ts recognises this text to treat a write lost to the
// quit as expected rather than as a failure.
const READER_LIBRARY_SHUTTING_DOWN_MESSAGE = "Reader library is shutting down.";

export interface ReaderLibraryIpcOptions {
  /** The compiled SQLite worker script. */
  workerPath: string;
  /** The library database; resolved when the worker first starts. */
  databasePath: () => string;
}

function requestField(request: unknown, field: string): unknown {
  if (!isRecord(request) || !(field in request)) {
    throw new TypeError(`Reader library request is missing ${field}.`);
  }
  return request[field];
}

// Electron has already transferred the port into main by the time a stream
// handler runs, so every failure path has to answer on it and close it;
// otherwise the renderer waits out the full audio stream timeout.
function rejectStreamPort(port: MessagePortMain, message: string): void {
  port.postMessage({ type: "result", ok: false, error: message });
  port.close();
}

/**
 * Registers the `reader-library:*` channels, backed by a lazily started
 * SQLite worker thread, and returns its part in the quit barrier.
 */
export function registerReaderLibraryIpc(
  ipc: TrustedIpc,
  { workerPath, databasePath }: ReaderLibraryIpcOptions,
): ShutdownParticipant {
  let readerLibraryWorker: ReaderLibraryWorkerClient | null = null;
  // Tracked apart from the local runtime's latch: the quit asks every renderer
  // to flush its debounced Reader writes first, so `reader-library:*` has to
  // keep working after the local runtime has already been told to stop.
  let readerLibraryShuttingDown = false;
  const pendingReaderLibraryFlushes = new Map<string, () => void>();

  function getReaderLibraryWorker(): ReaderLibraryWorkerClient {
    if (readerLibraryShuttingDown) throw new Error(READER_LIBRARY_SHUTTING_DOWN_MESSAGE);
    if (readerLibraryWorker) return readerLibraryWorker;
    const worker = new ReaderLibraryWorkerClient(
      workerPath,
      databasePath(),
      () => {
        if (readerLibraryWorker === worker) readerLibraryWorker = null;
      },
    );
    readerLibraryWorker = worker;
    return worker;
  }

  /**
   * Asks every open window to write out the Reader edits it is still holding
   * behind a debounce timer. `before-quit` blocks the quit, so those timers would
   * otherwise never fire and the edits would be lost without a trace.
   *
   * Resolves once every window has acknowledged or the timeout expires — a
   * renderer that is wedged or already gone must not strand the shutdown.
   */
  function requestReaderLibraryFlush(): Promise<void> {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length === 0) {
      // No renderer left to ask, but one that just closed may have posted its
      // `pagehide` writes already; give the IPC queue a turn before the worker
      // closes underneath them.
      return new Promise<void>((resolve) => { setImmediate(resolve); });
    }

    const acknowledgements = windows.map((window) => new Promise<void>((resolve) => {
      if (window.webContents.isDestroyed()) {
        resolve();
        return;
      }
      const token = randomUUID();
      pendingReaderLibraryFlushes.set(token, resolve);
      try {
        window.webContents.send("reader-library:flush", { token });
      } catch {
        // A window can be destroyed between the check and the send.
        pendingReaderLibraryFlushes.delete(token);
        resolve();
      }
    }));
    return Promise.race([
      Promise.all(acknowledgements).then(() => undefined),
      new Promise<void>((resolve) => { setTimeout(resolve, READER_LIBRARY_FLUSH_TIMEOUT_MS); }),
    ]).then(() => {
      pendingReaderLibraryFlushes.clear();
    });
  }

  // Latches the shutdown flag together with the close so no request can slip
  // between the two and reach a worker that is already draining.
  function closeReaderLibraryWorker(): Promise<void> {
    readerLibraryShuttingDown = true;
    const worker = readerLibraryWorker;
    readerLibraryWorker = null;
    return worker?.close() ?? Promise.resolve();
  }

  ipc.handle("reader-library:list-documents", () => {
    return getReaderLibraryWorker().request("listDocuments");
  });

  ipc.handle("reader-library:get-document", (_event, request) => {
    return getReaderLibraryWorker().request("getDocument", [requestField(request, "id")]);
  });

  ipc.handle("reader-library:save-document", (_event, request) => {
    return getReaderLibraryWorker().request("saveDocument", [requestField(request, "document")]);
  });

  ipc.handle("reader-library:save-progress", (_event, request) => {
    return getReaderLibraryWorker().request("saveProgress", [
      requestField(request, "documentId"),
      requestField(request, "progress"),
    ]);
  });

  ipc.handle("reader-library:delete-document", (_event, request) => {
    return getReaderLibraryWorker().request("deleteDocument", [requestField(request, "id")]);
  });

  ipc.handle("reader-library:get-active-document-id", () => {
    return getReaderLibraryWorker().request("getActiveDocumentId");
  });

  ipc.handle("reader-library:set-active-document-id", (_event, request) => {
    return getReaderLibraryWorker().request("setActiveDocumentId", [requestField(request, "id")]);
  });

  ipc.onPort("reader-library:save-audio-stream", (port, request) => {
    if (readerLibraryShuttingDown) {
      rejectStreamPort(port, READER_LIBRARY_SHUTTING_DOWN_MESSAGE);
      return;
    }
    if (!isRecord(request)) {
      rejectStreamPort(port, "Invalid Reader audio stream request.");
      return;
    }
    try {
      getReaderLibraryWorker().saveAudio(port, request.metadata, request.chunkCount);
    } catch (err) {
      rejectStreamPort(port, errorMessage(err));
    }
  });

  ipc.onPort("reader-library:get-audio-stream", (port, request) => {
    if (readerLibraryShuttingDown) {
      rejectStreamPort(port, READER_LIBRARY_SHUTTING_DOWN_MESSAGE);
      return;
    }
    if (!isRecord(request)) {
      rejectStreamPort(port, "Invalid Reader audio lookup request.");
      return;
    }
    try {
      getReaderLibraryWorker().getAudio(port, request.documentId, request.sectionId);
    } catch (err) {
      rejectStreamPort(port, errorMessage(err));
    }
  });

  ipc.on("reader-library:flush-complete", (_event, request) => {
    if (!isRecord(request) || typeof request.token !== "string") return;
    const acknowledge = pendingReaderLibraryFlushes.get(request.token);
    if (!acknowledge) return;
    pendingReaderLibraryFlushes.delete(request.token);
    acknowledge();
  });

  ipc.handle("reader-library:delete-audio", (_event, request) => {
    if (!isRecord(request)) throw new TypeError("Invalid Reader library audio deletion request.");
    return getReaderLibraryWorker().request("deleteAudio", [request.documentId, request.sectionId]);
  });

  return {
    name: "reader-library",
    // The renderers are still alive when the quit starts and the barrier holds
    // them open, so collect their debounced Reader edits before the worker
    // stops accepting work; closing it first is what silently dropped the last
    // edit.
    beginShutdown() {
      if (readerLibraryWorker || BrowserWindow.getAllWindows().length > 0) {
        return requestReaderLibraryFlush().then(closeReaderLibraryWorker, closeReaderLibraryWorker);
      }
      readerLibraryShuttingDown = true;
      return null;
    },
  };
}
