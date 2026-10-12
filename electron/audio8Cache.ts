/**
 * On-disk cache management for the Audio8 native runtime: the shared native
 * model cache bound to Audio8's namespace and pinned revision. The main
 * process sizes, clears and prunes `userData/local-model-cache/audio8` through
 * these.
 */

import { AUDIO8_DESCRIPTOR } from "./audio8Model";
import type { LocalCacheInfo } from "./localTtsIpc";
import {
  clearNativeModelCache,
  getNativeModelCacheDir,
  getNativeModelDir,
  pruneStaleNativeModelRevisions,
  readNativeModelCacheInfo,
} from "./nativeModels/modelCache";

/** Root of every Audio8 revision the app has ever downloaded. */
export function getAudio8CacheDir(userDataPath: string): string {
  return getNativeModelCacheDir(userDataPath, AUDIO8_DESCRIPTOR);
}

/** Directory the inference worker downloads into and memory-maps ONNX weights from. */
export function getAudio8ModelDir(userDataPath: string): string {
  return getNativeModelDir(userDataPath, AUDIO8_DESCRIPTOR);
}

export function readAudio8CacheInfo(userDataPath: string): Promise<LocalCacheInfo> {
  return readNativeModelCacheInfo(userDataPath, AUDIO8_DESCRIPTOR);
}

/** Removes every revision. Stop the inference worker first; see `clearNativeModelCache`. */
export function clearAudio8Cache(userDataPath: string): Promise<{ path: string; cleared: boolean }> {
  return clearNativeModelCache(userDataPath, AUDIO8_DESCRIPTOR);
}

/** Best-effort removal of superseded revisions; safe with a live worker. */
export function pruneStaleAudio8Revisions(userDataPath: string): Promise<string[]> {
  return pruneStaleNativeModelRevisions(userDataPath, AUDIO8_DESCRIPTOR);
}
