import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Keeps keyboard focus from falling to the page body when the focused control
 * inside `containerRef` is removed by a render: a Delete button replaced by
 * its confirmation, a wizard step's Next button unmounting as the next step
 * opens, a list row deleted from under the cursor, a button that disables
 * itself when pressed. Browsers drop focus to
 * `<body>` in that case, and a keyboard or screen-reader user has to start
 * over from the top of the page.
 *
 * After every commit, if the last focused element inside the container is no
 * longer in the document (or is now disabled) and nothing else has taken
 * focus, focus moves to
 * `fallback()` — typically the control that replaced the removed one — or,
 * when that returns nothing, to the container's first focusable control.
 */
export function useFocusRecovery(
  containerRef: RefObject<HTMLElement | null>,
  fallback?: () => HTMLElement | null | undefined,
): void {
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  const fallbackRef = useRef(fallback);

  // Declared before the recovery effect so it runs first in the same commit.
  useLayoutEffect(() => {
    fallbackRef.current = fallback;
  });

  // Listening on the document rather than the container works for containers
  // that mount after this hook does (a drawer that renders nothing while shut).
  useEffect(() => {
    const remember = (event: FocusEvent) => {
      const container = containerRef.current;
      const target = event.target;
      lastFocusedRef.current = container && target instanceof HTMLElement && container.contains(target)
        ? target
        : null;
    };
    document.addEventListener("focusin", remember);
    return () => document.removeEventListener("focusin", remember);
  }, [containerRef]);

  // No dependency list: any render can be the one that removes the control.
  useLayoutEffect(() => {
    const last = lastFocusedRef.current;
    if (!last) return;
    const removed = !last.isConnected;
    // Disabling the focused control drops focus too (Chrome blurs it): a
    // Generate button that disables itself while its run goes.
    const disabled = !removed && last.matches(":disabled");
    if (!removed && !disabled) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== last) {
      lastFocusedRef.current = null;
      return;
    }
    const preferred = fallbackRef.current?.();
    const usable = preferred && preferred !== last && !preferred.matches(":disabled") ? preferred : null;
    // A control that is only disabled for a moment (Stop while recording
    // starts) keeps its place unless the owner names where focus should go.
    if (disabled && !usable) return;
    lastFocusedRef.current = null;
    (usable ?? containerRef.current?.querySelector<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
    ))?.focus();
  });
}
