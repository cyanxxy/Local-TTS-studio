import { useEffect, useEffectEvent, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Keyboard-reachable controls inside `container`, in DOM order. */
export function focusableWithin(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter((element) => !element.hasAttribute("disabled"));
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
 * to its origin when the surface closes.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  { active, onEscape, autoFocus = true, returnFocusRef }: FocusTrapOptions,
): void {
  const escape = useEffectEvent(() => onEscape());

  useEffect(() => {
    if (!active) return;
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const returnTarget = returnFocusRef?.current ?? origin;
    const frame = autoFocus
      ? window.requestAnimationFrame(() => {
          const container = containerRef.current;
          if (container) (focusableWithin(container)[0] ?? container).focus();
        })
      : null;

    const handleKeyDown = (event: KeyboardEvent) => {
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
      const escaped = !container.contains(current);
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
      if (returnTarget?.isConnected) returnTarget.focus();
    };
  }, [active, autoFocus, containerRef, returnFocusRef]);
}
