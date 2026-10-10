import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * A callback with a permanent identity that always runs the latest `handler`.
 * The Reader's parent passes several handlers as inline arrows; routing them
 * through this keeps memoised children from re-rendering on every parent
 * render. Only call the result from event handlers or effects, never during
 * render.
 */
export function useStableCallback<Args extends unknown[], Result>(
  handler: (...args: Args) => Result,
): (...args: Args) => Result {
  const handlerRef = useRef(handler);
  useLayoutEffect(() => {
    handlerRef.current = handler;
  });
  return useCallback((...args: Args) => handlerRef.current(...args), []);
}
