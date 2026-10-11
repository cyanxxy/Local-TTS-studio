interface ReaderDesktopModelAlertProps {
  title: string;
  message: string;
  actionLabel: string;
  onAction: () => void;
}

/** Inline recovery card for a desktop runtime that failed or needs setup. */
export function ReaderDesktopModelAlert({ title, message, actionLabel, onAction }: ReaderDesktopModelAlertProps) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-danger/20 bg-danger/[0.06] px-4 py-3 sm:flex-row sm:items-center sm:justify-between" role="status">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-text-primary">{title}</p>
        <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-text-secondary">{message}</p>
      </div>
      <button
        type="button"
        onClick={onAction}
        className="shrink-0 rounded-xl border border-border bg-text-primary/[0.04] px-3 py-2 text-sm font-semibold text-text-primary transition-all hover:bg-text-primary/[0.07] active:scale-[0.98]"
      >
        {actionLabel}
      </button>
    </div>
  );
}
