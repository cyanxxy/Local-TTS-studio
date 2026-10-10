import { useEffect, useEffectEvent, type RefObject } from "react";
import type { ReaderSection } from "../../lib/readerDocument";

interface UseReaderKeyboardOptions {
  editing: boolean;
  /** The reading pane; page turns only fire while it (or nothing) has focus. */
  scrollerRef: RefObject<HTMLElement | null>;
  previousSection: ReaderSection | null;
  nextSection: ReaderSection | null;
  onJumpToOffset: (offset: number) => void;
  onToggleShortcuts: () => void;
  immersive: boolean;
  onImmersiveChange?: (immersive: boolean) => void;
}

function isTextEntry(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && target.closest("input, textarea, select, [contenteditable='true']") !== null;
}

function isInDialog(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest("[role='dialog']") !== null;
}

/**
 * Reader-level keys. Arrow keys page through reading sections while the
 * reader itself has focus — the book-reader equivalent of turning pages —
 * "?" lists the shortcuts and "F" toggles the focus layout. Playback keys
 * (Space, ⌥←/⌥→) and generation shortcuts belong to the app shell.
 */
export function useReaderKeyboard({
  editing,
  scrollerRef,
  previousSection,
  nextSection,
  onJumpToOffset,
  onToggleShortcuts,
  immersive,
  onImmersiveChange,
}: UseReaderKeyboardOptions): void {
  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (isTextEntry(target)) return;

    if (event.key === "?") {
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

    if (event.shiftKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    // Each page turn flushes, saves, and re-sections upstream, so a held key
    // must not fire one per repeat.
    if (event.repeat || editing || isInDialog(target)) return;
    // Toolbar buttons keep focus after use; paging from there is surprising.
    // Only the unfocused page and the reading pane itself turn pages.
    const inReader = target === document.body
      || (target instanceof Node && !!scrollerRef.current?.contains(target));
    if (!inReader) return;
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
