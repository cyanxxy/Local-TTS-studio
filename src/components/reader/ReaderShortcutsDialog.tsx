import { useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { READER_SHORTCUTS } from "./readerShortcuts";
import { useFocusTrap } from "./useFocusTrap";

export function ReaderShortcutsDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, { active: true, onEscape: onClose });

  return createPortal(
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/25 p-4" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        className="glass-pop w-full max-w-sm rounded-2xl p-5"
      >
        <div className="mb-3 flex items-center justify-between">
          <p className="font-display text-lg font-semibold text-text-primary">Keyboard shortcuts</p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close keyboard shortcuts"
            className="flex h-8 w-8 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-text-primary/[0.07] hover:text-text-primary"
          >
            <X size={16} />
          </button>
        </div>
        <dl className="space-y-2 text-sm">
          {READER_SHORTCUTS.map((shortcut) => (
            <div key={shortcut.keys} className="flex items-center justify-between gap-4">
              <dt className="text-text-secondary">{shortcut.action}</dt>
              <dd>
                <kbd className="rounded-md border border-border bg-text-primary/[0.04] px-1.5 py-0.5 font-mono text-xs text-text-primary">
                  {shortcut.keys}
                </kbd>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>,
    document.body,
  );
}
