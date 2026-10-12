/**
 * Rate-limits download progress where it is produced.
 *
 * A Hub transfer delivers a `data` event every ~16 KiB, roughly 70,000 per
 * gigabyte, and each one used to travel to the renderer as its own IPC message
 * and React commit. An update is passed on only when enough time has passed
 * since the last one or progress has moved far enough. The first update, the
 * start and the end of a stream, and any update the caller marks as a boundary
 * (a file finishing, say) always go through. An update held back is delivered
 * by a trailing timer once the interval has passed, so a transfer that goes
 * quiet does not leave the bar short of where it really is.
 */

/** At most ten updates a second from time alone. */
export const PROGRESS_MIN_INTERVAL_MS = 100;
/** Half a percent of the stream is always worth showing, however soon. */
export const PROGRESS_MIN_FRACTION = 0.005;

export interface ProgressThrottleOptions<T> {
  /** Where `value` sits in its stream, from 0 to 1, or `undefined` while the total is unknown. */
  fraction: (value: T) => number | undefined;
  minIntervalMs?: number;
  minFraction?: number;
  /** Seam for tests. */
  now?: () => number;
}

export interface ProgressThrottle<T> {
  /** Offers an update; a `boundary` update is never held back. */
  push: (value: T, boundary?: boolean) => void;
  /** Delivers the newest held-back update, if any. Call it when a stream ends. */
  flush: () => void;
  /**
   * Drops any held-back update and ignores everything after it, so nothing is
   * reported once the caller has finished or failed. Call it in a `finally`.
   */
  close: () => void;
}

export function createProgressThrottle<T>(
  emit: (value: T) => void,
  {
    fraction,
    minIntervalMs = PROGRESS_MIN_INTERVAL_MS,
    minFraction = PROGRESS_MIN_FRACTION,
    now = () => performance.now(),
  }: ProgressThrottleOptions<T>,
): ProgressThrottle<T> {
  let last: { at: number; position: number | undefined } | null = null;
  let held: { value: T } | null = null;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const cancelTrailing = () => {
    if (trailing) clearTimeout(trailing);
    trailing = null;
  };

  const deliver = (value: T, at: number, position: number | undefined) => {
    held = null;
    cancelTrailing();
    last = { at, position };
    emit(value);
  };

  const flush = () => {
    if (held) deliver(held.value, now(), fraction(held.value));
  };

  return {
    push(value, boundary = false) {
      if (closed) return;
      const at = now();
      const position = fraction(value);
      const isEdge = position !== undefined && (position <= 0 || position >= 1);
      const moved = position !== undefined
        && last?.position !== undefined
        && Math.abs(position - last.position) >= minFraction;
      if (boundary || last === null || isEdge || moved || at - last.at >= minIntervalMs) {
        deliver(value, at, position);
      } else {
        held = { value };
        if (!trailing) {
          // Due when an update would have been let through on time alone.
          trailing = setTimeout(flush, minIntervalMs - (at - last.at));
          trailing.unref?.();
        }
      }
    },
    flush() {
      if (!closed) flush();
    },
    close() {
      closed = true;
      held = null;
      cancelTrailing();
    },
  };
}
