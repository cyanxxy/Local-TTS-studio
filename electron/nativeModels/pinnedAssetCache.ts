/**
 * Turns a pinned asset table into verified files under a model directory.
 *
 * Every asset is addressed by size plus a digest, so a truncated download, a
 * half-written partial left by a crash, or an unrelated file of the right
 * length can never reach an inference runtime. Transfers are deduplicated per
 * file and abandoned only when every caller has given up.
 */

import { promises as fs } from "fs";
import path from "path";
import { isVerifiedFile, type FileDigest } from "./fileDigest";
import { requestUrl, type UrlRequest } from "./hubHttps";
import { createProgressThrottle } from "./progressThrottle";
import { SharedTaskGroup } from "./sharedTask";
import { downloadVerifiedFile, type DownloadFailure } from "./verifiedDownload";

export interface PinnedAsset {
  /** Path relative to the model directory, and to the upstream repository. */
  file: string;
  /** Exact byte length; a size mismatch fails verification before the digest. */
  size: number;
  digest: FileDigest;
}

export interface AssetProgress {
  /** Bytes of `totalBytes` that have arrived or were already verified. */
  receivedBytes: number;
  totalBytes: number;
}

export interface PinnedAssetCacheOptions<TAsset extends PinnedAsset> {
  /** Where `asset` is fetched from: the pinned revision, never a branch. */
  resolveUrl: (asset: TAsset) => string;
  cancelledError: () => Error;
  /** Words a failed transfer of `asset` the way the model reports errors. */
  describeFailure: (asset: TAsset, failure: DownloadFailure) => Error;
  /** A transfer that produces no bytes for this long is wedged rather than slow. */
  idleTimeoutMs: number;
  /** Seam for tests; production uses the shared HTTPS reader. */
  request?: UrlRequest;
}

export class PinnedAssetCache<TAsset extends PinnedAsset> {
  readonly #modelDir: string;
  readonly #options: PinnedAssetCacheOptions<TAsset>;
  readonly #request: UrlRequest;
  readonly #verified = new Set<string>();
  readonly #downloads: SharedTaskGroup<void, number>;

  constructor(modelDir: string, options: PinnedAssetCacheOptions<TAsset>) {
    this.#modelDir = path.resolve(modelDir);
    this.#options = options;
    this.#request = options.request ?? requestUrl;
    this.#downloads = new SharedTaskGroup<void, number>(options.cancelledError);
  }

  filePath(asset: TAsset): string {
    return path.join(this.#modelDir, ...asset.file.split("/"));
  }

  /**
   * Downloads whatever is missing, in table order, reporting bytes completed
   * against the byte total of `assets`. Assets are fetched one at a time so a
   * cold start does not open every connection at once and so progress stays
   * monotonic. Byte progress is throttled here, at its source; every asset
   * that becomes ready is still reported, so the last report is the total.
   */
  async ensure(
    assets: readonly TAsset[],
    onProgress: (progress: AssetProgress) => void = () => {},
    signal?: AbortSignal,
  ): Promise<void> {
    const totalBytes = assets.reduce((total, asset) => total + asset.size, 0);
    const progress = createProgressThrottle(onProgress, {
      fraction: ({ receivedBytes }) => (totalBytes > 0 ? receivedBytes / totalBytes : undefined),
    });
    let completedBytes = 0;
    for (const asset of assets) {
      if (signal?.aborted) throw this.#options.cancelledError();
      await this.#ensureAsset(asset, (receivedBytes) => {
        progress.push({ receivedBytes: completedBytes + receivedBytes, totalBytes });
      }, signal);
      completedBytes += asset.size;
      progress.push({ receivedBytes: completedBytes, totalBytes }, true);
    }
  }

  async readFile(asset: TAsset): Promise<Buffer> {
    return fs.readFile(this.filePath(asset));
  }

  async #ensureAsset(
    asset: TAsset,
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
   * failure that produces is either garbled audio or an opaque runtime error.
   * Hundreds of MiB hash in well under a second on the machines this ships to,
   * against a load that spends seconds building inference sessions anyway.
   */
  #isCachedCopyValid(asset: TAsset, signal?: AbortSignal): Promise<boolean> {
    return isVerifiedFile(
      this.filePath(asset),
      { sizeBytes: asset.size, digest: asset.digest },
      { signal, cancelledError: this.#options.cancelledError },
    );
  }

  async #download(asset: TAsset, onBytes: (receivedBytes: number) => void, signal: AbortSignal): Promise<void> {
    const destination = this.filePath(asset);
    await downloadVerifiedFile({
      url: this.#options.resolveUrl(asset),
      destination,
      request: this.#request,
      expected: { sizeBytes: asset.size, digest: asset.digest },
      idleTimeoutMs: this.#options.idleTimeoutMs,
      onBytes,
      // Builds before process-unique partials shared one fixed name.
      legacyPartialPaths: [`${destination}.partial`],
      signal,
      cancelledError: this.#options.cancelledError,
      describeFailure: (failure) => this.#options.describeFailure(asset, failure),
    });
  }
}
