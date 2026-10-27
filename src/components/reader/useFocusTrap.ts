import { useEffect, useEffectEvent, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "[href]",
  "[tabindex]:not([tabindex='-1'])",
  // A disclosure's summary is a tab stop; leaving it out made the controls
  // after the last counted one (an "Advanced" toggle at the end) unreachable.
  "details > summary",
].join(",");

/**
 * Active traps, innermost last. Every trap listens on the document, so only
 * the innermost one handles a key: one Escape closes one surface, and Tab
 * cycles only inside the surface on top.
 */
const activeTraps: symbol[] = [];
/** The container each active trap guards, for `isTopFocusTrap`. */
const trapContainers = new Map<symbol, RefObject<HTMLElement | null>>();

/**
 * Whether `element` cannot take focus because it is not rendered: inside a
 * `hidden` or `inert` subtree, inside a closed `<details>` (other than its
 * summary), or not displayed at all. Counting such controls made Tab from the
 * last visible control land on an invisible one and the cycle stall.
 */
function isHidden(element: HTMLElement): boolean {
  if (element.closest("[hidden], [inert]")) return true;
  for (
    let details = element.closest("details:not([open])");
    details;
    details = details.parentElement?.closest("details:not([open])") ?? null
  ) {
    const summary = details.querySelector(":scope > summary");
    if (!summary?.contains(element)) return true;
  }
  // jsdom has no layout, so the structural checks above are what tests see;
  // browsers also catch `display: none` and content-visibility here.
  return typeof element.checkVisibility === "function" && !element.checkVisibility();
}

/** Keyboard-reachable controls inside `container`, in DOM order. */
export function focusableWithin(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter((element) => !element.hasAttribute("disabled") && !isHidden(element));
}

/**
 * Whether the trap that `container` belongs to is the innermost active one —
 * or no trap is active at all. Surfaces use it to ignore outside presses that
 * land on a surface stacked above them.
 */
export function isTopFocusTrap(container: HTMLElement | null): boolean {
  const top = activeTraps.at(-1);
  return top === undefined || (container !== null && trapContainers.get(top)?.current === container);
}

interface FocusTrapOptions {
  /** The trap listens only while active, e.g. once a popover has been positioned. */
  active: boolean;
  onEscape: () => void;
  /**
   * Move focus to the first control (or the container itself) on activation.
   * Off for surfaces that choose their own initial focus.
   */
  autoFocus?: boolean;
  /** Where focus returns when the trap deactivates; defaults to wherever it was on activation. */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * Modal focus handling shared by the Reader's popovers, dialogs and library
 * drawer: Escape dismisses, Tab and Shift+Tab cycle inside the container (and
 * pull focus back in when it has escaped to the page behind), and focus returns
 * to its origin when the surface closes. When surfaces stack, only the one on
 * top responds.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  { active, onEscape, autoFocus = true, returnFocusRef }: FocusTrapOptions,
): void {
  const escape = useEffectEvent(() => onEscape());

  useEffect(() => {
    if (!active) return;
    const trap = Symbol("focus-trap");
    activeTraps.push(trap);
    trapContainers.set(trap, containerRef);
    // Every surface renders its container in the commit that activates it.
    const surface = containerRef.current;
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const returnTarget = returnFocusRef?.current ?? origin;
    const frame = autoFocus
      ? window.requestAnimationFrame(() => {
          const container = containerRef.current;
          if (container) (focusableWithin(container)[0] ?? container).focus();
        })
      : null;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (activeTraps.at(-1) !== trap) return;
      // A control inside the surface that already consumed Escape (a
      // dropdown closing itself) has dismissed the topmost thing on screen.
      if (event.key === "Escape" && event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        escape();
        return;
      }
      const container = containerRef.current;
      if (event.key !== "Tab" || !container) return;
      const focusable = focusableWithin(container);
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement;
      // The container itself (focused on open) counts as outside the cycle,
      // so Shift+Tab from it wraps to the last control instead of leaving.
      const escaped = current === container || !container.contains(current);
      if (event.shiftKey && (current === first || escaped)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || escaped)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      activeTraps.splice(activeTraps.indexOf(trap), 1);
      trapContainers.delete(trap);
      // Hand focus back only if it is still ours to give: in the surface, or
      // dropped to the body because the surface unmounted. A surface closing
      // underneath another one (a Reader popover beneath Settings) must not
      // pull focus out of the one on top.
      const current = document.activeElement;
      const focusIsOurs = current === null
        || current === document.body
        || Boolean(surface?.contains(current));
      if (focusIsOurs && returnTarget?.isConnected) returnTarget.focus();
    };
  }, [active, autoFocus, containerRef, returnFocusRef]);
}
