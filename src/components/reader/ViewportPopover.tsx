import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "./useFocusTrap";

interface ViewportPopoverProps {
  anchorRef: RefObject<HTMLElement | null>;
  popoverRef: RefObject<HTMLDivElement | null>;
  maxWidth: number;
  className: string;
  ariaLabel: string;
  onClose: () => void;
  /**
   * Pointer presses inside elements matching this selector do not dismiss the
   * popover — for menus a child control portals elsewhere in the document.
   */
  keepOpenWithin?: string;
  children: ReactNode;
}

interface PopoverPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

/**
 * A modal popover pinned to its anchor inside the visual viewport. It portals
 * to the body so scrollable ancestors cannot clip it, flips above the anchor
 * when there is no room below, traps focus while open, and closes on Escape or
 * on a press outside both itself and its anchor.
 */
export function ViewportPopover({
  anchorRef,
  popoverRef,
  maxWidth,
  className,
  ariaLabel,
  onClose,
  keepOpenWithin,
  children,
}: ViewportPopoverProps) {
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const ready = position !== null;
  const close = useEffectEvent(() => onClose());

  useLayoutEffect(() => {
    const updatePosition = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;

      const rect = anchor.getBoundingClientRect();
      const viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const viewportRight = viewportLeft + viewportWidth;
      const viewportBottom = viewportTop + viewportHeight;
      const gutter = 12;
      const gap = 8;
      const width = Math.min(maxWidth, Math.max(0, viewportWidth - gutter * 2));
      const left = Math.min(
        Math.max(rect.right - width, viewportLeft + gutter),
        viewportRight - width - gutter,
      );
      const availableBelow = viewportBottom - rect.bottom - gap - gutter;
      const availableAbove = rect.top - viewportTop - gap - gutter;
      const openAbove = availableBelow < 220 && availableAbove > availableBelow;
      const maxHeight = Math.max(96, Math.min(672, openAbove ? availableAbove : availableBelow));
      const top = openAbove
        ? Math.max(viewportTop + gutter, rect.top - gap - maxHeight)
        : rect.bottom + gap;

      // The capture-phase scroll listener fires for every reader auto-follow
      // step, several times a second; handing back the same object keeps an open
      // popover from re-rendering when nothing about its geometry moved.
      setPosition((previous) => (
        previous
        && previous.top === top
        && previous.left === left
        && previous.width === width
        && previous.maxHeight === maxHeight
          ? previous
          : { top, left, width, maxHeight }
      ));
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    window.visualViewport?.addEventListener("resize", updatePosition);
    window.visualViewport?.addEventListener("scroll", updatePosition);

    // Content can change height after the geometry is computed — the settings
    // popover on a model switch, the URL popover when an import error appears —
    // and the open-above decision has to be redone when it does.
    const observer = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(updatePosition)
      : null;
    if (observer) {
      if (popoverRef.current) observer.observe(popoverRef.current);
      if (anchorRef.current) observer.observe(anchorRef.current);
    }

    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      window.visualViewport?.removeEventListener("resize", updatePosition);
      window.visualViewport?.removeEventListener("scroll", updatePosition);
      observer?.disconnect();
    };
    // `ready` re-runs this once the popover element exists, so it can be observed.
  }, [anchorRef, maxWidth, popoverRef, ready]);

  useFocusTrap(popoverRef, { active: ready, onEscape: onClose, returnFocusRef: anchorRef });

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      // The anchor toggles the popover itself; closing here as well would
      // reopen it on the click that follows this press.
      if (popoverRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      if (keepOpenWithin && target instanceof Element && target.closest(keepOpenWithin)) return;
      close();
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [anchorRef, keepOpenWithin, popoverRef]);

  if (!position) return null;

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      tabIndex={-1}
      className={`fixed z-[120] overflow-y-auto ${className}`}
      style={position}
    >
      {children}
    </div>,
    document.body,
  );
}
