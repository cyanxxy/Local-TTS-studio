import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExportWorkerInMessage } from "./audio/exportProtocol";

const downloadBlob = vi.hoisted(() => vi.fn());

vi.mock("./exportAudio", () => ({
  downloadBlob,
}));

class MockExportWorker {
  static instances: MockExportWorker[] = [];

  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onerror: ((event: ErrorEvent) => void) | null = null;
  public posted: ExportWorkerInMessage[] = [];
  public transfers: Transferable[][] = [];
  public terminated = false;

  public url: URL;
  public options: WorkerOptions;

  constructor(url: URL, options: WorkerOptions) {
    this.url = url;
    this.options = options;
    MockExportWorker.instances.push(this);
  }

  postMessage(message: ExportWorkerInMessage, transferList?: Transferable[]): void {
    this.posted.push(message);
    this.transfers.push(transferList ?? []);
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

const RESULT = {
  blob: new Blob(["ok"]),
  extension: "wav",
  report: { integratedLufs: -14, loudnessRangeLu: 2, truePeakDbtp: -1, samplePeakDbfs: -1.2, rmsDbfs: -18, durationSec: 1 },
  timings: [],
  gainDb: 1.5,
  limiterReductionDb: 0,
};

async function loadModule() {
  vi.resetModules();
  return import("./audioExportClient");
}

describe("audioExportClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockExportWorker.instances = [];
    vi.stubGlobal("Worker", MockExportWorker);
  });

  it("does nothing when there are no chunks", async () => {
    const { downloadAudioChunks } = await loadModule();

    await expect(downloadAudioChunks([])).resolves.toBeUndefined();

    expect(MockExportWorker.instances).toHaveLength(0);
  });

  it("streams copied chunks to a module worker one transfer at a time and downloads the result", async () => {
    const { downloadAudioChunks, isAudioExportRunning } = await loadModule();
    const first = new Float32Array([0.1, 0.2]);
    const second = new Float32Array([0.3]);
    const onProgress = vi.fn();
    const promise = downloadAudioChunks(
      [{ audio: first, samplingRate: 24000, pauseAfterSec: 0.4 }, { audio: second, samplingRate: 24000 }],
      undefined,
      { onProgress },
    );

    const worker = MockExportWorker.instances[0];
    expect(worker.options).toEqual({ type: "module" });
    expect(isAudioExportRunning()).toBe(true);
    expect(worker.posted.map((message) => message.type)).toEqual(["EXPORT_BEGIN", "EXPORT_CHUNK", "EXPORT_CHUNK", "EXPORT_END"]);
    expect(worker.posted[0]).toMatchObject({ chunkCount: 2, options: { format: "wav-f32", sampleRate: "source" } });
    const sent = worker.posted[1] as Extract<ExportWorkerInMessage, { type: "EXPORT_CHUNK" }>;
    expect(sent.chunk.audio).not.toBe(first);
    expect(Array.from(sent.chunk.audio)).toEqual([expect.closeTo(0.1), expect.closeTo(0.2)]);
    expect(sent.chunk.pauseAfterSec).toBe(0.4);
    expect(worker.transfers[1]).toEqual([sent.chunk.audio.buffer]);
    expect((worker.posted[2] as typeof sent).chunk).not.toHaveProperty("pauseAfterSec");
    expect(worker.transfers[0]).toEqual([]);

    worker.reply({ type: "EXPORT_PROGRESS", phase: "encoding", fraction: 0.5 });
    worker.reply({ type: "EXPORT_DONE", ...RESULT });

    await expect(promise).resolves.toBeUndefined();
    expect(onProgress).toHaveBeenCalledWith({ phase: "encoding", fraction: 0.5 });
    expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), "tts-audio.wav");
    expect(worker.terminated).toBe(true);
    expect(isAudioExportRunning()).toBe(false);
  });

  it("uses a sanitized file name", async () => {
    const { downloadAudioChunks } = await loadModule();
    const promise = downloadAudioChunks([{ audio: new Float32Array([0]), samplingRate: 24000 }], undefined, {
      fileName: ' My: "Story" / part 1 ',
    });
    MockExportWorker.instances[0].reply({ type: "EXPORT_DONE", ...RESULT, extension: "mp3" });
    await promise;
    expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), "My-Story-part-1.mp3");
  });

  it("runs one export at a time", async () => {
    const { exportAudioChunks } = await loadModule();
    const chunk = { audio: new Float32Array([0]), samplingRate: 24000 };
    const first = exportAudioChunks([chunk]);
    await expect(exportAudioChunks([chunk])).rejects.toThrow("already running");
    MockExportWorker.instances[0].reply({ type: "EXPORT_DONE", ...RESULT });
    await first;
    const second = exportAudioChunks([chunk]);
    MockExportWorker.instances[1].reply({ type: "EXPORT_DONE", ...RESULT });
    await expect(second).resolves.toEqual(RESULT);
  });

  it("cancels by terminating the worker", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { downloadAudioChunks, isAudioExportRunning } = await loadModule();
    const controller = new AbortController();
    const promise = downloadAudioChunks([{ audio: new Float32Array([0]), samplingRate: 24000 }], undefined, {
      signal: controller.signal,
    });

    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(MockExportWorker.instances[0].terminated).toBe(true);
    expect(isAudioExportRunning()).toBe(false);
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("rejects an already cancelled request without starting a worker", async () => {
    const { exportAudioChunks } = await loadModule();
    const controller = new AbortController();
    controller.abort();
    await expect(exportAudioChunks([{ audio: new Float32Array([0]), samplingRate: 24000 }], undefined, { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(MockExportWorker.instances).toHaveLength(0);
  });

  it("rejects worker export errors and terminates the worker", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { downloadAudioChunks } = await loadModule();
    const promise = downloadAudioChunks([{ audio: new Float32Array([0]), samplingRate: 24000 }]);

    const worker = MockExportWorker.instances[0];
    worker.reply({ type: "EXPORT_ERROR", message: "bad export" });
    await expect(promise).rejects.toThrow("bad export");

    expect(consoleError).toHaveBeenCalledWith("Failed to export audio:", expect.any(Error));
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(worker.terminated).toBe(true);
  });

  it("rejects generic worker failures", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { downloadAudioChunks } = await loadModule();
    const first = downloadAudioChunks([{ audio: new Float32Array([0]), samplingRate: 24000 }]);
    MockExportWorker.instances[0].onerror?.({ message: "worker failed" } as ErrorEvent);
    await expect(first).rejects.toThrow("worker failed");

    const second = downloadAudioChunks([{ audio: new Float32Array([0]), samplingRate: 24000 }]);
    MockExportWorker.instances[1].onerror?.({ message: "" } as ErrorEvent);
    await expect(second).rejects.toThrow("Export failed");

    expect(consoleError).toHaveBeenCalledWith("Failed to export audio:", expect.any(Error));
    expect(MockExportWorker.instances.every((worker) => worker.terminated)).toBe(true);
  });
});

describe("buildExportFileName", () => {
  it("joins title, voice and a local timestamp", async () => {
    const { buildExportFileName } = await loadModule();
    const date = new Date(2026, 9, 11, 14, 30, 5);
    expect(buildExportFileName({ title: "Chapter One: The Start", voice: "af_heart", date })).toBe(
      "Chapter-One-The-Start-af_heart-20261011-143005",
    );
    expect(buildExportFileName({ title: " \u0000 ", date })).toBe("20261011-143005");
    expect(buildExportFileName({ title: "x".repeat(100), date }).length).toBe(60 + 1 + 15);
    expect(buildExportFileName({})).toMatch(/^\d{8}-\d{6}$/);
  });
});
