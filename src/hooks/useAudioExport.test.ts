import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ExportOptions, ExportResult } from "../lib/exportAudio";
import { useAudioExport } from "./useAudioExport";

const OPTIONS: ExportOptions = {
  format: "flac-16",
  sampleRate: 48000,
  bitrateKbps: 192,
  mastering: { enabled: true, targetLufs: -14, truePeakDb: -1 },
};

const RESULT = {
  blob: new Blob(["x"]),
  extension: "flac",
  report: { integratedLufs: -14, loudnessRangeLu: 4, truePeakDbtp: -1, samplePeakDbfs: -2, rmsDbfs: -18, durationSec: 3 },
  timings: [],
  gainDb: 1.5,
  limiterReductionDb: 0.4,
} as unknown as ExportResult;

type Download = Parameters<typeof useAudioExport>[0]["download"];

function setup(download: Download) {
  const onError = vi.fn();
  const onStart = vi.fn();
  const getFileName = vi.fn(() => "Story-af_heart-20261012-120000");
  const view = renderHook(() => useAudioExport({ download, options: OPTIONS, getFileName, onError, onStart }));
  return { ...view, onError, onStart, getFileName };
}

/** A download the test settles by hand. */
function deferredDownload() {
  let resolve!: (result: ExportResult | null) => void;
  let reject!: (error: unknown) => void;
  let request!: Parameters<Download>[1];
  const download = vi.fn((_options: ExportOptions, next: Parameters<Download>[1]) => {
    request = next;
    return new Promise<ExportResult | null>((res, rej) => {
      resolve = res;
      reject = rej;
    });
  });
  return { download, resolve: (result: ExportResult | null) => resolve(result), reject: (error: unknown) => reject(error), request: () => request };
}

describe("useAudioExport", () => {
  it("runs an export with a file name, tracks its progress and reports the loudness", async () => {
    const deferred = deferredDownload();
    const { result, onStart, getFileName } = setup(deferred.download);
    expect(result.current).toMatchObject({ isExporting: false, progress: null, summary: null });

    act(() => result.current.start());

    expect(onStart).toHaveBeenCalledOnce();
    expect(deferred.download).toHaveBeenCalledWith(OPTIONS, expect.objectContaining({ fileName: "Story-af_heart-20261012-120000" }));
    expect(getFileName).toHaveBeenCalledOnce();
    expect(result.current.isExporting).toBe(true);
    expect(result.current.progress).toEqual({ phase: "analyzing", fraction: 0 });

    act(() => deferred.request().onProgress?.({ phase: "encoding", fraction: 0.5 }));
    expect(result.current.progress).toEqual({ phase: "encoding", fraction: 0.5 });
    // A change below one percent is not worth a render.
    act(() => deferred.request().onProgress?.({ phase: "encoding", fraction: 0.504 }));
    expect(result.current.progress?.fraction).toBe(0.5);

    await act(async () => deferred.resolve(RESULT));

    expect(result.current.isExporting).toBe(false);
    expect(result.current.summary).toEqual({
      extension: "flac",
      report: RESULT.report,
      gainDb: 1.5,
      limiterReductionDb: 0.4,
      mastered: true,
    });
  });

  it("runs one export at a time and clears the last report when a new one starts", async () => {
    const first = deferredDownload();
    const { result } = setup(first.download);
    act(() => result.current.start());
    act(() => result.current.start());
    expect(first.download).toHaveBeenCalledOnce();
    await act(async () => first.resolve(RESULT));
    expect(result.current.summary).not.toBeNull();

    act(() => result.current.start());
    expect(result.current.summary).toBeNull();
    expect(first.download).toHaveBeenCalledTimes(2);
  });

  it("cancels through the abort signal without reporting an error", async () => {
    const deferred = deferredDownload();
    const { result, onError } = setup(deferred.download);
    act(() => result.current.start());
    const { signal } = deferred.request();
    expect(signal?.aborted).toBe(false);

    act(() => result.current.cancel());
    expect(signal?.aborted).toBe(true);
    await act(async () => deferred.reject(new DOMException("The export was cancelled.", "AbortError")));

    expect(onError).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ isExporting: false, progress: null, summary: null });
  });

  it("reports a failed export", async () => {
    const deferred = deferredDownload();
    const { result, onError } = setup(deferred.download);
    act(() => result.current.start());
    await act(async () => deferred.reject(new Error("Encoder crashed")));
    expect(onError).toHaveBeenCalledWith("Encoder crashed");

    act(() => result.current.start());
    await act(async () => deferred.reject("plain failure"));
    expect(onError).toHaveBeenLastCalledWith("plain failure");
    expect(result.current.isExporting).toBe(false);
  });

  it("has nothing to report when there was no audio to export", async () => {
    const deferred = deferredDownload();
    const { result, onError } = setup(deferred.download);
    act(() => result.current.start());
    await act(async () => deferred.resolve(null));
    expect(result.current.summary).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it("works without an onStart callback and aborts a running export on unmount", () => {
    const deferred = deferredDownload();
    const view = renderHook(() => useAudioExport({
      download: deferred.download,
      options: OPTIONS,
      getFileName: () => "name",
      onError: vi.fn(),
    }));
    act(() => view.result.current.start());
    const { signal } = deferred.request();

    view.unmount();

    expect(signal?.aborted).toBe(true);
  });

  it("cancel does nothing when no export runs", () => {
    const { result } = setup(vi.fn());
    expect(() => act(() => result.current.cancel())).not.toThrow();
  });
});
