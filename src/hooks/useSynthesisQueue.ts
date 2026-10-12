import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { SynthesisChunk } from "../shared/engineRuntime";
import { SynthesisQueue } from "../shared/synthesisQueue";

export interface UseSynthesisQueueReturn {
  queue: SynthesisQueue<SynthesisChunk>;
  /** A synthesize request is running: the engine's own generation must not start. */
  busy: boolean;
  /**
   * Call right before starting the engine's own generation. It holds queued
   * requests at once, before the generating state has rendered, and the hold
   * then follows `foregroundBusy` again, including when nothing started.
   */
  holdForeground: () => void;
}

/**
 * One engine's synthesize queue, kept out of the way of the generation the
 * engine runs for its surface (`foregroundBusy`). Every request still pending
 * when the engine unmounts is aborted.
 */
export function useSynthesisQueue(foregroundBusy: boolean): UseSynthesisQueueReturn {
  const [queue] = useState(() => new SynthesisQueue<SynthesisChunk>());
  const busy = useSyncExternalStore(queue.subscribe, queue.getBusy, queue.getBusy);
  const [holdRevision, setHoldRevision] = useState(0);

  useEffect(() => {
    queue.setForegroundBusy(foregroundBusy);
  }, [foregroundBusy, holdRevision, queue]);

  useEffect(() => () => queue.abortAll(), [queue]);

  const holdForeground = useCallback(() => {
    queue.setForegroundBusy(true);
    setHoldRevision((revision) => revision + 1);
  }, [queue]);

  return { queue, busy, holdForeground };
}
