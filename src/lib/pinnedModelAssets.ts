/**
 * Download-once model files for workers that run their own onnxruntime-web
 * sessions. Every file is listed in a generated PinnedAssetManifest
 * (src/workers/manifests/, written by scripts/pin-hf-assets.mjs), is verified
 * against its pinned size and digest before use, and only verified bytes
 * enter Cache Storage. A cached copy that fails verification is evicted and
 * downloaded again.
 */
import type { LoadProgress } from "../workers/kit/progress";
import { verifyPinnedAssetIntegrity, type PinnedAssetIntegrity, type PinnedAssetManifest } from "./pinnedModelFetch";

export interface PinnedAssetFetchOptions {
  /** Cache Storage name; keep "transformers" in it so the app's clear-cache action covers it. */
  cacheName: string;
  /** Prefix for error messages, such as "Kitten TTS". */
  label: string;
  /** Receives the file's received bytes, keyed by its manifest path, and its completion. */
  progress?: Pick<LoadProgress, "update" | "complete">;
  /** Stops a download the caller no longer needs, before it reports more progress. */
  signal?: AbortSignal;
}

/** The file's resolve URL at the manifest's commit; also its Cache Storage key. */
export function pinnedAssetUrl(manifest: PinnedAssetManifest, file: string): string {
  const path = file.split("/").map(encodeURIComponent).join("/");
  return `https://huggingface.co/${manifest.repo}/resolve/${manifest.revision}/${path}`;
}

/** Pinned byte sizes of `files`, for createLoadProgress's expectedBytes. */
export function pinnedAssetSizes(manifest: PinnedAssetManifest, files: readonly string[]): Record<string, number> {
  return Object.fromEntries(files.map((file) => [file, pinnedAsset(manifest, file).byteLength]));
}

function pinnedAsset(manifest: PinnedAssetManifest, file: string): PinnedAssetIntegrity {
  const expected = Object.hasOwn(manifest.files, file) ? manifest.files[file] : undefined;
  if (!expected) throw new Error(`${file} is not a pinned asset of ${manifest.repo}.`);
  return expected;
}

async function openCache(cacheName: string): Promise<Cache | null> {
  if (typeof caches === "undefined") return null;
  try {
    return await caches.open(cacheName);
  } catch {
    // Storage can be unavailable (private browsing, blocked site data): download without caching.
    return null;
  }
}

/**
 * Reads a response body into exactly `byteLength` bytes. The pinned size is
 * authoritative and Content-Length is never used to size the buffer: Hugging
 * Face serves small files compressed with no Content-Length, and when one is
 * present it counts encoded bytes, not the decoded body read here.
 */
async function readPinnedBody(
  response: Response,
  file: string,
  byteLength: number,
  { label, progress, signal }: PinnedAssetFetchOptions,
): Promise<ArrayBuffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== byteLength) throw new Error(`${label} ${file} did not match its pinned size.`);
    return buffer;
  }

  const bytes = new Uint8Array(byteLength);
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      if (received + value.byteLength > byteLength) throw new Error(`${label} ${file} exceeded its pinned size.`);
      bytes.set(value, received);
      received += value.byteLength;
      progress?.update(file, received);
    }
  } catch (error) {
    // Stop the download instead of draining a body that is already rejected.
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  if (received !== byteLength) {
    throw new Error(`${label} ${file} was truncated at ${received} of ${byteLength} bytes.`);
  }
  return bytes.buffer;
}

/** Fetches one pinned file from the verified cache or the network. */
export async function fetchPinnedAsset(
  manifest: PinnedAssetManifest,
  file: string,
  options: PinnedAssetFetchOptions,
): Promise<ArrayBuffer> {
  const { cacheName, label, progress, signal } = options;
  const expected = pinnedAsset(manifest, file);
  const url = pinnedAssetUrl(manifest, file);
  const cache = await openCache(cacheName);
  const cached = await cache?.match(url).catch(() => undefined);
  if (cached) {
    const buffer = await cached.arrayBuffer();
    if (await verifyPinnedAssetIntegrity(buffer, expected)) {
      progress?.complete(file);
      return buffer;
    }
    await cache?.delete(url).catch(() => false);
  }

  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Failed to download ${label} ${file}: HTTP ${response.status}.`);
  const buffer = await readPinnedBody(response, file, expected.byteLength, options);
  if (!await verifyPinnedAssetIntegrity(buffer, expected)) {
    throw new Error(`${label} ${file} failed integrity verification.`);
  }
  const headers = new Headers({ "content-length": String(buffer.byteLength) });
  const contentType = response.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  try {
    await cache?.put(url, new Response(buffer, { headers }));
  } catch {
    // Quota or storage errors only cost a later re-download; the verified bytes are in memory.
  }
  signal?.throwIfAborted();
  progress?.complete(file);
  return buffer;
}

/** Removes cache entries that none of the manifests point at any more (old revisions, dropped files). */
export async function prunePinnedAssetCache(cacheName: string, manifests: readonly PinnedAssetManifest[]): Promise<void> {
  const cache = await openCache(cacheName);
  if (!cache) return;
  const keepUrls = new Set(manifests.flatMap((manifest) => (
    Object.keys(manifest.files).map((file) => pinnedAssetUrl(manifest, file))
  )));
  try {
    for (const request of await cache.keys()) {
      if (!keepUrls.has(request.url)) await cache.delete(request);
    }
  } catch {
    // Pruning is housekeeping; never fail a model load over it.
  }
}

export async function deletePinnedAssetCache(cacheName: string): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    await caches.delete(cacheName);
  } catch {
    // Nothing to delete when storage is unavailable.
  }
}
