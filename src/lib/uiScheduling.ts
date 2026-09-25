const FALLBACK_FRAME_MS = 16;

export type CancelScheduledUiFlush = () => void;

function isPageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

export function scheduleNextUiFrame(callback: () => void): CancelScheduledUiFlush {
  // A hidden page gets no animation frames at all, so a flush queued on one
  // would wait until the listener comes back: the Reader's duration, passages,
  // and saved audio would all stall while audio keeps playing in the background.
  if (
    !isPageHidden()
    && typeof requestAnimationFrame === "function"
    && typeof cancelAnimationFrame === "function"
  ) {
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
