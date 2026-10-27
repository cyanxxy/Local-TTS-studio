import { useLayoutEffect, type RefObject } from "react";

/** The CSS custom property the floating dock's height is published under. */
export const DOCK_CLEARANCE_PROPERTY = "--reader-dock-clearance";

/**
 * Publishes how much of the bottom of the viewport the floating player dock
 * covers (its height plus its offset from the bottom edge) as
 * `--reader-dock-clearance` on `targetRef`, so controls that must stay
 * clickable, like the Resume auto-follow pill, can sit just above it. The dock
 * is the first element inside `dockHostRef`.
 *
 * The value goes straight onto the element's style rather than into React
 * state: the dock changes height as its status line and step controls come
 * and go, and the page has no reason to re-render when it does.
 */
export function useDockClearance(
  targetRef: RefObject<HTMLElement | null>,
  dockHostRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): void {
  useLayoutEffect(() => {
    const target = targetRef.current;
    const dock = dockHostRef.current?.firstElementChild;
    if (!enabled || !target || !(dock instanceof HTMLElement)) return;

    const update = () => {
      // A fixed element's `bottom` is measured from the layout viewport.
      const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
      const clearance = Math.max(0, viewportHeight - dock.getBoundingClientRect().top);
      target.style.setProperty(DOCK_CLEARANCE_PROPERTY, `${Math.round(clearance)}px`);
    };

    update();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    observer?.observe(dock);
    // The dock's bottom offset follows a breakpoint, which only a window
    // resize reveals.
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
      target.style.removeProperty(DOCK_CLEARANCE_PROPERTY);
    };
  }, [dockHostRef, enabled, targetRef]);
}
