import { useCallback, useSyncExternalStore } from "react";

/**
 * The playback position advances once per animation frame. Routing it through
 * React state would re-render every component between the player hook and the
 * scrubber ~60 times a second, so it lives in this external store instead:
 * consumers subscribe at the leaf that actually needs it, and derived consumers
 * subscribe through a selector so they only re-render when their own value
 * changes (an active word index changes a few times a second, not 60).
 */
export class PlaybackClock {
  private time = 0;
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getTime = (): number => this.time;

  set(next: number): void {
    if (next === this.time) return;
    this.time = next;
    for (const listener of this.listeners) listener();
  }
}

/**
 * Subscribes to every clock tick. Only use this in a leaf that genuinely needs
 * frame-rate updates; prefer `usePlaybackSelector` everywhere else.
 */
export function usePlaybackTime(clock: PlaybackClock): number {
  return useSyncExternalStore(clock.subscribe, clock.getTime, clock.getTime);
}

/**
 * Subscribes to a value derived from the playback position, re-rendering only
 * when that value changes.
 *
 * `selector` must be referentially stable (wrap it in `useCallback`) and must
 * return a primitive or an otherwise `Object.is`-stable value — returning a
 * fresh object every call would re-render on every tick, defeating the point,
 * and `useSyncExternalStore` would loop.
 */
export function usePlaybackSelector<T>(
  clock: PlaybackClock,
  selector: (timeSec: number) => T,
): T {
  const getSnapshot = useCallback(() => selector(clock.getTime()), [clock, selector]);
  return useSyncExternalStore(clock.subscribe, getSnapshot, getSnapshot);
}
