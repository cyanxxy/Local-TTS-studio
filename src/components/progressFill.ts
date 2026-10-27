import type { CSSProperties } from "react";

/**
 * Positions a progress bar's fill: a full-width bar slid left by the part not
 * yet done. Animating `width` (often through `transition-all`) re-laid-out the
 * bar on every progress tick, many times a second during a download or
 * playback; a translate is composited instead. The track must clip its fill
 * (`overflow-hidden` with the track's rounding), which also keeps the fill's
 * leading edge rounded the way a narrowing width used to.
 */
export function progressFillStyle(percent: number): CSSProperties {
  const clamped = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
  return { transform: `translateX(${clamped - 100}%)` };
}
