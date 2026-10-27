import { BrowserWindow, dialog } from "electron";
import { randomUUID } from "crypto";
import type { ShutdownParticipant } from "../appShutdown";
import {
  MAX_IMPORT_PAGES,
  importDocumentFromDialog,
  type DocumentParser,
} from "../documentImport";
import { DocumentParseWorkerClient } from "../documentParseWorkerClient";
import { isRecord } from "../guards";
import { importRemoteDocument } from "../urlImport";
import type { TrustedIpc } from "./trusted";

const EPUB_TRANSFER_CHUNK_BYTES = 1024 * 1024;
const EPUB_TRANSFER_TTL_MS = 60_000;
// OCR and document conversion run in a one-shot worker thread. Terminating the
// worker at the deadline stops native parser CPU work as well as unblocking the
// renderer (the LibreOffice conversion it may have started is stopped
// separately; see documentConverterProcesses.ts), and releasing it after each
// import prevents LiteParse/native state from becoming part of the Electron
// main process's permanent footprint.
const IMPORT_PARSE_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingEpubTransfer {
  senderId: number;
  bytes: Uint8Array;
  expires: ReturnType<typeof setTimeout>;
}

export interface DocumentIpcOptions {
  /** The compiled document parse worker script. */
  parseWorkerPath: string;
}

/**
 * Registers document import (file dialog and URL) and the EPUB byte transfer
 * that follows a file import, and returns its part in the quit barrier.
 */
export function registerDocumentIpc(
  ipc: TrustedIpc,
  { parseWorkerPath }: DocumentIpcOptions,
): ShutdownParticipant {
  const pendingEpubTransfers = new Map<string, PendingEpubTransfer>();
  let documentParser: DocumentParseWorkerClient | null = null;

  function stageEpubTransfer(senderId: number, bytes: Uint8Array): string {
    const id = randomUUID();
    const expires = setTimeout(() => pendingEpubTransfers.delete(id), EPUB_TRANSFER_TTL_MS);
    expires.unref();
    pendingEpubTransfers.set(id, { senderId, bytes, expires });
    return id;
  }

  function getLiteParseDocumentParser(): Promise<DocumentParser> {
    if (!documentParser) {
      documentParser = new DocumentParseWorkerClient(
        parseWorkerPath,
        IMPORT_PARSE_TIMEOUT_MS,
        MAX_IMPORT_PAGES,
      );
    }
    return Promise.resolve(documentParser);
  }

  ipc.handle("document:import", async (event) => {
    // Attach the dialog to the requesting window (macOS modal sheet), which
    // also blocks mid-import text edits behind the dialog.
    const owner = BrowserWindow.fromWebContents(event.sender);
    const ownedDialog = {
      showOpenDialog: (options: Parameters<typeof dialog.showOpenDialog>[0]) => (
        owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options)
      ),
    };
    const result = await importDocumentFromDialog(ownedDialog, getLiteParseDocumentParser);
    if (result.canceled || !result.epubBytes) return result;
    const { epubBytes, ...metadata } = result;
    return {
      ...metadata,
      epubTransferId: stageEpubTransfer(event.sender.id, epubBytes),
      epubByteLength: epubBytes.byteLength,
    };
  });

  ipc.onPort("document:read-epub", (port, request, event) => {
    if (!isRecord(request) || typeof request.transferId !== "string") {
      // The port is main's now; answer on it so the renderer is not left
      // waiting out its transfer timeout.
      port.postMessage({ error: "The EPUB transfer request was invalid. Import the file again." });
      port.close();
      return;
    }
    const transfer = pendingEpubTransfers.get(request.transferId);
    if (!transfer || transfer.senderId !== event.sender.id) {
      port.postMessage({ error: "The EPUB transfer expired. Import the file again." });
      port.close();
      return;
    }
    pendingEpubTransfers.delete(request.transferId);
    clearTimeout(transfer.expires);

    let offset = 0;
    const sendNextChunk = () => {
      if (offset >= transfer.bytes.byteLength) {
        port.postMessage({ done: true });
        port.close();
        return;
      }
      const end = Math.min(transfer.bytes.byteLength, offset + EPUB_TRANSFER_CHUNK_BYTES);
      // `slice` (not `subarray`) is deliberate: structured clone of a typed
      // array serialises its whole backing ArrayBuffer, so a view would copy the
      // entire EPUB on every chunk. MessagePortMain only accepts MessagePortMain
      // in its transfer list, so the clone copy itself cannot be avoided.
      port.postMessage({ offset, chunk: transfer.bytes.slice(offset, end) });
      offset = end;
      setImmediate(sendNextChunk);
    };
    sendNextChunk();
  });

  ipc.handle("document:import-url", (_event, request) => {
    if (!isRecord(request) || typeof request.url !== "string" || request.url.length > 2048) {
      throw new Error("Invalid document URL.");
    }
    return importRemoteDocument(request.url);
  });

  return {
    name: "documents",
    beginShutdown() {
      // Holds the quit only while an abandoned import's LibreOffice is being
      // stopped; otherwise it would outlive the app.
      const stopped = documentParser?.close() ?? null;
      documentParser = null;
      return stopped;
    },
  };
}
