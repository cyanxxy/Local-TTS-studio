import { useEffect, useId, useRef, useState } from "react";
import { Timer } from "lucide-react";
import { BREAK_PRESETS_SEC, MIN_BREAK_SEC, formatBreakTag } from "../../lib/creator/breakInsert";
import { MAX_BREAK_SEC } from "../../lib/text/speechMarkup";

interface BreakInsertMenuProps {
  /** Puts a pause of this many seconds at the script's caret. */
  onInsert: (seconds: number) => void;
}

function formatSeconds(seconds: number): string {
  return seconds < 1 ? `${Math.round(seconds * 1000)} ms` : `${seconds} s`;
}

/** A small menu that inserts an inline `<break/>` pause at the script's caret. */
export function BreakInsertMenu({ onInsert }: BreakInsertMenuProps) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("1.5");
  const rootRef = useRef<HTMLDivElement>(null);
  const customId = useId();

  useEffect(() => {
    if (!open) return;
    const handlePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const insert = (seconds: number) => {
    setOpen(false);
    onInsert(seconds);
  };
  const customSeconds = Number(custom);
  const customValid = custom.trim() !== "" && Number.isFinite(customSeconds)
    && customSeconds >= MIN_BREAK_SEC && customSeconds <= MAX_BREAK_SEC;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        title="Insert a pause at the cursor"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 rounded-lg border border-border bg-text-primary/[0.04] px-2.5 py-1.5 text-sm text-text-secondary transition-all duration-200 hover:bg-text-primary/[0.07] hover:text-text-primary active:scale-[0.98]"
      >
        <Timer size={12} aria-hidden="true" />
        Pause
      </button>
      {open && (
        <div
          role="group"
          aria-label="Insert a pause"
          className="glass-pop absolute bottom-full left-0 z-10 mb-2 w-64 rounded-2xl p-3"
        >
          <p className="text-xs text-text-muted">
            Inserts <code className="font-mono">{formatBreakTag(1)}</code> at the cursor. Pauses are silent and never spoken.
          </p>
          <div className="mt-2 grid grid-cols-4 gap-1.5">
            {BREAK_PRESETS_SEC.map((seconds) => (
              <button
                key={seconds}
                type="button"
                onClick={() => insert(seconds)}
                className="rounded-lg border border-border bg-text-primary/[0.04] px-1.5 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-text-primary/[0.07] hover:text-text-primary"
              >
                {formatSeconds(seconds)}
              </button>
            ))}
          </div>
          <form
            className="mt-3 flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (customValid) insert(customSeconds);
            }}
          >
            <div className="flex-1">
              <label htmlFor={customId} className="text-xs font-medium text-text-secondary">
                Custom (seconds)
              </label>
              <input
                id={customId}
                type="number"
                inputMode="decimal"
                min={MIN_BREAK_SEC}
                max={MAX_BREAK_SEC}
                step={0.1}
                value={custom}
                aria-invalid={!customValid}
                onChange={(event) => setCustom(event.target.value)}
                className="mt-1 w-full rounded-lg border border-black/10 bg-text-primary/[0.06] px-2.5 py-1.5 text-sm text-text-primary"
              />
            </div>
            <button
              type="submit"
              disabled={!customValid}
              className="rounded-lg glass-accent px-3 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              Insert
            </button>
          </form>
          {!customValid && (
            <p className="mt-1 text-xs text-danger" role="status">
              Use {MIN_BREAK_SEC} to {MAX_BREAK_SEC} seconds.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
