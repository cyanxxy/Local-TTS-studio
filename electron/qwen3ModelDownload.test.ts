// @vitest-environment node

import { createHash } from "crypto";
import fs from "fs";
import type { IncomingMessage } from "http";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Qwen3Profile } from "./qwen3Profiles";
import {
  adoptLegacyQwen3ModelDir,
  createQwen3ModelDownloadCoordinator,
  createSafeProgressSender,
  downloadHuggingFaceFile,
  downloadQwen3Model,
  IDLE_DOWNLOAD_TIMEOUT_MS,
  inspectQwen3ModelDir,
  isAllowedHuggingFaceDownloadHost,
  isSafeHuggingFaceFileName,
  QWEN3_MODEL_MANIFEST,
  requestUrl,
  resolveDownloadDestination,
  type Qwen3ModelDownloadProgress,
  type Qwen3ModelDownloadResult,
  type UrlRequest,
} from "./qwen3ModelDownload";

const REVISION = "1234567890abcdef1234567890abcdef12345678";
const PROFILE: Qwen3Profile = {
  repo: "mlx-community/example",
  revision: REVISION,
  mode: "customVoice",
  parameters: "0.6B",
  provider: "mlx",
  platforms: ["darwin"],
  weightFormat: "mlx-6bit",
  label: "Test profile",
  requiredFiles: ["config.json", "model.safetensors"],
};
const FILES = new Map([
  ["config.json", Buffer.from('{"tts_model_type":"custom_voice"}')],
  ["model.safetensors", Buffer.from("weights")],
]);

function digest(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

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

function fakeHubRequest(seen: string[] = []): UrlRequest {
  return (url) => {
    seen.push(url);
    if (url.includes("/api/models/")) {
      const siblings = [...FILES].map(([rfilename, body]) => ({
        rfilename,
        size: body.byteLength,
        lfs: { size: body.byteLength, oid: digest(body) },
      }));
      return Promise.resolve(fakeResponse(JSON.stringify({ siblings })));
    }
    const marker = `/resolve/${REVISION}/`;
    const fileName = decodeURIComponent(url.split(marker)[1]);
    const body = FILES.get(fileName);
    if (!body) return Promise.resolve(fakeResponse("missing", { statusCode: 404 }));
    return Promise.resolve(fakeResponse(body));
  };
}

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-tts-qwen3-download-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("safe progress and Hub URLs", () => {
  it("drops progress safely after the window is destroyed", () => {
    const send = vi.fn();
    const progress = {} as Qwen3ModelDownloadProgress;
    createSafeProgressSender({ isDestroyed: () => false, send }, "channel")(progress);
    expect(send).toHaveBeenCalledWith("channel", progress);
    createSafeProgressSender({ isDestroyed: () => true, send }, "channel")(progress);
    expect(send).toHaveBeenCalledTimes(1);
    expect(() => createSafeProgressSender({
      isDestroyed: () => false,
      send: () => { throw new Error("destroyed"); },
    }, "channel")(progress)).not.toThrow();
  });

  it("rejects traversal and non-HuggingFace network destinations", async () => {
    expect(isSafeHuggingFaceFileName("speech_tokenizer/config.json")).toBe(true);
    expect(isSafeHuggingFaceFileName("../evil")).toBe(false);
    expect(isSafeHuggingFaceFileName("..\\evil")).toBe(false);
    expect(() => resolveDownloadDestination("/tmp/model", "../evil")).toThrow(/escapes/);
    expect(isAllowedHuggingFaceDownloadHost("cdn-lfs.huggingface.co")).toBe(true);
    expect(isAllowedHuggingFaceDownloadHost("169.254.169.254")).toBe(false);
    await expect(requestUrl("http://huggingface.co/model")).rejects.toThrow(/insecure/);
    await expect(requestUrl("https://127.0.0.1/model")).rejects.toThrow(/non-HuggingFace/);
  });
});

describe("downloadQwen3Model", () => {
  it("adopts an existing structurally valid legacy cache directory", async () => {
    const root = makeTempDir();
    const legacyDir = path.join(root, "example");
    const revisionDir = path.join(root, `example-${REVISION.slice(0, 12)}`);
    fs.mkdirSync(legacyDir);
    for (const [fileName, body] of FILES) fs.writeFileSync(path.join(legacyDir, fileName), body);

    await expect(adoptLegacyQwen3ModelDir(PROFILE, revisionDir, legacyDir)).resolves.toBe(revisionDir);
    expect(fs.existsSync(legacyDir)).toBe(false);
    await expect(inspectQwen3ModelDir(revisionDir, PROFILE)).resolves.toMatchObject({ readiness: "structural" });
  });

  it("does not adopt an incomplete or wrong-type legacy cache", async () => {
    const root = makeTempDir();
    const legacyDir = path.join(root, "example");
    const revisionDir = path.join(root, `example-${REVISION.slice(0, 12)}`);
    fs.mkdirSync(legacyDir);
    fs.writeFileSync(path.join(legacyDir, "config.json"), '{"tts_model_type":"base"}');

    await expect(adoptLegacyQwen3ModelDir(PROFILE, revisionDir, legacyDir)).resolves.toBe(revisionDir);
    expect(fs.existsSync(legacyDir)).toBe(true);
    expect(fs.existsSync(revisionDir)).toBe(false);
  });

  it("downloads only required files at the exact revision and writes a verified manifest last", async () => {
    const modelDir = makeTempDir();
    const seen: string[] = [];
    const progress: Qwen3ModelDownloadProgress[] = [];
    const result = await downloadQwen3Model(PROFILE, modelDir, (entry) => progress.push(entry), fakeHubRequest(seen));

    expect(result).toMatchObject({
      modelRepo: PROFILE.repo,
      revision: REVISION,
      downloadedFiles: 2,
      skippedFiles: 0,
      readiness: "verified",
    });
    expect(seen[0]).toContain(`/revision/${REVISION}?blobs=true`);
    expect(seen.slice(1).every((url) => url.includes(`/resolve/${REVISION}/`))).toBe(true);
    expect(seen.some((url) => url.includes("resolve/main"))).toBe(false);
    expect(progress.every((entry) => entry.revision === REVISION)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(path.join(modelDir, QWEN3_MODEL_MANIFEST), "utf-8"));
    expect(manifest).toMatchObject({ schemaVersion: 1, repo: PROFILE.repo, revision: REVISION });
    expect(manifest.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "config.json", sizeBytes: FILES.get("config.json")!.byteLength }),
      expect.objectContaining({ path: "model.safetensors", sha256: digest(FILES.get("model.safetensors")!) }),
    ]));
    await expect(inspectQwen3ModelDir(modelDir, PROFILE)).resolves.toEqual({ readiness: "verified" });
  });

  it("distinguishes structural model directories from revision-verified ones", async () => {
    const modelDir = makeTempDir();
    for (const [fileName, body] of FILES) fs.writeFileSync(path.join(modelDir, fileName), body);
    await expect(inspectQwen3ModelDir(modelDir, PROFILE)).resolves.toMatchObject({ readiness: "structural" });

    await downloadQwen3Model(PROFILE, modelDir, () => {}, fakeHubRequest());
    fs.writeFileSync(path.join(modelDir, "model.safetensors"), "tampered");
    await expect(inspectQwen3ModelDir(modelDir, PROFILE)).resolves.toMatchObject({ readiness: "structural" });
  });

  it("rejects a wrong model type and a stale manifest", async () => {
    const modelDir = makeTempDir();
    fs.writeFileSync(path.join(modelDir, "config.json"), '{"tts_model_type":"base"}');
    fs.writeFileSync(path.join(modelDir, "model.safetensors"), "weights");
    await expect(inspectQwen3ModelDir(modelDir, PROFILE)).resolves.toMatchObject({ readiness: "missing" });

    fs.writeFileSync(path.join(modelDir, "config.json"), FILES.get("config.json")!);
    fs.writeFileSync(path.join(modelDir, QWEN3_MODEL_MANIFEST), JSON.stringify({
      schemaVersion: 1,
      repo: PROFILE.repo,
      revision: "stale",
      files: [],
    }));
    await expect(inspectQwen3ModelDir(modelDir, PROFILE)).resolves.toMatchObject({ readiness: "structural" });
  });

  it("skips already valid files but regenerates the authoritative manifest", async () => {
    const modelDir = makeTempDir();
    await downloadQwen3Model(PROFILE, modelDir, () => {}, fakeHubRequest());
    fs.rmSync(path.join(modelDir, QWEN3_MODEL_MANIFEST));
    const second = await downloadQwen3Model(PROFILE, modelDir, () => {}, fakeHubRequest());
    expect(second).toMatchObject({ downloadedFiles: 0, skippedFiles: 2, readiness: "verified" });
  });
});

describe("download stream integrity", () => {
  const url = "https://huggingface.co/x/resolve/revision/model.safetensors";

  it("removes temporary files after truncated or digest-mismatched bodies", async () => {
    const destination = path.join(makeTempDir(), "model.safetensors");
    const short: UrlRequest = () => Promise.resolve(fakeResponse("short", {
      headers: { "content-length": "100" },
    }));
    await expect(downloadHuggingFaceFile(url, destination, () => {}, short)).rejects.toThrow(/incomplete/);
    expect(fs.existsSync(`${destination}.download`)).toBe(false);

    await expect(downloadHuggingFaceFile(
      url,
      destination,
      () => {},
      () => Promise.resolve(fakeResponse("body")),
      { sha256: "0".repeat(64) },
    )).rejects.toThrow(/digest mismatch/);
    expect(fs.existsSync(destination)).toBe(false);
  });

  it("fails a stalled response on the inactivity deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const destination = path.join(makeTempDir(), "model.safetensors");
    const stalled = new Readable({ read() {} }) as unknown as IncomingMessage;
    Object.assign(stalled, { statusCode: 200, headers: {} });
    const promise = downloadHuggingFaceFile(url, destination, () => {}, () => Promise.resolve(stalled));
    promise.catch(() => undefined);
    for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(IDLE_DOWNLOAD_TIMEOUT_MS + 1);
    await expect(promise).rejects.toThrow(/stalled/);
  });
});

describe("createQwen3ModelDownloadCoordinator", () => {
  it("deduplicates the same immutable profile and directory", async () => {
    let resolve!: (result: Qwen3ModelDownloadResult) => void;
    const download = vi.fn(() => new Promise<Qwen3ModelDownloadResult>((done) => { resolve = done; }));
    const coordinator = createQwen3ModelDownloadCoordinator(download as never);
    const first = coordinator.download(PROFILE, "/cache/a", () => {});
    const second = coordinator.download(PROFILE, "/cache/a", () => {});
    expect(download).toHaveBeenCalledTimes(1);
    resolve({
      modelRepo: PROFILE.repo,
      revision: PROFILE.revision,
      modelDir: "/cache/a",
      downloadedFiles: 2,
      skippedFiles: 0,
      readiness: "verified",
    });
    await expect(first).resolves.toMatchObject({ readiness: "verified" });
    await expect(second).resolves.toMatchObject({ readiness: "verified" });
  });
});
