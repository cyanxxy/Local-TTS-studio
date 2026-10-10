// @vitest-environment node

import { createHash } from "crypto";
import fs from "fs";
import type { IncomingMessage } from "http";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { afterEach, describe, expect, it } from "vitest";
import type { UrlRequest } from "./hubHttps";
import { PinnedAssetCache, type PinnedAsset } from "./pinnedAssetCache";
import type { DownloadFailure } from "./verifiedDownload";

interface ExampleAsset extends PinnedAsset {
  repo: "weights" | "voices";
}

function asset(file: string, body: Buffer, repo: ExampleAsset["repo"] = "weights"): ExampleAsset {
  return { file, size: body.byteLength, digest: { algorithm: "sha256", value: createHash("sha256").update(body).digest("hex") }, repo };
}

function respond(body: Buffer, statusCode = 200): IncomingMessage {
  return Object.assign(Readable.from([body]) as unknown as IncomingMessage, { statusCode, headers: {} });
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function createCache(request: UrlRequest, failures: Array<[string, DownloadFailure]> = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-tts-pinned-assets-"));
  tempDirs.push(dir);
  const cache = new PinnedAssetCache<ExampleAsset>(dir, {
    resolveUrl: (pinned) => `https://huggingface.co/example/${pinned.repo}/resolve/rev/${pinned.file}`,
    cancelledError: () => new Error("Example download cancelled."),
    describeFailure: (pinned, failure) => {
      failures.push([pinned.file, failure]);
      return new Error(`Example could not fetch ${pinned.file}.`);
    },
    idleTimeoutMs: 1_000,
    request,
  });
  return { cache, dir };
}

describe("PinnedAssetCache", () => {
  it("fetches each asset from the URL its model resolves, into nested paths", async () => {
    const weights = Buffer.from("weights");
    const voice = Buffer.from("voice");
    const seen: string[] = [];
    const { cache, dir } = createCache((url) => {
      seen.push(url);
      return Promise.resolve(respond(url.endsWith("model.bin") ? weights : voice));
    });
    const assets = [asset("model.bin", weights), asset("voices/a/codes.npy", voice, "voices")];

    await cache.ensure(assets);

    expect(seen).toEqual([
      "https://huggingface.co/example/weights/resolve/rev/model.bin",
      "https://huggingface.co/example/voices/resolve/rev/voices/a/codes.npy",
    ]);
    expect(cache.filePath(assets[1])).toBe(path.join(dir, "voices", "a", "codes.npy"));
    await expect(cache.readFile(assets[1])).resolves.toEqual(voice);
  });

  it("words failures through the model, naming the asset and what went wrong", async () => {
    const failures: Array<[string, DownloadFailure]> = [];
    const { cache } = createCache(() => Promise.resolve(respond(Buffer.from("nope"), 503)), failures);

    await expect(cache.ensure([asset("model.bin", Buffer.from("body"))])).rejects.toThrow("Example could not fetch model.bin.");
    expect(failures).toEqual([["model.bin", { kind: "status", statusCode: 503 }]]);
  });

  it("refuses to start for a caller that has already cancelled", async () => {
    const { cache } = createCache(() => Promise.reject(new Error("must not be called")));

    await expect(cache.ensure([asset("model.bin", Buffer.from("body"))], undefined, AbortSignal.abort()))
      .rejects.toThrow("Example download cancelled.");
  });
});
