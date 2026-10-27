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

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}

describe("runHfXetDownloader", () => {
  it("ties the downloader to this process through a stdin pipe it holds open", async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    const download = runHfXetDownloader({
      binaryPath: "/fake/downloader",
      modelRepo: "owner/model",
      revision: "revision",
      fileName: "weights.bin",
      destination: "/tmp/weights.bin",
      onProgress: () => {},
      spawnProcess,
    });

    // A main process killed outright never runs its SIGTERM/SIGKILL timers; the
    // OS closing this pipe is what stops the download then.
    expect(spawnProcess).toHaveBeenCalledWith(
      "/fake/downloader",
      expect.arrayContaining(["--exit-with-parent"]),
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
    );
    expect(child.stdin.writableEnded).toBe(false);
    // The downloader exiting first is not an error worth crashing over.
    expect(() => child.stdin.emit("error", new Error("EPIPE"))).not.toThrow();

    child.emit("close", 0, null);
    await expect(download).resolves.toBe(true);
  });

  it("does not settle cancellation until the downloader process closes", async () => {
    const child = fakeChild();
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
