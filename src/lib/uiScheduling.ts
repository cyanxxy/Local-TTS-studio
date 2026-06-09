const FALLBACK_FRAME_MS = 16;

export type CancelScheduledUiFlush = () => void;

export function scheduleNextUiFrame(callback: () => void): CancelScheduledUiFlush {
  if (typeof requestAnimationFrame === "function" && typeof cancelAnimationFrame === "function") {
    let active = true;
    const frameId = requestAnimationFrame(() => {
      if (active) callback();
    });
    return () => {
      active = false;
      cancelAnimationFrame(frameId);
    };
  }

  const timeoutId = setTimeout(callback, FALLBACK_FRAME_MS);
  return () => clearTimeout(timeoutId);
}
