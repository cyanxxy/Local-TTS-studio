import { useCallback, useEffect, useRef, type RefObject } from "react";

/** What a generate request needs to know about a background render holding the engine. */
export interface LookaheadControls {
  /** Soft-aborts the render. */
  preempt: () => void;
  /** A render is running or still winding down. */
  isBusy: () => boolean;
}

interface Options {
  controls: RefObject<LookaheadControls>;
  /** The engine can start its own generation (false while a background render holds it). */
  canGenerate: boolean;
  startGenerate: () => void;
}

/**
 * Starts the Reader's own generation, yielding the engine first when a
 * background render holds it. The engine refuses its own generation while such
 * a render runs, so a request made then would be dropped; instead the render
 * is aborted and the generation starts the moment the engine frees up.
 */
export function useGenerateAfterLookahead({ controls, canGenerate, startGenerate }: Options) {
  const pendingRef = useRef(false);

  const requestGenerate = useCallback(() => {
    const current = controls.current;
    if (current.isBusy()) {
      current.preempt();
      pendingRef.current = true;
      return;
    }
    startGenerate();
  }, [controls, startGenerate]);

  const cancelPending = useCallback(() => {
    pendingRef.current = false;
  }, []);

  useEffect(() => {
    if (!pendingRef.current || !canGenerate || controls.current.isBusy()) return;
    pendingRef.current = false;
    startGenerate();
  }, [canGenerate, controls, startGenerate]);

  return { requestGenerate, cancelPending };
}
