import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/** What a generate request needs to know about a background render holding the engine. */
export interface LookaheadControls {
  /** Soft-aborts the render. */
  preempt: () => void;
  /** A render is running or still winding down. */
  isBusy: () => boolean;
  /** Resolves once the render has fully wound down. */
  settled: () => Promise<void>;
}

interface Options {
  controls: RefObject<LookaheadControls>;
  /** The engine can start its own generation (false while a background render holds it). */
  canGenerate: boolean;
  startGenerate: () => void;
  /** A request pending for one section is dropped when this changes (another section or book). */
  scopeKey: string | null;
}

/**
 * Starts the Reader's own generation, yielding the engine first when a
 * background render holds it. The engine refuses its own generation while such
 * a render runs, so a request made then would be dropped; instead the render
 * is aborted and the generation starts once it has wound down and the engine
 * reports it can generate. That does not depend on `canGenerate` changing: a
 * render still in its cache check or cooldown never held the engine at all.
 */
export function useGenerateAfterLookahead({ controls, canGenerate, startGenerate, scopeKey }: Options) {
  const pendingRef = useRef(false);
  // Bumped when the aborted render has wound down, to run the effect below.
  const [windDowns, setWindDowns] = useState(0);

  const requestGenerate = useCallback(() => {
    const current = controls.current;
    if (!current.isBusy()) {
      startGenerate();
      return;
    }
    current.preempt();
    pendingRef.current = true;
    void current.settled().then(() => setWindDowns((count) => count + 1));
  }, [controls, startGenerate]);

  const cancelPending = useCallback(() => {
    pendingRef.current = false;
  }, []);

  useEffect(() => {
    pendingRef.current = false;
  }, [scopeKey]);

  useEffect(() => {
    if (!pendingRef.current || !canGenerate || controls.current.isBusy()) return;
    pendingRef.current = false;
    startGenerate();
  }, [canGenerate, controls, startGenerate, windDowns]);

  return { requestGenerate, cancelPending };
}
