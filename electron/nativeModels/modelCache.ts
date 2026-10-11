/**
 * On-disk cache management for native models.
 *
 * Native models are not `LocalModel`s — they run in a worker thread rather than
 * behind the Rust bridge — so they cannot reuse `local-tts:cache-info` and
 * `clear-cache`, whose request shape is keyed by the bridge-routing model union.
 * They still write into the same `userData/local-model-cache` tree, so this
 * module mirrors that surface (`LocalCacheInfo` out) and the renderer can
 * present every cache with one component.
 *
 * Everything here takes `userData` as an argument instead of reaching for
 * Electron's `app`, so the filesystem behaviour is unit-testable against real
 * temp directories.
 */

import { promises as fs, type Dirent } from "fs";
import path from "path";
import { getDirectorySizeBytes } from "../directorySize";
import type { LocalCacheInfo } from "../localTtsIpc";
import type { NativeModelDescriptor } from "./descriptor";

type CacheLocation = Pick<NativeModelDescriptor, "cacheNamespace">;
type RevisionLocation = Pick<NativeModelDescriptor, "cacheNamespace" | "revision">;

/**
 * Root of every revision of a model the app has ever downloaded. Size and clear
 * both operate here rather than on the current revision: the download directory
 * is revision-scoped, so a revision bump would otherwise leave hundreds of MiB
 * the storage screen never counts and no in-app action can reclaim.
 */
export function getNativeModelCacheDir(userDataPath: string, model: CacheLocation): string {
  return path.join(userDataPath, "local-model-cache", model.cacheNamespace);
}

/** Directory the inference worker downloads into and memory-maps weights from. */
export function getNativeModelDir(userDataPath: string, model: RevisionLocation): string {
  return path.join(getNativeModelCacheDir(userDataPath, model), model.revision);
}

export async function readNativeModelCacheInfo(
  userDataPath: string,
  model: CacheLocation,
): Promise<LocalCacheInfo> {
  const cachePath = getNativeModelCacheDir(userDataPath, model);

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
export async function clearNativeModelCache(
  userDataPath: string,
  model: CacheLocation,
): Promise<{ path: string; cleared: boolean }> {
  const cachePath = getNativeModelCacheDir(userDataPath, model);
  await fs.rm(cachePath, { recursive: true, force: true });
  return { path: cachePath, cleared: true };
}

/**
 * Deletes revision directories other than the current one, returning the names
 * removed. Unlike `clearNativeModelCache` this is safe to run with a live
 * worker: the worker is constructed with `getNativeModelDir()` and never reads
 * or writes outside it, so no file this touches can be mapped or downloading.
 *
 * Best-effort by construction — it runs off the back of a user-initiated load
 * and reclaiming disk must never be able to fail that load. A directory that
 * disappears mid-walk (a concurrent clear) or refuses to unlink (a second,
 * older app instance still holding it mapped on Windows) is skipped and
 * retried on the next successful load.
 */
export async function pruneStaleNativeModelRevisions(
  userDataPath: string,
  model: RevisionLocation,
): Promise<string[]> {
  const cachePath = getNativeModelCacheDir(userDataPath, model);

  let entries: Dirent[];
  try {
    entries = await fs.readdir(cachePath, { withFileTypes: true });
  } catch {
    return [];
  }

  // Only directories, and only ones named after a revision that is not current.
  // Loose files at the namespace root were not written by this app and are
  // cheaper to leave than to guess about.
  const stale = entries
    .filter((entry) => entry.isDirectory() && entry.name !== model.revision)
    .map((entry) => entry.name);

  const pruned = await Promise.all(stale.map(async (name) => {
    try {
      await fs.rm(path.join(cachePath, name), { recursive: true, force: true });
      return name;
    } catch (err) {
      console.warn(`[${model.cacheNamespace}] Could not prune stale model revision ${name}:`, err);
      return null;
    }
  }));

  return pruned.filter((name): name is string => name !== null);
}
