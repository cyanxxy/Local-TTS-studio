import { EventEmitter } from "events";
import { PassThrough } from "stream";
import type { spawn } from "child_process";
import { describe, expect, it, vi } from "vitest";
import { parseHfXetProgressLine, runHfXetDownloader } from "./hfXetDownload";

describe("parseHfXetProgressLine", () => {
  it("accepts bounded Xet progress events", () => {
    expect(parseHfXetProgressLine('{"downloadedBytes":25,"totalBytes":100}')).toEqual({
      downloadedBytes: 25,
      totalBytes: 100,
    });
    expect(parseHfXetProgressLine('{"downloadedBytes":125,"totalBytes":100}')).toEqual({
      downloadedBytes: 100,
      totalBytes: 100,
    });
  });

  it("ignores malformed diagnostic output", () => {
    expect(parseHfXetProgressLine("loading model")).toBeNull();
    expect(parseHfXetProgressLine('{"downloadedBytes":-1,"totalBytes":100}')).toBeNull();
    expect(parseHfXetProgressLine('{"downloadedBytes":1,"totalBytes":0}')).toBeNull();
  });
});

describe("runHfXetDownloader", () => {
  it("does not settle cancellation until the downloader process closes", async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    const controller = new AbortController();
    const download = runHfXetDownloader({
      binaryPath: "/fake/downloader",
      modelRepo: "owner/model",
      revision: "revision",
      fileName: "weights.bin",
      destination: "/tmp/weights.bin",
      onProgress: () => {},
      signal: controller.signal,
      spawnProcess,
    });
    let settled = false;
    void download.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    controller.abort();
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(settled).toBe(false);

    child.emit("close", null, "SIGTERM");
    await expect(download).rejects.toThrow(/cancelled/i);
    expect(settled).toBe(true);
  });
});
