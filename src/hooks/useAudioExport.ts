import { useCallback, useEffect, useRef, useState } from "react";
import type { AudioExportRequest } from "../lib/audioExportClient";
import type { LoudnessReport } from "../lib/audio/loudness";
import type { ExportOptions, ExportProgress, ExportResult } from "../lib/exportAudio";

/** What a finished export reports, for the loudness line under the export controls. */
export interface ExportSummary {
  extension: string;
  report: LoudnessReport;
  /** Gain mastering applied, in dB (0 when mastering was off). */
  gainDb: number;
  /** Deepest true-peak limiter reduction, in dB. */
  limiterReductionDb: number;
  mastered: boolean;
}

interface Options {
  download: (options: ExportOptions, request: AudioExportRequest) => Promise<ExportResult | null>;
  options: ExportOptions;
  /** The file name (no extension) for an export started now. */
  getFileName: () => string;
  onError: (message: string) => void;
  /** Runs when an export starts, e.g. to clear an earlier error. */
  onStart?: () => void;
}

export interface UseAudioExportReturn {
  isExporting: boolean;
  progress: ExportProgress | null;
  summary: ExportSummary | null;
  start: () => void;
  cancel: () => void;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * Runs one audio export at a time through the export worker, with progress,
 * cancel, and the loudness report of the last finished export.
 */
export function useAudioExport({ download, options, getFileName, onError, onStart }: Options): UseAudioExportReturn {
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [summary, setSummary] = useState<ExportSummary | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const start = useCallback(() => {
    if (controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    onStart?.();
    setSummary(null);
    setProgress({ phase: "analyzing", fraction: 0 });
    let lastPercent = -1;
    download(options, {
      signal: controller.signal,
      fileName: getFileName(),
      onProgress: (next) => {
        const percent = Math.round(next.fraction * 100);
        if (percent === lastPercent) return;
        lastPercent = percent;
        setProgress(next);
      },
    }).then((result) => {
      if (!result) return;
      setSummary({
        extension: result.extension,
        report: result.report,
        gainDb: result.gainDb,
        limiterReductionDb: result.limiterReductionDb,
        mastered: options.mastering.enabled,
      });
    }, (error: unknown) => {
      if (!isAbort(error)) onError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (controllerRef.current === controller) controllerRef.current = null;
      setProgress(null);
    });
  }, [download, getFileName, onError, onStart, options]);

  const cancel = useCallback(() => controllerRef.current?.abort(), []);

  return { isExporting: progress !== null, progress, summary, start, cancel };
}
