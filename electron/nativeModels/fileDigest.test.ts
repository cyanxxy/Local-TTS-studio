// @vitest-environment node

import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileHash, FileDigestCache, hashFile, isVerifiedFile, type PinnedFile } from "./fileDigest";

function cancelled(): Error {
  return new Error("Example download cancelled.");
}

const CANCELLATION = { cancelledError: cancelled };

const tempDirs: string[] = [];
function writeTemp(name: string, body: Buffer | string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-tts-file-digest-"));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

function sha256(body: Buffer | string): string {
  return createHash("sha256").update(body).digest("hex");
}

/** A signal that reads as aborted from its `afterChecks`-th look onwards. */
function abortsAfter(afterChecks: number): AbortSignal {
  let checks = 0;
  return {
    get aborted() {
      checks += 1;
      return checks > afterChecks;
    },
  } as AbortSignal;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type HandleMethod = (this: unknown, ...args: unknown[]) => Promise<unknown>;

/** Counts reads issued through any `FileHandle`, which is how contents are hashed. */
async function spyOnFileReads() {
  const probe = await fs.promises.open(writeTemp("probe.bin", "x"), "r");
  const prototype = Object.getPrototypeOf(probe) as { read: HandleMethod; stat: HandleMethod };
  await probe.close();
  const { read: realRead, stat: realStat } = prototype;
  const read = vi.spyOn(prototype, "read");
  return { reads: () => read.mock.calls.length, read, prototype, realRead, realStat };
}

describe("createFileHash", () => {
  it("addresses git blobs the way the Hub does", () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(createFileHash("gitBlobSha1", 6).update("hello\n").digest("hex"))
      .toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("refuses a git blob digest without the size its header needs", () => {
    expect(() => createFileHash("gitBlobSha1")).toThrow("A git blob digest needs the file size up front.");
  });
});

describe("hashFile", () => {
  it("returns the size and digest in either algorithm", async () => {
    const body = Buffer.alloc(3 * 1024 * 1024 + 17, 0x5a);
    const file = writeTemp("weights.bin", body);

    await expect(hashFile(file, "sha256", CANCELLATION)).resolves.toEqual({ sizeBytes: body.byteLength, digest: sha256(body) });
    await expect(hashFile(writeTemp("hello.txt", "hello\n"), "gitBlobSha1", CANCELLATION))
      .resolves.toEqual({ sizeBytes: 6, digest: "ce013625030ba8dba906f756967f9e9ca394464a" });
  });

  it("rejects with the filesystem error for a missing file", async () => {
    await expect(hashFile(path.join(os.tmpdir(), "open-tts-no-such-file"), "sha256", CANCELLATION))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops with the caller's cancellation before and between chunks", async () => {
    const file = writeTemp("weights.bin", Buffer.alloc(2 * 1024 * 1024 + 1));

    await expect(hashFile(file, "sha256", { signal: AbortSignal.abort(), cancelledError: cancelled }))
      .rejects.toThrow("Example download cancelled.");
    // Passes the entry check and the first chunk, then aborts.
    await expect(hashFile(file, "sha256", { signal: abortsAfter(2), cancelledError: cancelled }))
      .rejects.toThrow("Example download cancelled.");
  });
});

describe("isVerifiedFile", () => {
  const body = Buffer.from("pinned weights");
  const pinned: PinnedFile = { sizeBytes: body.byteLength, digest: { algorithm: "sha256", value: sha256(body) } };

  it("accepts only the exact pinned bytes", async () => {
    await expect(isVerifiedFile(writeTemp("ok.bin", body), pinned, CANCELLATION)).resolves.toBe(true);
    await expect(isVerifiedFile(writeTemp("same-size.bin", Buffer.alloc(body.byteLength, 0x41)), pinned, CANCELLATION))
      .resolves.toBe(false);
    await expect(isVerifiedFile(writeTemp("short.bin", body.subarray(1)), pinned, CANCELLATION)).resolves.toBe(false);
  });

  it("treats a missing file or a directory as unverified rather than failing", async () => {
    const file = writeTemp("ok.bin", body);

    await expect(isVerifiedFile(`${file}.missing`, pinned, CANCELLATION)).resolves.toBe(false);
    await expect(isVerifiedFile(path.dirname(file), pinned, CANCELLATION)).resolves.toBe(false);
  });

  it("verifies a git blob pin", async () => {
    const file = writeTemp("hello.txt", "hello\n");

    await expect(isVerifiedFile(file, {
      sizeBytes: 6,
      digest: { algorithm: "gitBlobSha1", value: "ce013625030ba8dba906f756967f9e9ca394464a" },
    }, CANCELLATION)).resolves.toBe(true);
  });

  it("rejects with the caller's cancellation part way through a read", async () => {
    const large = Buffer.alloc(2 * 1024 * 1024, 7);
    const file = writeTemp("large.bin", large);
    const pin: PinnedFile = { sizeBytes: large.byteLength, digest: { algorithm: "sha256", value: sha256(large) } };

    await expect(isVerifiedFile(file, pin, { signal: abortsAfter(1), cancelledError: cancelled }))
      .rejects.toThrow("Example download cancelled.");
  });
});

describe("FileDigestCache", () => {
  const body = Buffer.from("model weights");

  it("reads an unchanged file once, however often it is asked for", async () => {
    const file = writeTemp("model.bin", body);
    const cache = new FileDigestCache(cancelled);
    const { reads } = await spyOnFileReads();

    await expect(cache.digest(file, "sha256")).resolves.toEqual({ sizeBytes: body.byteLength, digest: sha256(body) });
    const afterFirst = reads();
    await expect(cache.digest(file, "sha256")).resolves.toEqual({ sizeBytes: body.byteLength, digest: sha256(body) });
    await expect(cache.digest(path.join(path.dirname(file), ".", "model.bin"), "sha256")).resolves.toMatchObject({
      digest: sha256(body),
    });

    expect(afterFirst).toBeGreaterThan(0);
    expect(reads()).toBe(afterFirst);
  });

  it("re-reads a same-size rewrite even when the modification time is put back", async () => {
    const file = writeTemp("model.bin", body);
    const cache = new FileDigestCache(cancelled);
    await cache.digest(file, "sha256");
    const { mtime } = fs.statSync(file);
    const tampered = Buffer.alloc(body.byteLength, 0x41);

    fs.writeFileSync(file, tampered);
    fs.utimesSync(file, mtime, mtime);

    await expect(cache.digest(file, "sha256")).resolves.toEqual({ sizeBytes: body.byteLength, digest: sha256(tampered) });
  });

  it("re-reads a file that was replaced by another of the same size", async () => {
    const file = writeTemp("model.bin", body);
    const cache = new FileDigestCache(cancelled);
    await cache.digest(file, "sha256");
    const replacement = Buffer.alloc(body.byteLength, 0x42);
    fs.writeFileSync(`${file}.new`, replacement);
    const { mtime } = fs.statSync(file);
    fs.utimesSync(`${file}.new`, mtime, mtime);
    fs.renameSync(`${file}.new`, file);

    await expect(cache.digest(file, "sha256")).resolves.toMatchObject({ digest: sha256(replacement) });
  });

  it("keeps digests per algorithm", async () => {
    const file = writeTemp("hello.txt", "hello\n");
    const cache = new FileDigestCache(cancelled);

    await expect(cache.digest(file, "sha256")).resolves.toMatchObject({ digest: sha256(Buffer.from("hello\n")) });
    await expect(cache.digest(file, "gitBlobSha1")).resolves.toEqual({
      sizeBytes: 6,
      digest: "ce013625030ba8dba906f756967f9e9ca394464a",
    });
  });

  it("shares one read between concurrent callers", async () => {
    const file = writeTemp("model.bin", body);
    const { reads } = await spyOnFileReads();
    await new FileDigestCache(cancelled).digest(file, "sha256");
    const readsPerPass = reads();
    const cache = new FileDigestCache(cancelled);

    const results = await Promise.all([cache.digest(file, "sha256"), cache.digest(file, "sha256")]);

    expect(results[0]).toEqual(results[1]);
    expect(reads()).toBe(readsPerPass * 2);
  });

  it("lets one caller cancel without failing another", async () => {
    const file = writeTemp("model.bin", Buffer.alloc(3 * 1024 * 1024, 3));
    const cache = new FileDigestCache(cancelled);
    const leaving = new AbortController();

    const left = cache.digest(file, "sha256", leaving.signal);
    const stayed = cache.digest(file, "sha256");
    leaving.abort();

    await expect(left).rejects.toThrow("Example download cancelled.");
    await expect(stayed).resolves.toMatchObject({ sizeBytes: 3 * 1024 * 1024 });
    await expect(cache.digest(file, "sha256", AbortSignal.abort())).rejects.toThrow("Example download cancelled.");
  });

  it("abandons a read once its only caller cancels, and remembers nothing from it", async () => {
    const file = writeTemp("model.bin", Buffer.alloc(3 * 1024 * 1024, 3));
    const cache = new FileDigestCache(cancelled);
    const { reads, read, realRead } = await spyOnFileReads();
    const controller = new AbortController();
    read.mockImplementationOnce(function (this: unknown, ...args: unknown[]) {
      controller.abort();
      return realRead.apply(this, args);
    });

    await expect(cache.digest(file, "sha256", controller.signal)).rejects.toThrow("Example download cancelled.");
    // Give the abandoned read its turn to observe the abort and stop.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const afterAbandoned = reads();
    expect(afterAbandoned).toBeLessThan(4);

    await expect(cache.digest(file, "sha256")).resolves.toMatchObject({ sizeBytes: 3 * 1024 * 1024 });
    expect(reads()).toBeGreaterThan(afterAbandoned);
  });

  it("does not remember a digest whose file changed while it was read", async () => {
    const file = writeTemp("model.bin", body);
    const cache = new FileDigestCache(cancelled);
    const { reads, prototype, realStat } = await spyOnFileReads();
    let stats = 0;
    vi.spyOn(prototype, "stat").mockImplementation(async function (this: unknown, ...args: unknown[]) {
      const stat = await realStat.apply(this, args) as fs.BigIntStats;
      stats += 1;
      // The second look, after the read, sees a newer write.
      return stats === 2 ? { ...stat, mtimeNs: stat.mtimeNs + 1n } : stat;
    });

    await cache.digest(file, "sha256");
    const afterFirst = reads();
    await cache.digest(file, "sha256");

    expect(reads()).toBeGreaterThan(afterFirst);
  });

  it("rejects with the filesystem error for a missing file", async () => {
    await expect(new FileDigestCache(cancelled).digest(path.join(os.tmpdir(), "open-tts-no-such-file"), "sha256"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("forgets the least recently hashed path beyond its bound, and everything on clear", async () => {
    const first = writeTemp("first.bin", body);
    const second = writeTemp("second.bin", body);
    const cache = new FileDigestCache(cancelled, { maxEntries: 1 });
    const { reads } = await spyOnFileReads();

    await cache.digest(first, "sha256");
    await cache.digest(second, "sha256");
    const beforeEvicted = reads();
    await cache.digest(first, "sha256");
    expect(reads()).toBeGreaterThan(beforeEvicted);

    const beforeCleared = reads();
    await cache.digest(first, "sha256");
    expect(reads()).toBe(beforeCleared);
    cache.clear();
    await cache.digest(first, "sha256");
    expect(reads()).toBeGreaterThan(beforeCleared);
  });
});
