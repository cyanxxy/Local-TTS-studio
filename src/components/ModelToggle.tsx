import type { ModelType, ModelState } from "../types";
import { MODELS } from "../constants";

interface ModelToggleProps {
  activeModel: ModelType;
  onModelChange: (model: ModelType) => void;
  kokoroState: ModelState;
  supertonicState: ModelState;
  unavailableModels?: Partial<Record<ModelType, string>>;
  desktopModelOptions?: ModelToggleDesktopOption[];
}

export interface ModelToggleDesktopOption {
  key: string;
  label: string;
  badge?: string;
  detail?: string;
  selected?: boolean;
  onSelect: () => void;
}

const MODEL_PARAMS: Record<ModelType, string> = {
  kokoro:     "82M",
  supertonic: "300M",
};

function StatusDot({ state, unavailable = false }: { state: ModelState; unavailable?: boolean }) {
  if (unavailable) {
    return <span className="w-1.5 h-1.5 rounded-full bg-text-muted/50 flex-shrink-0" />;
  }
  if (state.ready) {
    return <span className="w-1.5 h-1.5 rounded-full bg-success flex-shrink-0" style={{ boxShadow: "0 0 6px color-mix(in srgb, var(--color-success) 60%, transparent)" }} />;
  }
  if (state.error) {
    return <span className="w-1.5 h-1.5 rounded-full bg-danger flex-shrink-0" />;
  }
  return (
    <span className="relative flex-shrink-0 w-1.5 h-1.5">
      <span className="absolute inset-0 rounded-full bg-text-muted animate-ping-ring" />
      <span className="relative block w-1.5 h-1.5 rounded-full bg-text-muted" />
    </span>
  );
}
export function ModelToggle({
  activeModel,
  onModelChange,
  kokoroState,
  supertonicState,
  unavailableModels,
  desktopModelOptions = [],
}: ModelToggleProps) {
  const models: { key: ModelType; label: string; state: ModelState }[] = [
    { key: "kokoro",     label: MODELS.kokoro.label,     state: kokoroState },
    { key: "supertonic", label: MODELS.supertonic.label, state: supertonicState },
  ];
  const hasSelectedDesktopModel = desktopModelOptions.some((option) => option.selected);

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold uppercase tracking-widest text-text-muted">
        Model
      </span>
      <div className={`grid grid-cols-1 gap-1.5 ${desktopModelOptions.length > 0 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
        {models.map(({ key, label, state }) => {
          const isActive = !hasSelectedDesktopModel && activeModel === key;
          const unavailableReason = unavailableModels?.[key];
          const isUnavailable = typeof unavailableReason === "string";
          return (
            <button
              key={key}
              type="button"
              onClick={() => onModelChange(key)}
              disabled={isUnavailable}
              aria-pressed={isActive}
              title={unavailableReason}
              className={`
                flex min-w-0 items-start justify-between gap-3 rounded-2xl border px-3 py-2.5 text-left text-lg font-semibold backdrop-blur-md transition-all duration-200 sm:items-center
                ${isUnavailable
                  ? "border-border bg-surface/40 text-text-muted cursor-not-allowed opacity-70"
                  : isActive
                  ? "border-accent/40 bg-accent/[0.10] text-accent shadow-accent-sm ring-1 ring-accent/15"
                  : "border-white/50 bg-white/35 text-text-muted shadow-glass-sm hover:-translate-y-0.5 hover:bg-white/55 hover:text-text-primary"
                }
              `}
            >
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <span>{label}</span>
                {isUnavailable && (
                  <span className="rounded-full border border-border px-2 py-0.5 text-2xs uppercase tracking-[0.12em]">
                    unavailable
                  </span>
                )}
              </span>
              <div className="flex shrink-0 items-center gap-1.5">
                <span className="font-mono text-xs text-text-muted" title="Parameters">{MODEL_PARAMS[key]}</span>
                <StatusDot state={state} unavailable={isUnavailable} />
              </div>
            </button>
          );
        })}
        {desktopModelOptions.map((option) => {
          const isSelected = Boolean(option.selected);
          return (
            <button
              key={`desktop-${option.key}`}
              type="button"
              onClick={option.onSelect}
              aria-pressed={isSelected}
              className={`
                flex min-w-0 items-start justify-between gap-3 rounded-2xl border px-3 py-2.5 text-left text-lg font-semibold backdrop-blur-md transition-all duration-200
                ${isSelected
                  ? "border-accent/40 bg-accent/[0.10] text-accent shadow-accent-sm ring-1 ring-accent/15"
                  : "border-white/50 bg-white/35 text-text-muted shadow-glass-sm hover:-translate-y-0.5 hover:bg-white/55 hover:text-text-primary"
                }
              `}
            >
              <span className="min-w-0">
                <span className={isSelected ? "block text-accent" : "block text-text-primary"}>
                  {option.label}
                </span>
                {option.detail && (
                  <span className="mt-0.5 block text-xs font-medium leading-4 text-text-muted">
                    {option.detail}
                  </span>
                )}
              </span>
              {option.badge && (
                <span className="shrink-0 rounded-full border border-accent/25 bg-accent-light px-2 py-0.5 font-mono text-2xs uppercase tracking-[0.12em] text-accent">
                  {option.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
