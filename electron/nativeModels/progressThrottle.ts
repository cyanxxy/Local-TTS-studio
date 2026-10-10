/**
 * Rate-limits download progress where it is produced.
 *
 * A Hub transfer delivers a `data` event every ~16 KiB, roughly 70,000 per
 * gigabyte, and each one used to travel to the renderer as its own IPC message
 * and React commit. An update is passed on only when enough time has passed
 * since the last one or progress has moved far enough. The first update, the
 * start and the end of a stream, and any update the caller marks as a boundary
 * (a file finishing, say) always go through, so the bar never stalls short of
 * where the transfer really is.
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

  const deliver = (value: T, at: number, position: number | undefined) => {
    held = null;
    last = { at, position };
    emit(value);
  };

  return {
    push(value, boundary = false) {
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
      }
    },
    flush() {
      if (held) deliver(held.value, now(), fraction(held.value));
    },
  };
}
