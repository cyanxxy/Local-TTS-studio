// @vitest-environment node

import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileHash, hashFile, isVerifiedFile, type PinnedFile } from "./fileDigest";

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
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

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
