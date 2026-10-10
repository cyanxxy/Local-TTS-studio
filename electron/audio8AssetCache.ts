/**
 * The on-disk half of the Audio8 runtime: it turns the pinned asset table in
 * `audio8Model.ts` into verified files under the revision cache directory.
 *
 * The download, verification and deduplication logic is the shared
 * `PinnedAssetCache`; this module only binds it to Audio8's two upstream
 * revisions and to Audio8's error wording.
 */

import { audio8AssetUrl, type Audio8Asset } from "./audio8Model";
import type { UrlRequest } from "./nativeModels/hubHttps";
import { PinnedAssetCache, type AssetProgress } from "./nativeModels/pinnedAssetCache";
import type { DownloadFailure } from "./nativeModels/verifiedDownload";

/**
 * A transfer that has produced no bytes for this long is wedged rather than
 * slow. There is deliberately no cap on total duration: the largest asset is
 * 277 MiB and a slow connection must be allowed to take as long as it needs.
 */
export const AUDIO8_DOWNLOAD_IDLE_TIMEOUT_MS = 120_000;

export type Audio8AssetProgress = AssetProgress;

export interface Audio8AssetCacheOptions {
  /** Seam for tests; production uses the shared HTTPS reader. */
  request?: UrlRequest;
  idleTimeoutMs?: number;
}

export function audio8DownloadCancelledError(): Error {
  return new Error("Audio8 asset download cancelled.");
}

function describeAudio8DownloadFailure(asset: Audio8Asset, failure: DownloadFailure): Error {
  switch (failure.kind) {
    case "status":
      return new Error(`Audio8 download failed for ${asset.file} (HTTP ${failure.statusCode ?? 0}).`);
    case "stalled":
      return new Error(`Audio8 download stalled for ${failure.idleTimeoutMs / 1000}s: ${asset.file}`);
    case "aborted":
    case "truncated":
      return new Error(`Audio8 download closed early: ${asset.file}`);
    case "oversize":
      return new Error(`Audio8 download exceeded the expected size: ${asset.file}`);
    default:
      return new Error(`Audio8 ${asset.file} failed integrity verification.`);
  }
}

export class Audio8AssetCache extends PinnedAssetCache<Audio8Asset> {
  constructor(modelDir: string, options: Audio8AssetCacheOptions = {}) {
    super(modelDir, {
      resolveUrl: audio8AssetUrl,
      cancelledError: audio8DownloadCancelledError,
      describeFailure: describeAudio8DownloadFailure,
      idleTimeoutMs: options.idleTimeoutMs ?? AUDIO8_DOWNLOAD_IDLE_TIMEOUT_MS,
      request: options.request,
    });
  }
}
