/**
 * The on-disk half of the Audio8 runtime: it turns the pinned asset table in
 * `audio8Model.ts` into verified files under the revision cache directory.
 *
 * Every asset is addressed by size plus a digest, so a truncated download, a
 * half-written `.partial` left by a crash, or an unrelated file of the right
 * length can never reach ONNX Runtime. Transfers are deduplicated per file and
 * abandoned only when every caller has given up.
 */

import { createHash, randomUUID, type Hash } from "crypto";
import { createWriteStream, promises as fs } from "fs";
import type { IncomingMessage } from "http";
import path from "path";
import { audio8AssetUrl, type Audio8Asset, type Audio8Digest } from "./audio8Model";
import { requestUrl, type UrlRequest } from "./qwen3ModelDownload";
import { SharedTaskGroup } from "./audio8SharedTask";

/**
 * A transfer that has produced no bytes for this long is wedged rather than
 * slow. There is deliberately no cap on total duration: the largest asset is
 * 277 MiB and a slow connection must be allowed to take as long as it needs.
 */
export const AUDIO8_DOWNLOAD_IDLE_TIMEOUT_MS = 120_000;

/** Streaming digest verification reads cached files in chunks of this size. */
const VERIFY_CHUNK_BYTES = 1024 * 1024;

export interface Audio8AssetProgress {
  /** Bytes of `totalBytes` that are on disk and verified. */
  receivedBytes: number;
  totalBytes: number;
}

export interface Audio8AssetCacheOptions {
  /** Seam for tests; production uses the shared HTTPS reader. */
  request?: UrlRequest;
  idleTimeoutMs?: number;
}

export function audio8DownloadCancelledError(): Error {
  return new Error("Audio8 asset download cancelled.");
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw audio8DownloadCancelledError();
}

/**
 * The Hub serves large files through LFS, which exposes an upstream SHA-256 of
 * the content, and small files as plain git blobs, which are only addressable
 * by `sha1("blob <size>\0" + content)`.
 */
function createDigestHash(digest: Audio8Digest, size: number): Hash {
  if (digest.algorithm === "sha256") return createHash("sha256");
  return createHash("sha1").update(Buffer.from(`blob ${size}\0`));
}

function integrityError(asset: Audio8Asset): Error {
  return new Error(`Audio8 ${asset.file} failed integrity verification.`);
}

export class Audio8AssetCache {
  readonly #modelDir: string;
  readonly #request: UrlRequest;
  readonly #idleTimeoutMs: number;
  readonly #verified = new Set<string>();
  readonly #downloads = new SharedTaskGroup<void, number>(audio8DownloadCancelledError);

  constructor(modelDir: string, options: Audio8AssetCacheOptions = {}) {
    this.#modelDir = path.resolve(modelDir);
    this.#request = options.request ?? requestUrl;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? AUDIO8_DOWNLOAD_IDLE_TIMEOUT_MS;
  }

  filePath(asset: Audio8Asset): string {
    return path.join(this.#modelDir, ...asset.file.split("/"));
  }

  /**
   * Downloads whatever is missing, in table order, reporting bytes completed
   * against the byte total of `assets`. Assets are fetched one at a time so a
   * cold start does not open eight connections at once and so progress stays
   * monotonic.
   */
  async ensure(
    assets: readonly Audio8Asset[],
    onProgress: (progress: Audio8AssetProgress) => void = () => {},
    signal?: AbortSignal,
  ): Promise<void> {
    const totalBytes = assets.reduce((total, asset) => total + asset.size, 0);
    let completedBytes = 0;
    for (const asset of assets) {
      throwIfCancelled(signal);
      await this.#ensureAsset(asset, (receivedBytes) => {
        onProgress({ receivedBytes: completedBytes + receivedBytes, totalBytes });
      }, signal);
      completedBytes += asset.size;
      onProgress({ receivedBytes: completedBytes, totalBytes });
    }
  }

  async readFile(asset: Audio8Asset): Promise<Buffer> {
    return fs.readFile(this.filePath(asset));
  }

  async #ensureAsset(
    asset: Audio8Asset,
    onBytes: (receivedBytes: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.#verified.has(asset.file)) return;
    if (await this.#isCachedCopyValid(asset, signal)) {
      this.#verified.add(asset.file);
      return;
    }
    await this.#downloads.run(
      asset.file,
      (context) => this.#download(asset, context.report, context.signal),
      { onProgress: onBytes, signal },
    );
    this.#verified.add(asset.file);
  }

  /**
   * Verified once per file per process. `stat().size` alone accepts a file that
   * was truncated and appended to, or a stale copy of the same length, and the
   * failure that produces is either garbled audio or an opaque ORT error. The
   * full 572 MiB hashes in well under a second on the machines this ships to,
   * against a load that spends seconds building ONNX sessions anyway.
   */
  async #isCachedCopyValid(asset: Audio8Asset, signal?: AbortSignal): Promise<boolean> {
    const target = this.filePath(asset);
    let handle;
    try {
      const stat = await fs.stat(target);
      if (!stat.isFile() || stat.size !== asset.size) return false;
      handle = await fs.open(target, "r");
    } catch {
      return false;
    }
    const hash = createDigestHash(asset.digest, asset.size);
    const buffer = Buffer.allocUnsafe(VERIFY_CHUNK_BYTES);
    try {
      for (;;) {
        throwIfCancelled(signal);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
      }
    } finally {
      await handle.close();
    }
    return hash.digest("hex") === asset.digest.value;
  }

  async #download(
    asset: Audio8Asset,
    onBytes: (receivedBytes: number) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const url = audio8AssetUrl(asset);
    const target = this.filePath(asset);
    // App windows share one worker, but two independently launched app
    // processes do not. A process-unique partial prevents one process from
    // unlinking and then publishing another process's still-incomplete file.
    const temporaryPath = `${target}.${process.pid}.${randomUUID()}.partial`;
    try {
      throwIfCancelled(signal);
      const response = await this.#request(url, signal);
      throwIfCancelled(signal);
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        response.resume();
        throw new Error(`Audio8 download failed for ${asset.file} (HTTP ${status}).`);
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      // Clean the legacy shared partial name. New transfers use a unique name,
      // so this can never unlink another live process's output.
      await fs.rm(`${target}.partial`, { force: true });
      const hash = createDigestHash(asset.digest, asset.size);
      const receivedBytes = await this.#writeResponse(asset, response, temporaryPath, hash, onBytes, signal);
      if (receivedBytes !== asset.size || hash.digest("hex") !== asset.digest.value) {
        throw integrityError(asset);
      }
      throwIfCancelled(signal);
      try {
        await fs.rename(temporaryPath, target);
      } catch (error) {
        // Windows will not replace a target another process published first.
        // Accept it only after independently verifying the winning copy.
        if (!await this.#isCachedCopyValid(asset, signal)) throw error;
      }
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      // The shared HTTPS reader reports aborts in its own wording; every abort
      // reaching this point is an Audio8 cancellation.
      if (signal.aborted) throw audio8DownloadCancelledError();
      throw error;
    }
  }

  #writeResponse(
    asset: Audio8Asset,
    response: IncomingMessage,
    temporaryPath: string,
    hash: Hash,
    onBytes: (receivedBytes: number) => void,
    signal: AbortSignal,
  ): Promise<number> {
    const output = createWriteStream(temporaryPath, { flags: "wx" });
    let receivedBytes = 0;
    return new Promise<number>((resolve, reject) => {
      let settled = false;
      let finished = false;
      let failure: Error | undefined;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const abandon = () => fail(audio8DownloadCancelledError());
      const complete = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (idleTimer) clearTimeout(idleTimer);
        signal.removeEventListener("abort", abandon);
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
        idleTimer = setTimeout(() => fail(new Error(
          `Audio8 download stalled for ${this.#idleTimeoutMs / 1000}s: ${asset.file}`,
        )), this.#idleTimeoutMs);
        idleTimer.unref?.();
      };
      response.on("data", (chunk: Buffer) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        receivedBytes += buffer.byteLength;
        if (receivedBytes > asset.size) {
          fail(new Error(`Audio8 download exceeded the expected size: ${asset.file}`));
          return;
        }
        hash.update(buffer);
        armIdleTimer();
        onBytes(receivedBytes);
      });
      response.on("aborted", () => fail(new Error(`Audio8 download closed early: ${asset.file}`)));
      response.on("error", fail);
      output.on("error", fail);
      output.on("finish", () => {
        finished = true;
      });
      // "close" always follows, whether the stream finished or was destroyed,
      // so the file handle is never left open behind a rejection.
      output.on("close", () => {
        complete(failure ?? (finished ? undefined : new Error(`Audio8 download closed early: ${asset.file}`)));
      });
      armIdleTimer();
      // The shared HTTPS reader only watches the signal until the headers
      // arrive; from here the response body is ours to tear down.
      signal.addEventListener("abort", abandon, { once: true });
      if (signal.aborted) abandon();
      else response.pipe(output);
    });
  }
}
