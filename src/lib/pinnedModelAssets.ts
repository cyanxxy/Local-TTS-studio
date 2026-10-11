/**
 * Download-once model files for workers that run their own onnxruntime-web
 * sessions. Each file comes from a generated manifest (src/lib/manifests/), is
 * verified against its pinned size and SHA-256 before use, and only verified
 * bytes enter Cache Storage. A cached copy that fails verification is evicted
 * and downloaded again.
 */
import { pinnedModelFileUrl, type PinnedModelFile } from "./manifests/types";
import { verifyPinnedAssetIntegrity } from "./pinnedModelFetch";

export interface PinnedModelFileFetchOptions {
  /** Cache Storage name; keep "transformers" in it so the app's clear-cache action covers it. */
  cacheName: string;
  /** Prefix for error messages, such as "Kitten TTS". */
  label: string;
  /** Bytes of this file received so far (the cached size at once on a cache hit). */
  onProgress?: (receivedBytes: number) => void;
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

async function readBody(response: Response, file: PinnedModelFile, label: string, onProgress?: (receivedBytes: number) => void): Promise<ArrayBuffer> {
  const reader = response.body?.getReader();
  if (!reader) return response.arrayBuffer();

  // Size the buffer from the manifest, never from Content-Length: Hugging Face
  // serves small files brotli-encoded without one.
  const bytes = new Uint8Array(file.byteLength);
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (received + value.byteLength > bytes.byteLength) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`${label} ${file.path} is larger than its pinned size.`);
    }
    bytes.set(value, received);
    received += value.byteLength;
    onProgress?.(received);
  }
  return received === bytes.byteLength ? bytes.buffer : bytes.buffer.slice(0, received);
}

/** Fetch one pinned file from the verified cache or the network. */
export async function fetchPinnedModelFile(file: PinnedModelFile, options: PinnedModelFileFetchOptions): Promise<ArrayBuffer> {
  const { cacheName, label, onProgress } = options;
  const url = pinnedModelFileUrl(file);
  const cache = await openCache(cacheName);
  const cached = await cache?.match(url).catch(() => undefined);
  if (cached) {
    const buffer = await cached.arrayBuffer();
    if (await verifyPinnedAssetIntegrity(buffer, file)) {
      onProgress?.(buffer.byteLength);
      return buffer;
    }
    await cache?.delete(url).catch(() => false);
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${label} ${file.path}: HTTP ${response.status}.`);
  const buffer = await readBody(response, file, label, onProgress);
  if (!await verifyPinnedAssetIntegrity(buffer, file)) {
    throw new Error(`${label} ${file.path} failed integrity verification.`);
  }
  try {
    await cache?.put(url, new Response(buffer, {
      headers: { "content-type": "application/octet-stream", "content-length": String(buffer.byteLength) },
    }));
  } catch {
    // Quota or storage errors only cost a later re-download; the verified bytes are in memory.
  }
  return buffer;
}

/**
 * Combine per-file byte counts into one 0-1 fraction over a set of files whose
 * exact sizes the manifests already know.
 */
export function trackDownloadProgress(
  files: readonly PinnedModelFile[],
  onProgress: (fraction: number) => void,
): (file: PinnedModelFile) => (receivedBytes: number) => void {
  const totalBytes = files.reduce((sum, file) => sum + file.byteLength, 0);
  const received = new Map<PinnedModelFile, number>();
  return (file) => (receivedBytes) => {
    received.set(file, Math.min(file.byteLength, receivedBytes));
    const done = Array.from(received.values()).reduce((sum, bytes) => sum + bytes, 0);
    onProgress(totalBytes > 0 ? done / totalBytes : 1);
  };
}

/** Remove cache entries that no manifest file points at any more (old revisions). */
export async function prunePinnedModelCache(cacheName: string, keep: readonly PinnedModelFile[]): Promise<void> {
  const cache = await openCache(cacheName);
  if (!cache) return;
  const keepUrls = new Set(keep.map(pinnedModelFileUrl));
  try {
    for (const request of await cache.keys()) {
      if (!keepUrls.has(request.url)) await cache.delete(request);
    }
  } catch {
    // Pruning is housekeeping; never fail a model load over it.
  }
}

export async function deletePinnedModelCache(cacheName: string): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    await caches.delete(cacheName);
  } catch {
    // Nothing to delete when storage is unavailable.
  }
}
