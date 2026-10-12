interface BrowserSupportPanelProps {
  message: string;
}

/** Explains which models a browser with limited local inference (iOS) can run. */
export function BrowserSupportPanel({ message }: BrowserSupportPanelProps) {
  return (
    <div className="rounded-[22px] border border-accent/20 bg-accent-light/50 backdrop-blur-xl shadow-glass-md">
      <div className="p-4 sm:p-6 md:p-8">
        <div className="inline-flex items-center rounded-full border border-accent/20 bg-panel/80 px-3 py-1 text-sm font-semibold text-accent shadow-glass-sm">
          iOS rollout
        </div>
        <h2 className="mt-4 text-2xl font-display font-bold tracking-tight text-text-primary sm:text-3xl">
          Open TTS runs on iPhone and iPad browsers with a limited set of models
        </h2>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-text-secondary">
          {message}
        </p>
      </div>
    </div>
  );
}
