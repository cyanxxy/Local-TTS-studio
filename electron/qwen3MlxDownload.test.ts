// @vitest-environment node

import fs from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";
import type { IncomingMessage } from "http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildQwen3SetupWarnings,
  createQwen3MlxDownloadCoordinator,
  createSafeProgressSender,
  downloadHuggingFaceFile,
  downloadQwen3MlxModel,
  IDLE_DOWNLOAD_TIMEOUT_MS,
  isAllowedHuggingFaceDownloadHost,
  isSafeHuggingFaceFileName,
  listHuggingFaceModelFiles,
  requestUrl,
  resolveDownloadDestination,
  type Qwen3MlxDownloadProgress,
  type Qwen3MlxDownloadResult,
  type UrlRequest,
} from "./qwen3MlxDownload";

const PROGRESS: Qwen3MlxDownloadProgress = {
  modelRepo: "mlx-community/example",
  modelDir: "/cache/qwen3/mlx/example",
  fileName: "config.json",
  fileIndex: 1,
  totalFiles: 2,
  downloadedBytes: 10,
};

function fakeResponse(
  body: string | Buffer,
  { statusCode = 200, headers = {} }: { statusCode?: number; headers?: Record<string, string> } = {},
): IncomingMessage {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf-8");
  const response = Readable.from([buffer]) as unknown as IncomingMessage;
  Object.assign(response, {
    statusCode,
    headers: { "content-length": String(buffer.byteLength), ...headers },
  });
  return response;
}

function fakeHubRequest(siblings: Array<{ rfilename?: unknown }>): UrlRequest {
  return (url) => {
    if (url.includes("/api/models/")) {
      return Promise.resolve(fakeResponse(JSON.stringify({ siblings })));
    }
    const fileName = decodeURIComponent(url.split("/resolve/main/")[1]);
    return Promise.resolve(fakeResponse(`DATA:${fileName}`));
  };
}

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-tts-qwen3-mlx-download-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("createSafeProgressSender", () => {
  it("sends progress while the target is alive", () => {
    const send = vi.fn();
    const sender = createSafeProgressSender({ isDestroyed: () => false, send }, "channel");
    sender(PROGRESS);
    expect(send).toHaveBeenCalledWith("channel", PROGRESS);
  });

  it("skips sends once the target window is destroyed", () => {
    const send = vi.fn();
    const sender = createSafeProgressSender({ isDestroyed: () => true, send }, "channel");
    sender(PROGRESS);
    expect(send).not.toHaveBeenCalled();
  });

  it("swallows sends that throw because the target was destroyed mid-send", () => {
    const sender = createSafeProgressSender(
      {
        isDestroyed: () => false,
        send: () => {
          throw new Error("Object has been destroyed");
        },
      },
      "channel",
    );
    expect(() => sender(PROGRESS)).not.toThrow();
  });
});

describe("isSafeHuggingFaceFileName", () => {
  it("accepts plain and nested file names", () => {
    expect(isSafeHuggingFaceFileName("config.json")).toBe(true);
    expect(isSafeHuggingFaceFileName("sub/dir/model.safetensors")).toBe(true);
  });

  it("rejects traversal, backslashes, and degenerate parts", () => {
    expect(isSafeHuggingFaceFileName("../evil")).toBe(false);
    expect(isSafeHuggingFaceFileName("a/../b")).toBe(false);
    expect(isSafeHuggingFaceFileName("..\\evil")).toBe(false);
    expect(isSafeHuggingFaceFileName("a\\b")).toBe(false);
    expect(isSafeHuggingFaceFileName("a//b")).toBe(false);
    expect(isSafeHuggingFaceFileName("./a")).toBe(false);
    expect(isSafeHuggingFaceFileName("")).toBe(false);
    expect(isSafeHuggingFaceFileName("a\0b")).toBe(false);
    expect(isSafeHuggingFaceFileName(42)).toBe(false);
  });
});

describe("isAllowedHuggingFaceDownloadHost", () => {
  it("accepts HuggingFace hosts and their CDN subdomains", () => {
    expect(isAllowedHuggingFaceDownloadHost("huggingface.co")).toBe(true);
    expect(isAllowedHuggingFaceDownloadHost("hf.co")).toBe(true);
    expect(isAllowedHuggingFaceDownloadHost("cdn-lfs.huggingface.co")).toBe(true);
    expect(isAllowedHuggingFaceDownloadHost("cdn-lfs-us-1.hf.co")).toBe(true);
    expect(isAllowedHuggingFaceDownloadHost("HUGGINGFACE.CO")).toBe(true);
  });

  it("rejects internal/metadata IPs and lookalike or foreign hosts", () => {
    expect(isAllowedHuggingFaceDownloadHost("169.254.169.254")).toBe(false);
    expect(isAllowedHuggingFaceDownloadHost("127.0.0.1")).toBe(false);
    expect(isAllowedHuggingFaceDownloadHost("attacker.example")).toBe(false);
    expect(isAllowedHuggingFaceDownloadHost("huggingface.co.evil.com")).toBe(false);
    expect(isAllowedHuggingFaceDownloadHost("evilhuggingface.co")).toBe(false);
  });
});

describe("requestUrl", () => {
  it("rejects plain-http URLs before issuing any request", async () => {
    await expect(requestUrl("http://huggingface.co/api/models/x")).rejects.toThrow(/insecure protocol/);
  });

  it("rejects non-http(s) protocols before issuing any request", async () => {
    await expect(requestUrl("file:///etc/passwd")).rejects.toThrow(/insecure protocol/);
    await expect(requestUrl("ftp://example.com/file")).rejects.toThrow(/insecure protocol/);
  });

  it("rejects https requests to non-HuggingFace hosts (redirect SSRF guard)", async () => {
    await expect(requestUrl("https://169.254.169.254/latest/meta-data/")).rejects.toThrow(/non-HuggingFace host/);
    await expect(requestUrl("https://127.0.0.1:8080/internal")).rejects.toThrow(/non-HuggingFace host/);
    await expect(requestUrl("https://attacker.example/payload")).rejects.toThrow(/non-HuggingFace host/);
  });
});

describe("resolveDownloadDestination", () => {
  it("resolves nested file names inside the model directory", () => {
    const dir = path.join(os.tmpdir(), "model-dir");
    expect(resolveDownloadDestination(dir, "sub/file.json")).toBe(path.join(dir, "sub", "file.json"));
  });

  it("rejects file names that escape the model directory", () => {
    const dir = path.join(os.tmpdir(), "model-dir");
    expect(() => resolveDownloadDestination(dir, "../escape.json")).toThrow(/escapes the model directory/);
    expect(() => resolveDownloadDestination(dir, "..")).toThrow(/escapes the model directory/);
  });
});

describe("listHuggingFaceModelFiles", () => {
  it("filters unsafe file names out of the hub listing", async () => {
    const files = await listHuggingFaceModelFiles("mlx-community/example", fakeHubRequest([
      { rfilename: "config.json" },
      { rfilename: "model.safetensors" },
      { rfilename: "..\\evil.bin" },
      { rfilename: "../evil.bin" },
      { rfilename: "sub/../evil.bin" },
      { rfilename: 7 },
    ]));
    expect(files).toEqual(["config.json", "model.safetensors"]);
  });

  it("fails when only unsafe file names remain", async () => {
    await expect(listHuggingFaceModelFiles("mlx-community/example", fakeHubRequest([
      { rfilename: "..\\evil.bin" },
    ]))).rejects.toThrow(/No downloadable files/);
  });
});

describe("downloadQwen3MlxModel", () => {
  it("downloads the listed files into the model directory and reports progress", async () => {
    const modelDir = path.join(makeTempDir(), "example");
    const progress: Qwen3MlxDownloadProgress[] = [];

    const result = await downloadQwen3MlxModel(
      "mlx-community/example",
      modelDir,
      (entry) => progress.push(entry),
      fakeHubRequest([
        { rfilename: "config.json" },
        { rfilename: "model.safetensors" },
        { rfilename: "..\\evil.bin" },
      ]),
    );

    expect(result).toMatchObject({
      modelRepo: "mlx-community/example",
      modelDir,
      downloadedFiles: 2,
      skippedFiles: 0,
      modelDirLooksReady: true,
    });
    expect(fs.readFileSync(path.join(modelDir, "config.json"), "utf-8")).toBe("DATA:config.json");
    expect(fs.readFileSync(path.join(modelDir, "model.safetensors"), "utf-8")).toBe("DATA:model.safetensors");
    expect(fs.existsSync(path.join(path.dirname(modelDir), "evil.bin"))).toBe(false);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0]).toMatchObject({ modelRepo: "mlx-community/example", totalFiles: 2 });
  });

  it("skips files that already exist with the expected size", async () => {
    const modelDir = path.join(makeTempDir(), "example");
    const request = fakeHubRequest([{ rfilename: "config.json" }, { rfilename: "model.safetensors" }]);

    await downloadQwen3MlxModel("mlx-community/example", modelDir, () => {}, request);
    const second = await downloadQwen3MlxModel("mlx-community/example", modelDir, () => {}, request);

    expect(second).toMatchObject({ downloadedFiles: 0, skippedFiles: 2 });
  });
});

describe("downloadHuggingFaceFile resilience", () => {
  const FILE_URL = "https://huggingface.co/x/resolve/main/model.safetensors";

  it("rejects and removes the temp file when the body is shorter than its declared length", async () => {
    const dir = makeTempDir();
    const dest = path.join(dir, "model.safetensors");
    const request: UrlRequest = () =>
      Promise.resolve(fakeResponse("0123456789", { headers: { "content-length": "100" } }));

    await expect(downloadHuggingFaceFile(FILE_URL, dest, () => {}, request)).rejects.toThrow(/incomplete/);
    // The truncated body must never be promoted to the final path, and no
    // partial temp file should be left behind.
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(`${dest}.download`)).toBe(false);
  });

  it("removes the partial temp file when the download stream errors", async () => {
    const dir = makeTempDir();
    const dest = path.join(dir, "model.safetensors");
    const request: UrlRequest = () => {
      const response = new Readable({
        read() {
          this.destroy(new Error("connection reset"));
        },
      }) as unknown as IncomingMessage;
      Object.assign(response, { statusCode: 200, headers: { "content-length": "100" } });
      return Promise.resolve(response);
    };

    await expect(downloadHuggingFaceFile(FILE_URL, dest, () => {}, request)).rejects.toThrow(/connection reset/);
    expect(fs.existsSync(`${dest}.download`)).toBe(false);
  });

  it("fails a stalled download after the inactivity deadline instead of hanging forever", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const dir = makeTempDir();
      const dest = path.join(dir, "model.safetensors");
      // A response that delivers nothing and never ends (no 'end'/'error'),
      // which without the watchdog would wedge the download forever.
      const stalled = new Readable({ read() {} }) as unknown as IncomingMessage;
      Object.assign(stalled, { statusCode: 200, headers: {} });
      const request: UrlRequest = () => Promise.resolve(stalled);

      const promise = downloadHuggingFaceFile(FILE_URL, dest, () => {}, request);
      promise.catch(() => {});
      // Let the real pre-stream fs setup run and arm the idle timer
      // (setImmediate is not faked) before advancing the faked deadline.
      for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(IDLE_DOWNLOAD_TIMEOUT_MS + 1_000);

      await expect(promise).rejects.toThrow(/stalled/);
      expect(fs.existsSync(`${dest}.download`)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createQwen3MlxDownloadCoordinator", () => {
  function deferredDownload() {
    const resolvers: Array<(result: Qwen3MlxDownloadResult) => void> = [];
    const rejecters: Array<(error: Error) => void> = [];
    const download = vi.fn((modelRepo: string, modelDir: string) =>
      new Promise<Qwen3MlxDownloadResult>((resolve, reject) => {
        resolvers.push((result) => resolve({ ...result, modelRepo, modelDir }));
        rejecters.push(reject);
      }));
    return { download, resolvers, rejecters };
  }

  const RESULT: Qwen3MlxDownloadResult = {
    modelRepo: "mlx-community/example",
    modelDir: "/cache/a",
    downloadedFiles: 1,
    skippedFiles: 0,
    modelDirLooksReady: true,
  };

  it("shares one in-flight download per model directory", async () => {
    const { download, resolvers } = deferredDownload();
    const coordinator = createQwen3MlxDownloadCoordinator(download as never);

    const first = coordinator.download("mlx-community/example", "/cache/a", () => {});
    const second = coordinator.download("mlx-community/example", "/cache/a", () => {});
    expect(download).toHaveBeenCalledTimes(1);

    resolvers[0](RESULT);
    await expect(first).resolves.toMatchObject({ modelDir: "/cache/a" });
    await expect(second).resolves.toMatchObject({ modelDir: "/cache/a" });

    // A later invoke after completion starts a fresh download.
    const third = coordinator.download("mlx-community/example", "/cache/a", () => {});
    expect(download).toHaveBeenCalledTimes(2);
    resolvers[1](RESULT);
    await third;
  });

  it("runs downloads for different model directories independently", async () => {
    const { download, resolvers } = deferredDownload();
    const coordinator = createQwen3MlxDownloadCoordinator(download as never);

    const first = coordinator.download("mlx-community/a", "/cache/a", () => {});
    const second = coordinator.download("mlx-community/b", "/cache/b", () => {});
    expect(download).toHaveBeenCalledTimes(2);

    resolvers[0](RESULT);
    resolvers[1](RESULT);
    await expect(first).resolves.toMatchObject({ modelDir: "/cache/a" });
    await expect(second).resolves.toMatchObject({ modelDir: "/cache/b" });
  });

  it("clears a failed download so the next invoke retries", async () => {
    const { download, resolvers, rejecters } = deferredDownload();
    const coordinator = createQwen3MlxDownloadCoordinator(download as never);

    const first = coordinator.download("mlx-community/example", "/cache/a", () => {});
    const shared = coordinator.download("mlx-community/example", "/cache/a", () => {});
    rejecters[0](new Error("network down"));
    await expect(first).rejects.toThrow("network down");
    await expect(shared).rejects.toThrow("network down");

    const retry = coordinator.download("mlx-community/example", "/cache/a", () => {});
    expect(download).toHaveBeenCalledTimes(2);
    resolvers[1](RESULT);
    await expect(retry).resolves.toMatchObject({ modelDir: "/cache/a" });
  });
});

describe("buildQwen3SetupWarnings", () => {
  it("reports the MLX default as active when the api_server and the model are present", () => {
    const warnings = buildQwen3SetupWarnings({
      ttsAvailable: true,
      apiServerAvailable: true,
      workerAvailable: true,
      modelDirLooksReady: true,
    });
    expect(warnings[0]).toMatch(/MLX CustomVoice \(6-bit\) is set up and used by default/);
    expect(warnings[1]).toMatch(/Base voice cloning \(pibot-tts-worker\) is available/);
  });

  it("calls out the slow one-shot tts fallback when only the tts binary is present", () => {
    const warnings = buildQwen3SetupWarnings({
      ttsAvailable: true,
      apiServerAvailable: false,
      workerAvailable: true,
      modelDirLooksReady: true,
    });
    expect(warnings[0]).toMatch(/api_server binary is missing/);
    expect(warnings[0]).toMatch(/much slower/);
    expect(warnings[0]).toMatch(/build:qwen3-mlx-worker/);
  });

  it("reports the Candle fallback when the model is not downloaded", () => {
    const warnings = buildQwen3SetupWarnings({
      ttsAvailable: false,
      apiServerAvailable: true,
      workerAvailable: false,
      modelDirLooksReady: false,
    });
    expect(warnings[0]).toMatch(/model is not downloaded yet/);
    expect(warnings[0]).toMatch(/Candle CustomVoice engine until/);
    expect(warnings[1]).toMatch(/Base voice cloning is unavailable/);
  });

  it("reports the Candle fallback with setup steps when MLX is not installed", () => {
    const warnings = buildQwen3SetupWarnings({
      ttsAvailable: false,
      apiServerAvailable: false,
      workerAvailable: false,
      modelDirLooksReady: true,
    });
    expect(warnings[0]).toMatch(/MLX CustomVoice is not installed/);
    expect(warnings[0]).toMatch(/build:qwen3-mlx-worker/);
  });
});
