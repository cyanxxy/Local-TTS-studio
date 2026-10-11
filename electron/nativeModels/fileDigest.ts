/**
 * Content digests of pinned model files.
 *
 * The Hub serves large files through LFS, which exposes an upstream SHA-256 of
 * the content, and small files as plain git blobs, which are only addressable
 * by `sha1("blob <size>\0" + content)`. Every desktop model is verified against
 * one of the two before it is trusted.
 *
 * `FileDigestCache` remembers a digest for as long as the file it was read from
 * is provably the same file, so re-inspecting gigabytes of unchanged weights on
 * every setup call and profile switch costs a `stat` per file.
 */

import { createHash, type Hash } from "crypto";
import { promises as fs, type BigIntStats } from "fs";
import path from "path";
import { SharedTaskGroup } from "./sharedTask";

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

/**
 * What makes a file the same file. Device and inode survive a rename but not a
 * replacement, every write moves the modification time, and the change time
 * moves on every write and on every attempt to set the modification time back,
 * which userland cannot fake. Nanosecond fields keep two edits within one
 * filesystem tick apart wherever the filesystem records them.
 */
interface FileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

function identityOf(stat: BigIntStats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
}

function identityKey(identity: FileIdentity): string {
  return `${identity.dev}:${identity.ino}:${identity.size}:${identity.mtimeNs}:${identity.ctimeNs}`;
}

interface CachedDigest {
  identity: string;
  result: FileDigestResult;
}

/**
 * A file changed this recently may be written again within the same timestamp
 * tick, leaving its identity untouched. Ticks are up to two seconds on FAT and
 * HFS+, so a digest is remembered only for a file whose newest timestamp is
 * older than this when the read starts — git's "racy clean" rule. A file
 * inside the window is simply hashed again on its next inspection.
 */
export const RACY_TIMESTAMP_WINDOW_MS = 3_000;

export interface FileDigestCacheOptions {
  /** Paths remembered at once; the least recently hashed is forgotten first. */
  maxEntries?: number;
  /** Wall-clock milliseconds since the epoch. Seam for tests. */
  now?: () => number;
}

/**
 * Digests remembered per path while the file is provably unchanged.
 *
 * Only the content digest is cached, never a verdict: callers still compare it
 * with whatever pin or manifest applies to that call, so a changed manifest,
 * revision or expected digest is judged afresh every time. A file whose
 * identity moves while it is being read is hashed for the caller but not
 * remembered, and neither is one modified too recently to rule out a second
 * write within the same timestamp tick. Concurrent requests for the same
 * unchanged file share one read, abandoned only once every caller has
 * cancelled.
 */
export class FileDigestCache {
  readonly #cancelledError: () => Error;
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, CachedDigest>();
  readonly #reads: SharedTaskGroup<FileDigestResult>;

  constructor(cancelledError: () => Error, { maxEntries = 256, now = () => Date.now() }: FileDigestCacheOptions = {}) {
    this.#cancelledError = cancelledError;
    this.#maxEntries = Math.max(1, maxEntries);
    this.#now = now;
    this.#reads = new SharedTaskGroup<FileDigestResult>(cancelledError);
  }

  /** Rejects with the filesystem error when the file cannot be opened or read. */
  async digest(filePath: string, algorithm: DigestAlgorithm, signal?: AbortSignal): Promise<FileDigestResult> {
    if (signal?.aborted) throw this.#cancelledError();
    const resolved = path.resolve(filePath);
    const entryKey = `${algorithm}:${resolved}`;
    const identity = identityKey(identityOf(await fs.stat(resolved, { bigint: true })));
    const cached = this.#entries.get(entryKey);
    if (cached?.identity === identity) return { ...cached.result };
    const result = await this.#reads.run(
      `${entryKey}\0${identity}`,
      ({ signal: shared }) => this.#read(resolved, entryKey, algorithm, identity, shared),
      { signal },
    );
    return { ...result };
  }

  async #read(
    filePath: string,
    entryKey: string,
    algorithm: DigestAlgorithm,
    expected: string,
    signal: AbortSignal,
  ): Promise<FileDigestResult> {
    const startedAt = this.#now();
    const handle = await fs.open(filePath, "r");
    try {
      const stat = await handle.stat({ bigint: true });
      const before = identityKey(identityOf(stat));
      const result = await hashHandle(handle, algorithm, { signal, cancelledError: this.#cancelledError });
      const after = identityKey(identityOf(await handle.stat({ bigint: true })));
      const newestChangeMs = Number((stat.mtimeNs > stat.ctimeNs ? stat.mtimeNs : stat.ctimeNs) / 1_000_000n);
      const settled = startedAt - newestChangeMs >= RACY_TIMESTAMP_WINDOW_MS;
      if (settled && before === expected && after === expected) this.#remember(entryKey, expected, result);
      return result;
    } finally {
      await handle.close();
    }
  }

  #remember(entryKey: string, identity: string, result: FileDigestResult): void {
    this.#entries.delete(entryKey);
    this.#entries.set(entryKey, { identity, result });
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= this.#maxEntries) break;
      this.#entries.delete(oldest);
    }
  }
}
