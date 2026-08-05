/**
 * On-disk cache management for the Audio8 native runtime.
 *
 * Audio8 is not a `LocalModel` — it runs in a worker thread rather than behind
 * the Rust bridge — so it cannot reuse `local-tts:cache-info`/`clear-cache`,
 * whose request shape is keyed by the bridge-routing model union. It still
 * writes into the same `userData/local-model-cache` tree, so this module mirrors
 * that surface (`LocalCacheInfo` in, same result shape out) and the renderer can
 * present both caches with one component.
 *
 * Everything here takes `userData` as an argument instead of reaching for
 * Electron's `app`, so the filesystem behaviour is unit-testable against real
 * temp directories.
 */

import { promises as fs } from "fs";
import path from "path";
import { AUDIO8_CACHE_NAMESPACE, AUDIO8_MODEL_REVISION } from "./audio8Model";
import { getDirectorySizeBytes } from "./directorySize";
import type { LocalCacheInfo } from "./localTtsIpc";

/**
 * Root of every Audio8 revision the app has ever downloaded. Size and clear both
 * operate here rather than on the current revision: the download directory is
 * revision-scoped, so a revision bump would otherwise leave ~572 MiB the storage
 * screen never counts and no in-app action can reclaim.
 */
export function getAudio8CacheDir(userDataPath: string): string {
  return path.join(userDataPath, "local-model-cache", AUDIO8_CACHE_NAMESPACE);
}

/** Directory the inference worker downloads into and memory-maps ONNX weights from. */
export function getAudio8ModelDir(userDataPath: string): string {
  return path.join(getAudio8CacheDir(userDataPath), AUDIO8_MODEL_REVISION);
}

export async function readAudio8CacheInfo(userDataPath: string): Promise<LocalCacheInfo> {
  const cachePath = getAudio8CacheDir(userDataPath);

  try {
    const stats = await fs.stat(cachePath);
    if (!stats.isDirectory()) {
      return { path: cachePath, exists: false, sizeBytes: 0 };
    }
  } catch {
    return { path: cachePath, exists: false, sizeBytes: 0 };
  }

  const sizeBytes = await getDirectorySizeBytes(cachePath);
  return { path: cachePath, exists: true, sizeBytes };
}

/**
 * Removes every revision, current one included. The caller must stop the
 * inference worker first: it holds the ONNX graphs memory-mapped, and on Windows
 * an unlink of a mapped file fails outright instead of deferring like POSIX.
 */
export async function clearAudio8Cache(
  userDataPath: string,
): Promise<{ path: string; cleared: boolean }> {
  const cachePath = getAudio8CacheDir(userDataPath);
  await fs.rm(cachePath, { recursive: true, force: true });
  return { path: cachePath, cleared: true };
}

/**
 * Deletes revision directories other than the current one, returning the names
 * removed. Unlike `clearAudio8Cache` this is safe to run with a live worker: the
 * worker is constructed with `getAudio8ModelDir()` and never reads or writes
 * outside it, so no file this touches can be mapped or downloading.
 *
 * Best-effort by construction — it runs off the back of a user-initiated load
 * and reclaiming disk must never be able to fail that load. A directory that
 * disappears mid-walk (a concurrent `clearAudio8Cache`) or refuses to unlink (a
 * second, older app instance still holding it mapped on Windows) is skipped and
 * retried on the next successful load.
 */
export async function pruneStaleAudio8Revisions(userDataPath: string): Promise<string[]> {
  const cachePath = getAudio8CacheDir(userDataPath);

  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(cachePath, { withFileTypes: true });
  } catch {
    return [];
  }

  // Only directories, and only ones named after a revision that is not current.
  // Loose files at the namespace root were not written by this app and are
  // cheaper to leave than to guess about.
  const stale = entries
    .filter((entry) => entry.isDirectory() && entry.name !== AUDIO8_MODEL_REVISION)
    .map((entry) => entry.name);

  const pruned = await Promise.all(stale.map(async (name) => {
    try {
      await fs.rm(path.join(cachePath, name), { recursive: true, force: true });
      return name;
    } catch (err) {
      console.warn(`[audio8] Could not prune stale model revision ${name}:`, err);
      return null;
    }
  }));

  return pruned.filter((name): name is string => name !== null);
}
