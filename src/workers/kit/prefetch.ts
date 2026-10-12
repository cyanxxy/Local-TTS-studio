/**
 * Ordered downloads with a bounded lookahead. Handing out one file starts
 * the download of the next one, so the download overlaps whatever the
 * caller does with the previous file (for a model, ONNX session creation)
 * while never holding more than one file ahead, and never one larger than
 * `maxAheadBytes`. Fetching every file at once instead would keep every
 * model buffer resident together.
 */

export interface PrefetcherOptions<T> {
  /** The order files are taken in; taking one prefetches the next. */
  order: readonly string[];
  fetch(file: string): Promise<T>;
  /** Pinned size in bytes, used to keep large files from being fetched ahead. */
  sizeOf(file: string): number;
  maxAheadBytes: number;
}

export interface Prefetcher<T> {
  /**
   * The file's contents: the prefetched download when there is one,
   * otherwise a new fetch. A prefetch is handed out once, so taking the same
   * file again fetches it again (from the cache, for a verified asset).
   */
  take(file: string): Promise<T>;
  /** Starts fetching a file ahead of time unless it is in flight or too large. */
  prefetch(file: string): void;
}

export function createPrefetcher<T>({ order, fetch, sizeOf, maxAheadBytes }: PrefetcherOptions<T>): Prefetcher<T> {
  const ahead = new Map<string, Promise<T>>();

  const prefetch = (file: string): void => {
    if (ahead.has(file) || sizeOf(file) > maxAheadBytes) return;
    const pending = fetch(file);
    // A failure is reported to whoever takes the file; one that is never
    // taken (the load already failed) must not surface as unhandled.
    pending.catch(() => undefined);
    ahead.set(file, pending);
  };

  return {
    prefetch,
    take(file) {
      const pending = ahead.get(file) ?? fetch(file);
      ahead.delete(file);
      const position = order.indexOf(file);
      if (position >= 0 && position + 1 < order.length) prefetch(order[position + 1]);
      return pending;
    },
  };
}
