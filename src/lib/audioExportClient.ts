import type { AudioExportOptions } from "../types";
import { downloadBlob } from "./exportAudio";

export interface AudioExportSourceChunk {
  audio: Float32Array;
  samplingRate: number;
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

export async function downloadAudioChunks(
  chunks: readonly AudioExportSourceChunk[],
  options?: AudioExportOptions,
): Promise<void> {
  if (chunks.length === 0) return;

  const exportOptions = options ?? DEFAULT_EXPORT_OPTIONS;
  const exportChunks = chunks.map((chunk) => ({
    audio: chunk.audio.slice(0),
    samplingRate: chunk.samplingRate,
  }));
  const transferList = exportChunks.map((chunk) => chunk.audio.buffer as ArrayBuffer);

  const worker = new Worker(
    new URL("../workers/export.worker.ts", import.meta.url),
    { type: "module" },
  );

  try {
    await new Promise<void>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent) => {
        const msg = event.data as { type: string; blob?: Blob; extension?: string; message?: string };
        if (msg.type === "EXPORT_DONE" && msg.blob && msg.extension) {
          downloadBlob(msg.blob, `tts-audio.${msg.extension}`);
          resolve();
        } else if (msg.type === "EXPORT_ERROR") {
          reject(new Error(msg.message ?? "Export failed"));
        }
      };
      worker.onerror = (event) => reject(new Error(event.message));
      worker.postMessage({ type: "EXPORT", chunks: exportChunks, options: exportOptions }, transferList);
    });
  } catch (error) {
    console.error("Failed to export audio:", error);
    throw error;
  } finally {
    worker.terminate();
  }
}
