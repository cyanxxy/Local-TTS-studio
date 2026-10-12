/**
 * Export Worker
 *
 * Runs buildExportAudio() off the main thread so resampling, mastering and
 * encoding do not block the UI. Chunks arrive one message at a time as
 * Transferables (zero-copy); see src/lib/audio/exportProtocol.ts.
 */

import type { ExportWorkerInMessage, ExportWorkerOutMessage } from "../lib/audio/exportProtocol";
import { buildExportAudio, type ExportChunk, type ExportOptions } from "../lib/exportAudio";

function post(msg: ExportWorkerOutMessage) {
  self.postMessage(msg);
}

let job: { options: ExportOptions; chunkCount: number; chunks: ExportChunk[] } | null = null;

async function finish(): Promise<void> {
  const current = job;
  job = null;
  if (!current) throw new Error("The export was never started.");
  if (current.chunks.length !== current.chunkCount) {
    throw new Error(`Expected ${current.chunkCount} audio chunks but received ${current.chunks.length}.`);
  }
  const result = await buildExportAudio(current.chunks, current.options, {
    onProgress: (progress) => post({ type: "EXPORT_PROGRESS", ...progress }),
  });
  post({ type: "EXPORT_DONE", ...result });
}

self.onmessage = async (e: MessageEvent<ExportWorkerInMessage>) => {
  const message = e.data;
  try {
    switch (message.type) {
      case "EXPORT_BEGIN":
        job = { options: message.options, chunkCount: message.chunkCount, chunks: [] };
        break;
      case "EXPORT_CHUNK":
        if (!job) throw new Error("Received audio before the export started.");
        job.chunks.push(message.chunk);
        break;
      case "EXPORT_END":
        await finish();
        break;
      default:
        throw new Error("Unknown export message.");
    }
  } catch (err) {
    job = null;
    post({ type: "EXPORT_ERROR", message: err instanceof Error ? err.message : String(err) });
  }
};
