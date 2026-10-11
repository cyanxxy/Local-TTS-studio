// @vitest-environment node

import { spawnSync } from "child_process";
import { createHash, randomUUID } from "crypto";
import fs from "fs";
import type { IncomingMessage } from "http";
import os from "os";
import path from "path";
import { PassThrough, Readable } from "stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UrlRequest } from "./hubHttps";
import {
  downloadVerifiedFile,
  removeAbandonedPartials,
  type DownloadFailure,
  type VerifiedDownloadOptions,
} from "./verifiedDownload";

const URL = "https://huggingface.co/example/resolve/abc/model.bin";

function respond(
  body: Buffer | Readable,
  { statusCode = 200, headers = {} }: { statusCode?: number; headers?: Record<string, string> } = {},
): IncomingMessage {
  const response = (Buffer.isBuffer(body) ? Readable.from([body]) : body) as unknown as IncomingMessage;
  return Object.assign(response, { statusCode, headers });
}

function cancelled(): Error {
  return new Error("Example download cancelled.");
}

class DescribedFailure extends Error {
  constructor(readonly failure: DownloadFailure) {
    super(`download failed: ${failure.kind}`);
  }
}

function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-tts-verified-download-"));
  tempDirs.push(dir);
  return dir;
}

function download(
  overrides: Partial<VerifiedDownloadOptions> & Pick<VerifiedDownloadOptions, "destination" | "request">,
) {
  return downloadVerifiedFile({
    url: URL,
    idleTimeoutMs: 120_000,
    cancelledError: cancelled,
    describeFailure: (failure) => new DescribedFailure(failure),
    ...overrides,
  });
}

async function failureOf(promise: Promise<unknown>): Promise<DownloadFailure> {
  const error = await promise.then(() => null, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(DescribedFailure);
  return (error as DescribedFailure).failure;
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect.unreachable("condition was never met");
}

function partialsOf(destination: string): string[] {
  const base = path.basename(destination);
  return fs.readdirSync(path.dirname(destination)).filter((name) => name.startsWith(`${base}.`) && name.endsWith(".partial"));
}

/** A pid that certainly belonged to a process which has since exited. */
function exitedPid(): number {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  if (!pid) throw new Error("could not start a short-lived process");
  return pid;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("downloadVerifiedFile", () => {
  it("publishes only the verified bytes and reports progress against the pin", async () => {
    const body = Buffer.from("pinned model weights");
    const destination = path.join(makeTempDir(), "nested", "model.bin");
    const progress: Array<[number, number | undefined]> = [];

    const result = await download({
      destination,
      request: () => Promise.resolve(respond(Readable.from([body.subarray(0, 6), body.subarray(6)]))),
      expected: { sizeBytes: body.byteLength, digest: { algorithm: "sha256", value: sha256(body) } },
      onBytes: (received, total) => progress.push([received, total]),
    });

    expect(result).toEqual({ sizeBytes: body.byteLength, digest: sha256(body) });
    expect(fs.readFileSync(destination)).toEqual(body);
    expect(fs.readdirSync(path.dirname(destination))).toEqual(["model.bin"]);
    expect(progress).toEqual([[6, body.byteLength], [body.byteLength, body.byteLength]]);
  });

  it("verifies a git blob pin and falls back to the server's length for progress", async () => {
    const body = Buffer.from("hello\n");
    const destination = path.join(makeTempDir(), "meta.json");
    const progress: Array<number | undefined> = [];

    await expect(download({
      destination,
      request: () => Promise.resolve(respond(body, { headers: { "content-length": "6" } })),
      expected: { sizeBytes: 6, digest: { algorithm: "gitBlobSha1", value: "ce013625030ba8dba906f756967f9e9ca394464a" } },
    })).resolves.toEqual({ sizeBytes: 6, digest: "ce013625030ba8dba906f756967f9e9ca394464a" });

    await download({
      destination: path.join(path.dirname(destination), "unpinned.json"),
      request: () => Promise.resolve(respond(body, { headers: { "content-length": "6" } })),
      onBytes: (_received, total) => progress.push(total),
    });
    expect(progress).toEqual([6]);
  });

  it("gives every transfer its own partial so two instances never share one", async () => {
    const body = Buffer.from("shared cross-process weights");
    const destination = path.join(makeTempDir(), "model.bin");
    const first = new PassThrough();
    const second = new PassThrough();
    const expected = { sizeBytes: body.byteLength, digest: { algorithm: "sha256" as const, value: sha256(body) } };

    const transfers = Promise.all([
      download({ destination, expected, request: () => Promise.resolve(respond(first)) }),
      download({ destination, expected, request: () => Promise.resolve(respond(second)) }),
    ]);
    first.write(body.subarray(0, 4));
    second.write(body.subarray(0, 4));
    await waitFor(() => partialsOf(destination).length === 2);
    const pattern = new RegExp(`^model\\.bin\\.${process.pid}\\.[0-9a-f-]{36}\\.partial$`);
    expect(partialsOf(destination).every((name) => pattern.test(name))).toBe(true);
    first.end(body.subarray(4));
    second.end(body.subarray(4));

    await transfers;
    expect(fs.readFileSync(destination)).toEqual(body);
    expect(partialsOf(destination)).toEqual([]);
  });

  it("reports an error status as data and drains the body", async () => {
    const destination = path.join(makeTempDir(), "model.bin");
    const response = respond(Buffer.from("missing"), { statusCode: 404 });
    const resume = vi.spyOn(response, "resume");

    await expect(failureOf(download({ destination, request: () => Promise.resolve(response) })))
      .resolves.toEqual({ kind: "status", statusCode: 404 });
    expect(resume).toHaveBeenCalled();
    expect(fs.existsSync(path.dirname(destination)) ? fs.readdirSync(path.dirname(destination)) : []).toEqual([]);
  });

  it.each([
    {
      name: "a body shorter than its pin",
      body: Buffer.from("short"),
      expected: { sizeBytes: 9 },
      failure: { kind: "size", receivedBytes: 5, expectedBytes: 9 },
    },
    {
      name: "a body whose digest does not match",
      body: Buffer.from("imposter"),
      expected: { sizeBytes: 8, digest: { algorithm: "sha256" as const, value: "0".repeat(64) } },
      failure: { kind: "digest" },
    },
    {
      name: "a body that overruns its pin",
      body: Buffer.alloc(64, 1),
      expected: { sizeBytes: 16 },
      failure: { kind: "oversize", receivedBytes: 64, expectedBytes: 16 },
    },
  ])("rejects $name and leaves nothing behind", async ({ body, expected, failure }) => {
    const destination = path.join(makeTempDir(), "model.bin");

    await expect(failureOf(download({ destination, expected, request: () => Promise.resolve(respond(body)) })))
      .resolves.toEqual(failure);
    expect(fs.readdirSync(path.dirname(destination))).toEqual([]);
  });

  it("holds the body to the server's Content-Length only when asked to", async () => {
    const dir = makeTempDir();
    const short = () => Promise.resolve(respond(Buffer.from("short"), { headers: { "content-length": "100" } }));

    await expect(failureOf(download({ destination: path.join(dir, "checked.bin"), request: short, checkContentLength: true })))
      .resolves.toEqual({ kind: "incomplete", receivedBytes: 5, contentLength: 100 });
    await expect(download({ destination: path.join(dir, "unchecked.bin"), request: short }))
      .resolves.toMatchObject({ sizeBytes: 5 });
    expect(fs.readdirSync(dir)).toEqual(["unchecked.bin"]);
  });

  it("abandons a transfer that stops producing bytes", async () => {
    const destination = path.join(makeTempDir(), "model.bin");
    const stream = new PassThrough();

    await expect(failureOf(download({ destination, idleTimeoutMs: 20, request: () => Promise.resolve(respond(stream)) })))
      .resolves.toEqual({ kind: "stalled", idleTimeoutMs: 20 });
    expect(partialsOf(destination)).toEqual([]);
    expect(stream.destroyed).toBe(true);
  });

  it("reports a connection that drops mid-body", async () => {
    const destination = path.join(makeTempDir(), "model.bin");
    const stream = new PassThrough();
    const pending = download({ destination, request: () => Promise.resolve(respond(stream)) });
    stream.write(Buffer.from("part"));
    await waitFor(() => partialsOf(destination).length === 1);
    stream.emit("aborted");

    await expect(failureOf(pending)).resolves.toEqual({ kind: "aborted" });
    expect(partialsOf(destination)).toEqual([]);
  });

  it("answers every abort with the caller's cancellation", async () => {
    const destination = path.join(makeTempDir(), "model.bin");
    const request = vi.fn<UrlRequest>();
    await expect(download({ destination, request, signal: AbortSignal.abort() })).rejects.toThrow("Example download cancelled.");
    expect(request).not.toHaveBeenCalled();

    // The HTTPS reader rejected in its own words while the caller aborted.
    const racing = new AbortController();
    await expect(download({
      destination,
      signal: racing.signal,
      request: () => {
        racing.abort();
        return Promise.reject(new Error("Hugging Face request cancelled."));
      },
    })).rejects.toThrow("Example download cancelled.");

    // Aborted once the headers arrived: the body is torn down unread.
    const afterHeaders = new AbortController();
    const response = respond(new PassThrough());
    await expect(download({
      destination,
      signal: afterHeaders.signal,
      request: () => {
        afterHeaders.abort();
        return Promise.resolve(response);
      },
    })).rejects.toThrow("Example download cancelled.");
    expect(response.destroyed).toBe(true);
  });

  it("removes its partial when cancelled mid-body", async () => {
    const destination = path.join(makeTempDir(), "model.bin");
    const stream = new PassThrough();
    const controller = new AbortController();
    const pending = download({ destination, signal: controller.signal, request: () => Promise.resolve(respond(stream)) });
    stream.write(Buffer.alloc(16, 7));
    await waitFor(() => partialsOf(destination).length === 1);
    controller.abort();

    await expect(pending).rejects.toThrow("Example download cancelled.");
    expect(partialsOf(destination)).toEqual([]);
    expect(fs.existsSync(destination)).toBe(false);
    expect(stream.destroyed).toBe(true);
  });

  it.each([
    {
      name: "its directory cannot be created",
      setup: (dir: string) => {
        fs.writeFileSync(path.join(dir, "blocker"), "a file, not a directory");
        return { destination: path.join(dir, "blocker", "model.bin") };
      },
      error: /EEXIST|ENOTDIR/,
    },
    {
      name: "a git blob pin arrives without its size",
      setup: (dir: string) => ({
        destination: path.join(dir, "model.bin"),
        expected: { digest: { algorithm: "gitBlobSha1" as const, value: "0".repeat(40) } },
      }),
      error: /needs the file size up front/,
    },
  ])("closes the response when setup fails before streaming because $name", async ({ setup, error }) => {
    const stream = new PassThrough();
    const options = setup(makeTempDir());

    await expect(download({ ...options, request: () => Promise.resolve(respond(stream)) })).rejects.toThrow(error);
    expect(stream.destroyed).toBe(true);
  });

  it("sweeps the fixed partial names older builds left behind", async () => {
    const dir = makeTempDir();
    const destination = path.join(dir, "model.bin");
    fs.writeFileSync(`${destination}.download`, "half a body");
    fs.writeFileSync(`${destination}.partial`, "half a body");

    await download({
      destination,
      request: () => Promise.resolve(respond(Buffer.from("body"))),
      legacyPartialPaths: [`${destination}.download`, `${destination}.partial`],
    });

    expect(fs.readdirSync(dir)).toEqual(["model.bin"]);
  });

  describe("when another process published the destination first", () => {
    const body = Buffer.from("published weights");
    const pinned = { sizeBytes: body.byteLength, digest: { algorithm: "sha256" as const, value: sha256(body) } };

    function refuseRename(): void {
      // Windows refuses to replace a file another process holds mapped.
      vi.spyOn(fs.promises, "rename").mockRejectedValueOnce(Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }));
    }

    it("accepts the winner after verifying it independently", async () => {
      const destination = path.join(makeTempDir(), "model.bin");
      fs.writeFileSync(destination, body);
      refuseRename();

      await expect(download({ destination, expected: pinned, request: () => Promise.resolve(respond(body)) }))
        .resolves.toEqual({ sizeBytes: body.byteLength, digest: pinned.digest.value });
      expect(partialsOf(destination)).toEqual([]);
    });

    it("keeps the rename error when the winner does not verify or nothing was pinned", async () => {
      const destination = path.join(makeTempDir(), "model.bin");
      fs.writeFileSync(destination, Buffer.alloc(body.byteLength, 0x41));
      refuseRename();
      await expect(download({ destination, expected: pinned, request: () => Promise.resolve(respond(body)) }))
        .rejects.toThrow("EPERM");

      fs.writeFileSync(destination, body);
      refuseRename();
      await expect(download({ destination, expected: { sizeBytes: body.byteLength }, request: () => Promise.resolve(respond(body)) }))
        .rejects.toThrow("EPERM");
      expect(partialsOf(destination)).toEqual([]);
    });
  });
});

describe("removeAbandonedPartials", () => {
  it("removes only partials whose writing process has exited", async () => {
    const dir = makeTempDir();
    const dead = `model.bin.${exitedPid()}.${randomUUID()}.partial`;
    const own = `model.bin.${process.pid}.${randomUUID()}.partial`;
    const liveForeign = `model.bin.${process.ppid}.${randomUUID()}.partial`;
    const unrelated = ["model.bin", "model.bin.partial", "model.bin.download", "notes.123.partial", "model.bin.12.not-a-uuid.partial"];
    for (const name of [dead, own, liveForeign, ...unrelated]) fs.writeFileSync(path.join(dir, name), "x");

    await removeAbandonedPartials(dir);

    expect(fs.readdirSync(dir).sort()).toEqual([own, liveForeign, ...unrelated].sort());
  });

  it("is a no-op for a directory that does not exist", async () => {
    await expect(removeAbandonedPartials(path.join(makeTempDir(), "missing"))).resolves.toBeUndefined();
  });
});
