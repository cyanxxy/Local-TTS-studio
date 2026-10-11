/**
 * Messages between `audioExportClient` and the export worker.
 *
 * The client sends EXPORT_BEGIN, then one EXPORT_CHUNK per chunk (each
 * transferring its own copy of the PCM, so the main thread only ever copies
 * one chunk at a time), then EXPORT_END. The worker answers with
 * EXPORT_PROGRESS messages and finally EXPORT_DONE or EXPORT_ERROR.
 * Cancelling terminates the worker.
 */
import type { ExportChunk, ExportOptions, ExportPhase, ExportResult } from "../exportAudio";

export type ExportWorkerInMessage =
  | { type: "EXPORT_BEGIN"; options: ExportOptions; chunkCount: number }
  | { type: "EXPORT_CHUNK"; chunk: ExportChunk }
  | { type: "EXPORT_END" };

export type ExportWorkerOutMessage =
  | { type: "EXPORT_PROGRESS"; phase: ExportPhase; fraction: number }
  | ({ type: "EXPORT_DONE" } & ExportResult)
  | { type: "EXPORT_ERROR"; message: string };
