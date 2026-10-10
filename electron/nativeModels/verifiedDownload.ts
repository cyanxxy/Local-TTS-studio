/**
 * The verified-download pipeline shared by every pinned desktop model.
 *
 * A file streams from the Hub into a process-unique `.partial` beside its
 * destination, is hashed as it lands, is held to its expected length while it
 * streams, is abandoned when it stalls or its caller cancels, and is renamed
 * into place only once its length and digest match. Nothing unverified ever
 * occupies a destination path, and two app instances downloading the same
 * file can neither unlink nor publish each other's incomplete bytes.
 *
 * Each model keeps its own error wording: failures reach the caller's
 * `describeFailure` as data and only become messages there.
 */

import { randomUUID, type Hash } from "crypto";
import { createWriteStream, promises as fs } from "fs";
import type { IncomingMessage } from "http";
import path from "path";
import { createFileHash, isVerifiedFile, type CancellationOptions, type FileDigest } from "./fileDigest";
import type { UrlRequest } from "./hubHttps";

export interface ExpectedFile {
  /** Exact byte length, enforced while the body streams. */
  sizeBytes?: number;
  digest?: FileDigest;
}

export type DownloadFailure =
  | { kind: "status"; statusCode: number | undefined }
  | { kind: "stalled"; idleTimeoutMs: number }
  /** The connection dropped mid-body. */
  | { kind: "aborted" }
  /** The partial file closed before the body finished. */
  | { kind: "truncated" }
  | { kind: "oversize"; receivedBytes: number; expectedBytes: number }
  | { kind: "incomplete"; receivedBytes: number; contentLength: number }
  | { kind: "size"; receivedBytes: number; expectedBytes: number }
  | { kind: "digest" };

export interface VerifiedDownloadOptions extends CancellationOptions {
  url: string;
  destination: string;
  request: UrlRequest;
  expected?: ExpectedFile;
  /** A transfer that produces no bytes for this long is wedged, not slow. */
  idleTimeoutMs: number;
  /** Bytes received so far, and the total when the pin or the server knows it. */
  onBytes?: (receivedBytes: number, totalBytes: number | undefined) => void;
  /** Also hold the body to the server's Content-Length. */
  checkContentLength?: boolean;
  /** Fixed partial names that older builds wrote, removed before this transfer. */
  legacyPartialPaths?: readonly string[];
  describeFailure: (failure: DownloadFailure) => Error;
}

export interface VerifiedDownloadResult {
  sizeBytes: number;
  /** Hex digest in the pinned algorithm, or SHA-256 when nothing was pinned. */
  digest: string;
}

/** `<target>.<pid>.<uuid>.partial`, as written by `downloadVerifiedFile`. */
const PARTIAL_NAME = /^.+\.(\d+)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.partial$/;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Removes partial files that a crashed or killed app instance left in
 * `directory`. A partial is abandoned only when the process that wrote it is
 * gone: this process's own transfers and those of another running instance are
 * left alone, and a recycled pid errs on the side of keeping the file.
 * Best-effort by construction, because reclaiming disk must never fail a
 * download or a load.
 */
export async function removeAbandonedPartials(directory: string): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch {
    return;
  }
  await Promise.all(names.map(async (name) => {
    const pid = Number(PARTIAL_NAME.exec(name)?.[1]);
    if (!Number.isSafeInteger(pid) || pid === process.pid || isProcessAlive(pid)) return;
    await fs.rm(path.join(directory, name), { force: true }).catch(() => undefined);
  }));
}

interface StreamTarget {
  response: IncomingMessage;
  temporaryPath: string;
  hash: Hash;
  totalBytes: number | undefined;
  options: VerifiedDownloadOptions;
}

/** Pipes the body to the partial file, hashing each chunk; resolves with the byte count. */
function streamToPartial({ response, temporaryPath, hash, totalBytes, options }: StreamTarget): Promise<number> {
  const { signal, expected, idleTimeoutMs, onBytes, cancelledError, describeFailure } = options;
  const output = createWriteStream(temporaryPath, { flags: "wx" });
  let receivedBytes = 0;
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    let finished = false;
    let failure: Error | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const abandon = () => fail(cancelledError());
    const complete = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      signal?.removeEventListener("abort", abandon);
      if (error) reject(error);
      else resolve(receivedBytes);
    };
    const fail = (error: Error) => {
      if (settled || failure) return;
      failure = error;
      if (idleTimer) clearTimeout(idleTimer);
      response.destroy();
      output.destroy();
    };
    const armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => fail(describeFailure({ kind: "stalled", idleTimeoutMs })), idleTimeoutMs);
      idleTimer.unref?.();
    };
    response.on("data", (chunk: Buffer) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      receivedBytes += buffer.byteLength;
      const expectedBytes = expected?.sizeBytes;
      if (expectedBytes !== undefined && receivedBytes > expectedBytes) {
        fail(describeFailure({ kind: "oversize", receivedBytes, expectedBytes }));
        return;
      }
      hash.update(buffer);
      armIdleTimer();
      onBytes?.(receivedBytes, totalBytes);
    });
    response.on("aborted", () => fail(describeFailure({ kind: "aborted" })));
    response.on("error", fail);
    output.on("error", fail);
    output.on("finish", () => {
      finished = true;
    });
    // "close" always follows, whether the stream finished or was destroyed,
    // so the file handle is never left open behind a rejection.
    output.on("close", () => {
      complete(failure ?? (finished ? undefined : describeFailure({ kind: "truncated" })));
    });
    armIdleTimer();
    // The HTTPS reader only watches the signal until the headers arrive; from
    // here the response body is ours to tear down.
    signal?.addEventListener("abort", abandon, { once: true });
    if (signal?.aborted) abandon();
    else response.pipe(output);
  });
}

/**
 * Downloads `url` to `destination` and returns what was verified. On any
 * failure the partial file is removed and the destination is untouched; an
 * abort at any stage rejects with the caller's cancellation error.
 */
export async function downloadVerifiedFile(options: VerifiedDownloadOptions): Promise<VerifiedDownloadResult> {
  const { url, destination, request, expected = {}, signal, cancelledError, describeFailure } = options;
  if (signal?.aborted) throw cancelledError();
  let response: IncomingMessage;
  try {
    response = await request(url, signal);
  } catch (error) {
    // The HTTPS reader reports aborts in its own wording; every abort reaching
    // this point is the model's cancellation.
    if (signal?.aborted) throw cancelledError();
    throw error;
  }
  if (signal?.aborted) {
    response.destroy();
    throw cancelledError();
  }
  const statusCode = response.statusCode;
  if (!statusCode || statusCode < 200 || statusCode >= 300) {
    response.resume();
    throw describeFailure({ kind: "status", statusCode });
  }
  const lengthHeader = response.headers["content-length"];
  const contentLength = typeof lengthHeader === "string" ? Number(lengthHeader) : undefined;
  const knownContentLength = contentLength !== undefined && Number.isFinite(contentLength) ? contentLength : undefined;
  // App windows share one process, but two independently launched app
  // instances do not. A process-unique partial stops one instance from
  // unlinking, and then publishing, another's still-incomplete file.
  const temporaryPath = `${destination}.${process.pid}.${randomUUID()}.partial`;
  try {
    const directory = path.dirname(destination);
    await fs.mkdir(directory, { recursive: true });
    // Fixed legacy names are swept unconditionally, as the builds that wrote
    // them did before every attempt. New transfers use a unique name, so this
    // can never unlink another live process's output.
    await Promise.all((options.legacyPartialPaths ?? []).map((legacy) => fs.rm(legacy, { force: true })));
    await removeAbandonedPartials(directory);
    const hash = createFileHash(expected.digest?.algorithm ?? "sha256", expected.sizeBytes);
    const receivedBytes = await streamToPartial({
      response,
      temporaryPath,
      hash,
      totalBytes: expected.sizeBytes ?? knownContentLength,
      options,
    });
    if (options.checkContentLength && knownContentLength !== undefined && receivedBytes !== knownContentLength) {
      throw describeFailure({ kind: "incomplete", receivedBytes, contentLength: knownContentLength });
    }
    if (expected.sizeBytes !== undefined && receivedBytes !== expected.sizeBytes) {
      throw describeFailure({ kind: "size", receivedBytes, expectedBytes: expected.sizeBytes });
    }
    const digest = hash.digest("hex");
    if (expected.digest && digest !== expected.digest.value) throw describeFailure({ kind: "digest" });
    if (signal?.aborted) throw cancelledError();
    try {
      await fs.rename(temporaryPath, destination);
    } catch (error) {
      // Windows will not replace a target another process holds open, which
      // happens when that process published first and mapped it. Accept the
      // winning copy only after independently verifying it, which needs both a
      // pinned length and a pinned digest.
      const { sizeBytes, digest: pinned } = expected;
      if (sizeBytes === undefined || !pinned) throw error;
      if (!await isVerifiedFile(destination, { sizeBytes, digest: pinned }, options)) throw error;
      // The winner stands, so this transfer's identical copy is surplus. Its
      // removal is best-effort: the published file is already verified, and a
      // later sweep reclaims the partial once this process has exited.
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
    return { sizeBytes: receivedBytes, digest };
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    if (signal?.aborted) throw cancelledError();
    throw error;
  }
}
