/**
 * Export Worker
 *
 * Runs buildExportAudio() off the main thread so WAV/MP3 encoding
 * does not block the UI. Chunks are received as Transferables (zero-copy).
 */

import { buildExportAudio } from "../lib/exportAudio";
import type { AudioExportOptions } from "../types";
import type { ExportChunk } from "../lib/exportAudio";

type ExportWorkerInMessage = {
  type: "EXPORT";
  chunks: ExportChunk[];
  options: AudioExportOptions;
};

type ExportWorkerOutMessage =
  | { type: "EXPORT_DONE"; blob: Blob; extension: string }
  | { type: "EXPORT_ERROR"; message: string };

function post(msg: ExportWorkerOutMessage) {
  self.postMessage(msg);
}

self.onmessage = async (e: MessageEvent<ExportWorkerInMessage>) => {
  const { chunks, options } = e.data;
  try {
    const result = await buildExportAudio(chunks, options);
    post({ type: "EXPORT_DONE", blob: result.blob, extension: result.extension });
  } catch (err) {
    post({ type: "EXPORT_ERROR", message: err instanceof Error ? err.message : String(err) });
  }
};
