import { useEffect, useEffectEvent, type RefObject } from "react";
import type { ReaderSection } from "../../lib/readerDocument";
import type { ReaderStepDirection, ReaderStepUnit } from "./readerNavigation";
import { READER_SHORTCUTS_DIALOG_ATTRIBUTE } from "./readerShortcuts";

interface UseReaderKeyboardOptions {
  editing: boolean;
  /** The reading pane; page turns only fire while it (or nothing) has focus. */
  scrollerRef: RefObject<HTMLElement | null>;
  previousSection: ReaderSection | null;
  nextSection: ReaderSection | null;
  onJumpToOffset: (offset: number) => void;
  /** Steps to the previous or next sentence or paragraph. */
  onStep: (unit: ReaderStepUnit, direction: ReaderStepDirection) => void;
  onToggleShortcuts: () => void;
  immersive: boolean;
  onImmersiveChange?: (immersive: boolean) => void;
}

function isTextEntry(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && target.closest("input, textarea, select, [contenteditable='true']") !== null;
}

function dialogOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof HTMLElement ? target.closest<HTMLElement>("[role='dialog']") : null;
}

function isInDialog(target: EventTarget | null): boolean {
  return dialogOf(target) !== null;
}

/** A selection in the reading pane, which Shift+arrow keys extend instead of stepping. */
function hasSelectionIn(root: HTMLElement | null): boolean {
  const selection = window.getSelection();
  return !!root && !!selection && !selection.isCollapsed && selection.rangeCount > 0
    && root.contains(selection.getRangeAt(0).commonAncestorContainer);
}

const STEP_KEYS: Readonly<Record<string, [ReaderStepUnit, ReaderStepDirection]>> = {
  ArrowLeft: ["sentence", "previous"],
  ArrowRight: ["sentence", "next"],
  ArrowUp: ["paragraph", "previous"],
  ArrowDown: ["paragraph", "next"],
};

/**
 * Reader-level keys. Arrow keys page through reading sections while the
 * reader itself has focus — the book-reader equivalent of turning pages —
 * Shift+←/→ step by sentence and Shift+↑/↓ by paragraph, "?" lists the
 * shortcuts and "F" toggles the focus layout. Playback keys
 * (Space, ⌥←/⌥→) and generation shortcuts belong to the app shell.
 */
export function useReaderKeyboard({
  editing,
  scrollerRef,
  previousSection,
  nextSection,
  onJumpToOffset,
  onStep,
  onToggleShortcuts,
  immersive,
  onImmersiveChange,
}: UseReaderKeyboardOptions): void {
  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (isTextEntry(target)) return;

    if (event.key === "?") {
      // Another dialog owns the keyboard; only the shortcut list itself toggles.
      const dialog = dialogOf(target);
      if (dialog && !dialog.hasAttribute(READER_SHORTCUTS_DIALOG_ATTRIBUTE)) return;
      event.preventDefault();
      onToggleShortcuts();
      return;
    }
    if ((event.key === "f" || event.key === "F") && !event.shiftKey) {
      if (!onImmersiveChange || isInDialog(target)) return;
      event.preventDefault();
      onImmersiveChange(!immersive);
      return;
    }

    const step = event.shiftKey ? STEP_KEYS[event.key] : undefined;
    if (!step && (event.shiftKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight"))) return;
    // Each page turn flushes, saves, and re-sections upstream, and each step
    // reschedules playback, so a held key must not fire one per repeat.
    if (event.repeat || editing || isInDialog(target)) return;
    // Toolbar buttons keep focus after use; paging from there is surprising.
    // Only the unfocused page and the reading pane itself turn pages.
    const inReader = target === document.body
      || (target instanceof Node && !!scrollerRef.current?.contains(target));
    if (!inReader) return;
    if (step) {
      if (hasSelectionIn(scrollerRef.current)) return;
      event.preventDefault();
      onStep(...step);
      return;
    }
    const section = event.key === "ArrowRight" ? nextSection : previousSection;
    if (!section) return;
    event.preventDefault();
    onJumpToOffset(section.start);
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => handleKeyDown(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);
}
