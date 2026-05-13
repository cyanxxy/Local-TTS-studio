import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioExportOptions } from "../types";

const buildExportAudio = vi.hoisted(() => vi.fn());

vi.mock("../lib/exportAudio", () => ({
  buildExportAudio,
}));

const OPTIONS: AudioExportOptions = {
  format: "wav-f32",
  sampleRate: "source",
  bitrateKbps: 320,
  mastering: {
    enabled: false,
    targetLufs: -14,
    truePeakDb: -1,
  },
};

async function loadWorker() {
  vi.resetModules();
  const posted: unknown[] = [];
  const workerGlobal = {
    postMessage: vi.fn((message: unknown) => {
      posted.push(message);
    }),
    onmessage: null as ((event: MessageEvent) => void) | null,
  };
  vi.stubGlobal("self", workerGlobal);
  await import("./export.worker");
  return { posted, workerGlobal };
}

describe("export.worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts successful export results", async () => {
    const blob = new Blob(["wav"], { type: "audio/wav" });
    buildExportAudio.mockResolvedValue({ blob, extension: "wav" });
    const { posted, workerGlobal } = await loadWorker();

    workerGlobal.onmessage?.({
      data: {
        type: "EXPORT",
        chunks: [{ audio: new Float32Array([0]), samplingRate: 24000 }],
        options: OPTIONS,
      },
    } as MessageEvent);

    await vi.waitFor(() => expect(posted).toEqual([{ type: "EXPORT_DONE", blob, extension: "wav" }]));
    expect(buildExportAudio).toHaveBeenCalledOnce();
  });

  it("posts Error and non-Error export failures", async () => {
    buildExportAudio.mockRejectedValueOnce(new Error("bad export")).mockRejectedValueOnce("plain failure");
    const { posted, workerGlobal } = await loadWorker();
    const message = {
      data: {
        type: "EXPORT",
        chunks: [{ audio: new Float32Array([0]), samplingRate: 24000 }],
        options: OPTIONS,
      },
    } as MessageEvent;

    workerGlobal.onmessage?.(message);
    await vi.waitFor(() => expect(posted.at(-1)).toEqual({ type: "EXPORT_ERROR", message: "bad export" }));

    workerGlobal.onmessage?.(message);
    await vi.waitFor(() => expect(posted.at(-1)).toEqual({ type: "EXPORT_ERROR", message: "plain failure" }));
  });
});
