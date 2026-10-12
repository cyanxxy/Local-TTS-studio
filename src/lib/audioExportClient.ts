import type { AudioExportOptions } from "../types";
import type { ExportWorkerInMessage, ExportWorkerOutMessage } from "./audio/exportProtocol";
import { downloadBlob, type ExportOptions, type ExportProgress, type ExportResult } from "./exportAudio";

export interface AudioExportSourceChunk {
  audio: Float32Array;
  samplingRate: number;
  /** Trailing pause the engine appended, used by post-processing. */
  pauseAfterSec?: number;
}

export interface AudioExportRequest {
  /** Aborting terminates the worker and rejects with an AbortError. */
  signal?: AbortSignal;
  onProgress?: (progress: ExportProgress) => void;
  /** File name without extension; defaults to "tts-audio". */
  fileName?: string;
}

const DEFAULT_EXPORT_OPTIONS: AudioExportOptions = {
  format: "wav-f32",
  sampleRate: "source",
  bitrateKbps: 320,
  mastering: {
    enabled: false,
    targetLufs: -14,
    truePeakDb: -1,
  },
};

const DEFAULT_FILE_NAME = "tts-audio";
const MAX_FILE_NAME_PART = 60;

let activeExport = false;

/** Whether an export is running; only one runs at a time. */
export function isAudioExportRunning(): boolean {
  return activeExport;
}

function fileNamePart(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_FILE_NAME_PART)
    .trim()
    .replace(/\s/g, "-");
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * "Chapter One-af_heart-20261011-143005": title, voice and local time,
 * with characters that are invalid in file names removed.
 */
export function buildExportFileName(parts: { title?: string; voice?: string; date?: Date }): string {
  const date = parts.date ?? new Date();
  const stamp = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
  return [fileNamePart(parts.title), fileNamePart(parts.voice), stamp].filter(Boolean).join("-");
}

function abortError(): DOMException {
  return new DOMException("The export was cancelled.", "AbortError");
}

/**
 * Renders chunks in the export worker. Chunks are copied and transferred one
 * at a time, so the main thread never holds a second full copy of the audio.
 */
export async function exportAudioChunks(
  chunks: readonly AudioExportSourceChunk[],
  options: ExportOptions = DEFAULT_EXPORT_OPTIONS,
  request: AudioExportRequest = {},
): Promise<ExportResult> {
  if (activeExport) throw new Error("An audio export is already running.");
  if (request.signal?.aborted) throw abortError();

  const worker = new Worker(
    new URL("../workers/export.worker.ts", import.meta.url),
    { type: "module" },
  );
  activeExport = true;
  const send = (message: ExportWorkerInMessage, transfer: Transferable[] = []) => worker.postMessage(message, transfer);
  let resolveExport!: (result: ExportResult) => void;
  let rejectExport!: (error: Error) => void;
  const done = new Promise<ExportResult>((resolve, reject) => {
    resolveExport = resolve;
    rejectExport = reject;
  });
  const onAbort = () => rejectExport(abortError());
  request.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    worker.onmessage = (event: MessageEvent<ExportWorkerOutMessage>) => {
      const msg = event.data;
      if (msg.type === "EXPORT_PROGRESS") {
        request.onProgress?.({ phase: msg.phase, fraction: msg.fraction });
      } else if (msg.type === "EXPORT_DONE") {
        resolveExport({
          blob: msg.blob,
          extension: msg.extension,
          report: msg.report,
          timings: msg.timings,
          gainDb: msg.gainDb,
          limiterReductionDb: msg.limiterReductionDb,
        });
      } else {
        rejectExport(new Error(msg.message));
      }
    };
    worker.onerror = (event) => rejectExport(new Error(event.message || "Export failed"));

    send({ type: "EXPORT_BEGIN", options, chunkCount: chunks.length });
    for (const chunk of chunks) {
      const audio = chunk.audio.slice(0);
      send({
        type: "EXPORT_CHUNK",
        chunk: {
          audio,
          samplingRate: chunk.samplingRate,
          ...(chunk.pauseAfterSec === undefined ? {} : { pauseAfterSec: chunk.pauseAfterSec }),
        },
      }, [audio.buffer]);
    }
    send({ type: "EXPORT_END" });
    return await done;
  } finally {
    request.signal?.removeEventListener("abort", onAbort);
    worker.terminate();
    activeExport = false;
  }
}

/**
 * Exports chunks and downloads the file as `<fileName>.<extension>`. Use
 * `exportAudioChunks` to also get the loudness report and timeline.
 */
export async function downloadAudioChunks(
  chunks: readonly AudioExportSourceChunk[],
  options?: ExportOptions,
  request: AudioExportRequest = {},
): Promise<void> {
  if (chunks.length === 0) return;

  try {
    const result = await exportAudioChunks(chunks, options ?? DEFAULT_EXPORT_OPTIONS, request);
    downloadBlob(result.blob, `${fileNamePart(request.fileName) || DEFAULT_FILE_NAME}.${result.extension}`);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      console.error("Failed to export audio:", error);
    }
    throw error;
  }
}
