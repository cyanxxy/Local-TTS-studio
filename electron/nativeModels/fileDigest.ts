/**
 * Content digests of pinned model files.
 *
 * The Hub serves large files through LFS, which exposes an upstream SHA-256 of
 * the content, and small files as plain git blobs, which are only addressable
 * by `sha1("blob <size>\0" + content)`. Every desktop model is verified against
 * one of the two before it is trusted.
 */

import { createHash, type Hash } from "crypto";
import { promises as fs } from "fs";

export type FileDigest =
  | { algorithm: "sha256"; value: string }
  | { algorithm: "gitBlobSha1"; value: string };

export type DigestAlgorithm = FileDigest["algorithm"];

export interface CancellationOptions {
  signal?: AbortSignal;
  /** The model's own cancellation error, used for an abort at any stage. */
  cancelledError: () => Error;
}

export interface FileDigestResult {
  sizeBytes: number;
  /** Lowercase hex digest in the requested algorithm. */
  digest: string;
}

/** A pinned file: its exact byte length and its digest. */
export interface PinnedFile {
  sizeBytes: number;
  digest: FileDigest;
}

/** Files are hashed in chunks of this size. */
const READ_CHUNK_BYTES = 1024 * 1024;

/** A git blob digest covers a header that carries the size, so it needs the size up front. */
export function createFileHash(algorithm: DigestAlgorithm, sizeBytes?: number): Hash {
  if (algorithm === "sha256") return createHash("sha256");
  if (sizeBytes === undefined) throw new Error("A git blob digest needs the file size up front.");
  return createHash("sha1").update(Buffer.from(`blob ${sizeBytes}\0`));
}

/** Feeds the rest of an open file into `hash` and returns how many bytes it read. */
async function hashOpenFile(
  handle: fs.FileHandle,
  hash: Hash,
  { signal, cancelledError }: CancellationOptions,
): Promise<number> {
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let sizeBytes = 0;
  for (;;) {
    if (signal?.aborted) throw cancelledError();
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) return sizeBytes;
    hash.update(buffer.subarray(0, bytesRead));
    sizeBytes += bytesRead;
  }
}

/**
 * Hashes an open file from its current position. A git blob header carries
 * the size the file had when it was opened; a file that grows or shrinks while
 * it is read yields a digest no pin can match, so it is never trusted.
 */
async function hashHandle(
  handle: fs.FileHandle,
  algorithm: DigestAlgorithm,
  cancellation: CancellationOptions,
): Promise<FileDigestResult> {
  const hash = createFileHash(algorithm, algorithm === "gitBlobSha1" ? (await handle.stat()).size : undefined);
  const sizeBytes = await hashOpenFile(handle, hash, cancellation);
  return { sizeBytes, digest: hash.digest("hex") };
}

/** Reads a whole file once. Rejects when it cannot be opened or read. */
export async function hashFile(
  filePath: string,
  algorithm: DigestAlgorithm,
  cancellation: CancellationOptions,
): Promise<FileDigestResult> {
  if (cancellation.signal?.aborted) throw cancellation.cancelledError();
  const handle = await fs.open(filePath, "r");
  try {
    return await hashHandle(handle, algorithm, cancellation);
  } finally {
    await handle.close();
  }
}

/**
 * True when `filePath` is a regular file of exactly the pinned length whose
 * digest matches. A file that is missing or cannot be opened is simply not
 * verified; a read that fails part way through still rejects. `stat().size`
 * alone would accept a file that was truncated and appended to, or a stale
 * copy of the same length.
 */
export async function isVerifiedFile(
  filePath: string,
  expected: PinnedFile,
  cancellation: CancellationOptions,
): Promise<boolean> {
  let handle: fs.FileHandle;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size !== expected.sizeBytes) return false;
    handle = await fs.open(filePath, "r");
  } catch {
    return false;
  }
  const hash = createFileHash(expected.digest.algorithm, expected.sizeBytes);
  try {
    await hashOpenFile(handle, hash, cancellation);
  } finally {
    await handle.close();
  }
  return hash.digest("hex") === expected.digest.value;
}
