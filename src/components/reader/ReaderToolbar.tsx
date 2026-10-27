import type { ReactNode } from "react";
import { Library } from "lucide-react";

interface ReaderToolbarProps {
  title: string;
  subtitle: string;
  documentCount: number;
  onOpenLibrary: () => void;
  /** Icon tools, grouped in one glass capsule. */
  children: ReactNode;
  /** The voice button, which carries text and so sits in a container of its own. */
  voiceMenu: ReactNode;
}

/**
 * The Reader's header. No bar slab behind the controls: Apple's toolbars
 * express hierarchy by grouping, so the tools float as glass capsules beside
 * the title. `relative z-30` lifts its stacking context above the document
 * panel so a popover never paints behind the reader overlay.
 */
export function ReaderToolbar({
  title,
  subtitle,
  documentCount,
  onOpenLibrary,
  children,
  voiceMenu,
}: ReaderToolbarProps) {
  return (
    <div className="relative z-30 flex flex-wrap items-center justify-between gap-2 sm:gap-3">
      {/* The library drawer opens from the left edge, so the button that
          opens it sits on the left too, beside the book it replaces. */}
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <button
          type="button"
          onClick={onOpenLibrary}
          aria-label="Open Reader library"
          title="Library"
          className="glass-control relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-text-secondary"
        >
          <Library size={16} />
          <span className="absolute -top-1 -right-1 min-w-4 rounded-full bg-accent-fill px-1 text-center font-mono text-2xs leading-4 text-white">
            {documentCount}
          </span>
        </button>
        <div className="min-w-0">
          <h2 className="truncate font-display text-xl leading-tight font-semibold text-text-primary">
            {title}
          </h2>
          {/* Generation status lives in the player dock; the header only
              identifies the book so long titles keep their room. */}
          <p className="mt-0.5 truncate font-mono text-xs tabular-nums text-text-muted">{subtitle}</p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <div className="glass flex items-center gap-0.5 rounded-full p-1">{children}</div>
        {voiceMenu}
      </div>
    </div>
  );
}
