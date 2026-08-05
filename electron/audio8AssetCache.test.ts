// @vitest-environment node

import { createHash } from "crypto";
import fs from "fs";
import type { IncomingMessage } from "http";
import os from "os";
import path from "path";
import { PassThrough, Readable } from "stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Audio8AssetCache, type Audio8AssetProgress } from "./audio8AssetCache";
import type { Audio8Asset } from "./audio8Model";
import type { UrlRequest } from "./qwen3ModelDownload";

const MODEL_REVISION = "818569c6b832118ad68d61bbd873abe250fcd68a";
const VOICE_SPACE_REVISION = "6417ebaafc996620bebc3eb27cde0d5acb19f13b";

function sha256Asset(file: string, body: Buffer): Audio8Asset {
  return {
    file,
    size: body.byteLength,
    digest: { algorithm: "sha256", value: createHash("sha256").update(body).digest("hex") },
    source: "model",
  };
}

function gitBlobAsset(file: string, body: Buffer): Audio8Asset {
  const value = createHash("sha1")
    .update(Buffer.from(`blob ${body.byteLength}\0`))
    .update(body)
    .digest("hex");
  return { file, size: body.byteLength, digest: { algorithm: "gitBlobSha1", value }, source: "voiceSpace" };
}

function respondWith(body: Buffer | Readable, statusCode = 200): IncomingMessage {
  const response = (Buffer.isBuffer(body) ? Readable.from([body]) : body) as unknown as IncomingMessage;
  return Object.assign(response, { statusCode, headers: {} });
}

function serve(bodies: Record<string, Buffer>, seen: string[] = []): UrlRequest {
  return (url) => {
    seen.push(url);
    const file = Object.keys(bodies).find((name) => url.endsWith(`/${name}`));
    if (!file) return Promise.resolve(respondWith(Buffer.from("missing"), 404));
    return Promise.resolve(respondWith(bodies[file]));
  };
}

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-tts-audio8-assets-"));
  tempDirs.push(dir);
  return dir;
}

function partialFiles(dir: string, file: string): string[] {
  const parent = path.join(dir, path.dirname(file));
  const base = path.basename(file);
  if (!fs.existsSync(parent)) return [];
  return fs.readdirSync(parent)
    .filter((name) => name === `${base}.partial` || (name.startsWith(`${base}.`) && name.endsWith(".partial")));
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect.unreachable("condition was never met");
}

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("Audio8AssetCache", () => {
  it("downloads a model asset from its pinned revision and reports byte progress", async () => {
    const body = Buffer.from("slow graph weights");
    const asset = sha256Asset("slow_ar_int4.onnx", body);
    const dir = makeTempDir();
    const seen: string[] = [];
    const cache = new Audio8AssetCache(dir, { request: serve({ [asset.file]: body }, seen) });
    const progress: Audio8AssetProgress[] = [];

    await cache.ensure([asset], (value) => progress.push(value));

    expect(seen).toEqual([
      `https://huggingface.co/Audio8/Audio8-TTS-Preview-0.6B-ONNX-INT4/resolve/${MODEL_REVISION}/${asset.file}`,
    ]);
    expect(fs.readFileSync(path.join(dir, asset.file))).toEqual(body);
    expect(partialFiles(dir, asset.file)).toEqual([]);
    expect(progress.at(-1)).toEqual({ receivedBytes: body.byteLength, totalBytes: body.byteLength });
  });

  it("verifies a git blob digest and downloads voice assets from the Space revision", async () => {
    const body = Buffer.from('{"reference_text":"hello"}');
    const asset = gitBlobAsset("voices/clara/meta.json", body);
    const dir = makeTempDir();
    const seen: string[] = [];
    const cache = new Audio8AssetCache(dir, { request: serve({ "meta.json": body }, seen) });

    await cache.ensure([asset]);

    expect(seen[0]).toBe(
      `https://huggingface.co/spaces/Audio8/Audio8-TTS-Preview-0.6B-ONNX-INT4/resolve/${VOICE_SPACE_REVISION}/${asset.file}`,
    );
    expect(fs.readFileSync(path.join(dir, asset.file))).toEqual(body);
  });

  it("aggregates progress across the whole asset set", async () => {
    const first = Buffer.alloc(400, 1);
    const second = Buffer.alloc(600, 2);
    const assets = [sha256Asset("first.bin", first), sha256Asset("second.bin", second)];
    const dir = makeTempDir();
    const cache = new Audio8AssetCache(dir, {
      request: serve({ "first.bin": first, "second.bin": second }),
    });
    const progress: Audio8AssetProgress[] = [];

    await cache.ensure(assets, (value) => progress.push(value));

    expect(progress.every((value) => value.totalBytes === 1000)).toBe(true);
    expect(progress.map((value) => value.receivedBytes)).toEqual([400, 400, 1000, 1000]);
  });

  it("rejects a truncated download and removes the partial file", async () => {
    const body = Buffer.from("expected body");
    const asset = { ...sha256Asset("slow_ar_int4.onnx", body), size: body.byteLength + 8 };
    const dir = makeTempDir();
    const cache = new Audio8AssetCache(dir, { request: serve({ [asset.file]: body }) });

    await expect(cache.ensure([asset])).rejects.toThrow(
      "Audio8 slow_ar_int4.onnx failed integrity verification.",
    );
    expect(partialFiles(dir, asset.file)).toEqual([]);
    expect(fs.existsSync(path.join(dir, asset.file))).toBe(false);
  });

  it("rejects a download whose digest does not match the pinned value", async () => {
    const asset = sha256Asset("fast_ar_int4.onnx", Buffer.from("expected body"));
    const dir = makeTempDir();
    const cache = new Audio8AssetCache(dir, {
      request: serve({ [asset.file]: Buffer.from("imposter body") }),
    });

    await expect(cache.ensure([asset])).rejects.toThrow(
      "Audio8 fast_ar_int4.onnx failed integrity verification.",
    );
    expect(partialFiles(dir, asset.file)).toEqual([]);
  });

  it("reports the failing asset when the Hub answers with an error status", async () => {
    const asset = sha256Asset("codec_decoder_fp16.onnx", Buffer.from("body"));
    const dir = makeTempDir();
    const cache = new Audio8AssetCache(dir, { request: () => Promise.resolve(respondWith(Buffer.from("nope"), 404)) });

    await expect(cache.ensure([asset])).rejects.toThrow(
      "Audio8 download failed for codec_decoder_fp16.onnx (HTTP 404).",
    );
  });

  it("keeps a cached file whose digest still matches and never asks the network", async () => {
    const body = Buffer.from("cached weights");
    const asset = sha256Asset("slow_ar_int4.onnx", body);
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, asset.file), body);
    const request = vi.fn<UrlRequest>();
    const cache = new Audio8AssetCache(dir, { request });

    await cache.ensure([asset]);

    expect(request).not.toHaveBeenCalled();
  });

  it("replaces a cached file that is the right size but the wrong bytes", async () => {
    const body = Buffer.from("real weights");
    const asset = sha256Asset("slow_ar_int4.onnx", body);
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, asset.file), Buffer.alloc(body.byteLength, 0x41));
    const seen: string[] = [];
    const cache = new Audio8AssetCache(dir, { request: serve({ [asset.file]: body }, seen) });

    await cache.ensure([asset]);

    expect(seen).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, asset.file))).toEqual(body);
  });

  it("verifies a cached file once per process rather than once per request", async () => {
    const body = Buffer.from("real weights");
    const asset = sha256Asset("slow_ar_int4.onnx", body);
    const dir = makeTempDir();
    const seen: string[] = [];
    const cache = new Audio8AssetCache(dir, { request: serve({ [asset.file]: body }, seen) });

    await cache.ensure([asset]);
    fs.writeFileSync(path.join(dir, asset.file), Buffer.alloc(body.byteLength, 0x41));
    await cache.ensure([asset]);

    expect(seen).toHaveLength(1);
  });

  it("overwrites a partial file left behind by an interrupted run", async () => {
    const body = Buffer.from("complete body");
    const asset = sha256Asset("slow_ar_int4.onnx", body);
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, `${asset.file}.partial`), Buffer.from("half a body"));
    const cache = new Audio8AssetCache(dir, { request: serve({ [asset.file]: body }) });

    await cache.ensure([asset]);

    expect(fs.readFileSync(path.join(dir, asset.file))).toEqual(body);
    expect(partialFiles(dir, asset.file)).toEqual([]);
  });

  it("opens one transfer when two callers need the same asset at once", async () => {
    const body = Buffer.from("shared weights");
    const asset = sha256Asset("slow_ar_int4.onnx", body);
    const dir = makeTempDir();
    const stream = new PassThrough();
    const request = vi.fn<UrlRequest>(() => Promise.resolve(respondWith(stream)));
    const cache = new Audio8AssetCache(dir, { request });

    const first = cache.ensure([asset]);
    const second = cache.ensure([asset]);
    await waitFor(() => request.mock.calls.length > 0);
    stream.end(body);

    await Promise.all([first, second]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("uses independent partial files across cache instances", async () => {
    const body = Buffer.from("shared cross-process weights");
    const asset = sha256Asset("slow_ar_int4.onnx", body);
    const dir = makeTempDir();
    const firstStream = new PassThrough();
    const secondStream = new PassThrough();
    const first = new Audio8AssetCache(dir, { request: () => Promise.resolve(respondWith(firstStream)) });
    const second = new Audio8AssetCache(dir, { request: () => Promise.resolve(respondWith(secondStream)) });

    const firstDownload = first.ensure([asset]);
    const secondDownload = second.ensure([asset]);
    firstStream.write(body.subarray(0, 4));
    secondStream.write(body.subarray(0, 4));
    await waitFor(() => partialFiles(dir, asset.file).length === 2);
    firstStream.end(body.subarray(4));
    secondStream.end(body.subarray(4));

    await Promise.all([firstDownload, secondDownload]);
    expect(fs.readFileSync(path.join(dir, asset.file))).toEqual(body);
    expect(partialFiles(dir, asset.file)).toEqual([]);
  });

  it("stops a response as soon as it exceeds the pinned byte length", async () => {
    const body = Buffer.from("expected");
    const asset = sha256Asset("slow_ar_int4.onnx", body);
    const dir = makeTempDir();
    const stream = new PassThrough();
    const cache = new Audio8AssetCache(dir, { request: () => Promise.resolve(respondWith(stream)) });

    const download = cache.ensure([asset]);
    stream.end(Buffer.concat([body, Buffer.alloc(1024, 1)]));

    await expect(download).rejects.toThrow("Audio8 download exceeded the expected size");
    expect(partialFiles(dir, asset.file)).toEqual([]);
    expect(fs.existsSync(path.join(dir, asset.file))).toBe(false);
  });

  it("fails a transfer that stalls, and leaves nothing behind", async () => {
    const asset = sha256Asset("slow_ar_int4.onnx", Buffer.from("never arrives"));
    const dir = makeTempDir();
    const stream = new PassThrough();
    const cache = new Audio8AssetCache(dir, {
      idleTimeoutMs: 20,
      request: () => Promise.resolve(respondWith(stream)),
    });

    await expect(cache.ensure([asset])).rejects.toThrow(
      "Audio8 download stalled for 0.02s: slow_ar_int4.onnx",
    );
    expect(partialFiles(dir, asset.file)).toEqual([]);
  });

  it("abandons an in-flight transfer when the caller cancels", async () => {
    const asset = sha256Asset("slow_ar_int4.onnx", Buffer.alloc(4096, 7));
    const dir = makeTempDir();
    const stream = new PassThrough();
    const cache = new Audio8AssetCache(dir, { request: () => Promise.resolve(respondWith(stream)) });
    const controller = new AbortController();

    const download = cache.ensure([asset], undefined, controller.signal);
    stream.write(Buffer.alloc(16, 7));
    await waitFor(() => partialFiles(dir, asset.file).length === 1);
    controller.abort();

    await expect(download).rejects.toThrow("Audio8 asset download cancelled.");
    await waitFor(() => partialFiles(dir, asset.file).length === 0);
    expect(stream.destroyed).toBe(true);
  });

  it("refuses to start once the caller has already cancelled", async () => {
    const asset = sha256Asset("slow_ar_int4.onnx", Buffer.from("body"));
    const cache = new Audio8AssetCache(makeTempDir(), { request: vi.fn<UrlRequest>() });

    await expect(cache.ensure([asset], undefined, AbortSignal.abort())).rejects.toThrow(
      "Audio8 asset download cancelled.",
    );
  });
});
