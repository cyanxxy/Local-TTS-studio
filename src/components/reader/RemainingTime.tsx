import { useCallback } from "react";
import { usePlaybackSelector, type PlaybackClock } from "../../lib/playbackClock";

/**
 * Time remaining. Subscribes to the playback clock on its own so the whole
 * reader does not re-render for a label that changes once a second.
 */
export function RemainingTime({
  clock,
  totalDuration,
  className,
}: {
  clock: PlaybackClock;
  totalDuration: number;
  className: string;
}) {
  const selectRemaining = useCallback(
    (timeSec: number) => Math.max(0, Math.ceil(totalDuration - timeSec)),
    [totalDuration],
  );
  const remainingSeconds = usePlaybackSelector(clock, selectRemaining);
  if (totalDuration <= 0) return null;
  return (
    <span className={className}>
      {remainingSeconds < 60
        ? `${remainingSeconds} sec left`
        : `${Math.ceil(remainingSeconds / 60)} min left`}
    </span>
  );
}
