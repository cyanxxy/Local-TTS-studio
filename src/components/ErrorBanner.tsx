import { useState } from "react";
import { X } from "lucide-react";

interface ErrorBannerProps {
  error: string | null;
}

/** The app-wide error line. Dismissing hides that message; a new, different one shows again. */
export function ErrorBanner({ error }: ErrorBannerProps) {
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  if (!error || error === dismissedError) return null;

  return (
    <div
      role="alert"
      className="mb-4 flex items-start gap-3 rounded-xl border border-danger/30 bg-danger-light px-3.5 py-2.5 text-xs text-danger shadow-glass-sm"
    >
      <p className="min-w-0 flex-1 break-words">{error}</p>
      <button
        type="button"
        onClick={() => setDismissedError(error)}
        aria-label="Dismiss error"
        className="-my-1 -mr-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-danger/80 transition-colors hover:bg-danger/10 hover:text-danger"
      >
        <X size={13} />
      </button>
    </div>
  );
}
