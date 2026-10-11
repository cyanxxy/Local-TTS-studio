interface AppFooterProps {
  /** The runtimes this build ships. Null shows `note` instead of badges. */
  runtimeBadges: readonly string[] | null;
  note: string;
}

export function AppFooter({ runtimeBadges, note }: AppFooterProps) {
  return (
    <footer className="mt-16 border-t border-border/40 pt-5">
      {runtimeBadges ? (
        <div className="flex items-center flex-wrap gap-1.5">
          {runtimeBadges.map((label) => (
            <span
              key={label}
              className="px-2.5 py-1 rounded-full border border-border bg-text-primary/[0.04] font-mono text-xs text-text-muted/70"
            >
              {label}
            </span>
          ))}
          <span className="flex items-center gap-1.5 rounded-full border border-success/25 bg-success/[0.07] px-2.5 py-1 font-mono text-xs text-success/80">
            <span
              className="h-1 w-1 animate-pulse rounded-full bg-success opacity-80"
              style={{ boxShadow: "0 0 5px var(--color-success)" }}
            />
            all local
          </span>
        </div>
      ) : (
        <p className="font-mono text-xs text-text-muted/60">{note}</p>
      )}
    </footer>
  );
}
