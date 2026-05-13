import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerInMessage } from "../types";

const downloadBlob = vi.hoisted(() => vi.fn());

vi.mock("./exportAudio", () => ({
  downloadBlob,
}));

type ExportWorkerMessage = {
  type: "EXPORT";
  chunks: Array<{ audio: Float32Array; samplingRate: number }>;
  options: unknown;
};

class MockExportWorker {
  static instances: MockExportWorker[] = [];

  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onerror: ((event: ErrorEvent) => void) | null = null;
  public posted: ExportWorkerMessage[] = [];
  public transferList: Transferable[] = [];
  public terminated = false;

  public url: URL;
  public options: WorkerOptions;

  constructor(url: URL, options: WorkerOptions) {
    this.url = url;
    this.options = options;
    MockExportWorker.instances.push(this);
  }

  postMessage(message: WorkerInMessage, transferList?: Transferable[]): void {
    this.posted.push(message as unknown as ExportWorkerMessage);
    this.transferList = transferList ?? [];
  }

  terminate(): void {
    this.terminated = true;
  }
}

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

    await downloadAudioChunks([]);

    expect(MockExportWorker.instances).toHaveLength(0);
  });

  it("exports copied chunks through a module worker and downloads the result", async () => {
    const { downloadAudioChunks } = await loadModule();
    const chunkAudio = new Float32Array([0.1, 0.2]);
    const promise = downloadAudioChunks([{ audio: chunkAudio, samplingRate: 24000 }]);

    const worker = MockExportWorker.instances[0];
    expect(worker.options).toEqual({ type: "module" });
    expect(worker.posted[0].chunks[0].audio).not.toBe(chunkAudio);
    expect(Array.from(worker.posted[0].chunks[0].audio)).toEqual([
      expect.closeTo(0.1),
      expect.closeTo(0.2),
    ]);
    expect(worker.transferList).toEqual([worker.posted[0].chunks[0].audio.buffer]);

    worker.onmessage?.({
      data: {
        type: "EXPORT_DONE",
        blob: new Blob(["ok"]),
        extension: "wav",
      },
    } as MessageEvent);

    await promise;

    expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), "tts-audio.wav");
    expect(worker.terminated).toBe(true);
  });

  it("logs worker export errors and terminates the worker", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { downloadAudioChunks } = await loadModule();
    const promise = downloadAudioChunks([{
      audio: new Float32Array([0]),
      samplingRate: 24000,
    }]);

    const worker = MockExportWorker.instances[0];
    worker.onmessage?.({ data: { type: "EXPORT_ERROR", message: "bad export" } } as MessageEvent);
    await promise;

    expect(consoleError).toHaveBeenCalledWith("Failed to export audio:", expect.any(Error));
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(worker.terminated).toBe(true);
  });

  it("logs generic worker failures", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { downloadAudioChunks } = await loadModule();
    const promise = downloadAudioChunks([{
      audio: new Float32Array([0]),
      samplingRate: 24000,
    }]);

    const worker = MockExportWorker.instances[0];
    worker.onerror?.({ message: "worker failed" } as ErrorEvent);
    await promise;

    expect(consoleError).toHaveBeenCalledWith("Failed to export audio:", expect.any(Error));
    expect(worker.terminated).toBe(true);
  });
});
