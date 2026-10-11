/**
 * What the native model framework needs to know about a model to host it.
 *
 * A desktop-only model that runs on `onnxruntime-node` in a worker thread is a
 * descriptor, a pinned asset table, and its own inference code. Downloads and
 * verification (`pinnedAssetCache`), the worker's request loop (`workerHost`),
 * the main-process owner of that worker (`workerClient`), and the revision
 * cache on disk (`modelCache`) are shared, and each reads its wording and its
 * locations from here.
 */
export interface NativeModelDescriptor {
  /** Names the model in every error and log line, e.g. "Audio8". */
  label: string;
  /** Directory under `userData/local-model-cache` holding every revision ever downloaded. */
  cacheNamespace: string;
  /** Pinned upstream revision. Its files live in a directory of the same name. */
  revision: string;
  /**
   * The compiled worker script, relative to the Electron output root
   * (`dist-electron`), e.g. "audio8NativeWorker.js".
   */
  workerEntry: string;
}
