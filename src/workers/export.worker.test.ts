import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExportOptions } from "../lib/exportAudio";

const buildExportAudio = vi.hoisted(() => vi.fn());

vi.mock("../lib/exportAudio", () => ({
  buildExportAudio,
}));

const OPTIONS: ExportOptions = {
  format: "wav-f32",
  sampleRate: "source",
  bitrateKbps: 320,
  mastering: {
    enabled: false,
    targetLufs: -14,
    truePeakDb: -1,
  },
};

const CHUNK = { audio: new Float32Array([0]), samplingRate: 24000 };

async function loadWorker() {
  vi.resetModules();
  const posted: unknown[] = [];
  const workerGlobal = {
    postMessage: vi.fn((message: unknown) => {
      posted.push(message);
    }),
    onmessage: null as ((event: MessageEvent) => Promise<void>) | null,
  };
  vi.stubGlobal("self", workerGlobal);
  await import("./export.worker");
  const send = (data: unknown) => workerGlobal.onmessage?.({ data } as MessageEvent);
  return { posted, send };
}

describe("export.worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("collects streamed chunks, reports progress and posts the result", async () => {
    const blob = new Blob(["wav"], { type: "audio/wav" });
    const result = { blob, extension: "wav", report: {}, timings: [], gainDb: 0, limiterReductionDb: 0 };
    buildExportAudio.mockImplementation(async (_chunks, _options, hooks: { onProgress: (progress: unknown) => void }) => {
      hooks.onProgress({ phase: "encoding", fraction: 0.5 });
      return result;
    });
    const { posted, send } = await loadWorker();

    await send({ type: "EXPORT_BEGIN", options: OPTIONS, chunkCount: 2 });
    await send({ type: "EXPORT_CHUNK", chunk: CHUNK });
    await send({ type: "EXPORT_CHUNK", chunk: CHUNK });
    await send({ type: "EXPORT_END" });

    expect(buildExportAudio).toHaveBeenCalledWith([CHUNK, CHUNK], OPTIONS, expect.any(Object));
    expect(posted).toEqual([
      { type: "EXPORT_PROGRESS", phase: "encoding", fraction: 0.5 },
      { type: "EXPORT_DONE", ...result },
    ]);
  });

  it("posts Error and non-Error export failures", async () => {
    buildExportAudio.mockRejectedValueOnce(new Error("bad export")).mockRejectedValueOnce("plain failure");
    const { posted, send } = await loadWorker();

    for (const message of ["bad export", "plain failure"]) {
      await send({ type: "EXPORT_BEGIN", options: OPTIONS, chunkCount: 1 });
      await send({ type: "EXPORT_CHUNK", chunk: CHUNK });
      await send({ type: "EXPORT_END" });
      expect(posted.at(-1)).toEqual({ type: "EXPORT_ERROR", message });
    }
  });

  it("rejects messages out of order and incomplete exports", async () => {
    const { posted, send } = await loadWorker();

    await send({ type: "EXPORT_CHUNK", chunk: CHUNK });
    expect(posted.at(-1)).toEqual({ type: "EXPORT_ERROR", message: "Received audio before the export started." });

    await send({ type: "EXPORT_END" });
    expect(posted.at(-1)).toEqual({ type: "EXPORT_ERROR", message: "The export was never started." });

    await send({ type: "EXPORT_BEGIN", options: OPTIONS, chunkCount: 2 });
    await send({ type: "EXPORT_CHUNK", chunk: CHUNK });
    await send({ type: "EXPORT_END" });
    expect(posted.at(-1)).toEqual({ type: "EXPORT_ERROR", message: "Expected 2 audio chunks but received 1." });

    await send({ type: "EXPORT" });
    expect(posted.at(-1)).toEqual({ type: "EXPORT_ERROR", message: "Unknown export message." });
    expect(buildExportAudio).not.toHaveBeenCalled();
  });
});
