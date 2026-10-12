import type { ModelState } from "../types";
import { ENGINE_REGISTRY, type EngineId } from "../models/registry";

interface DownloadProgressProps {
  /** Load state of each engine that may be preparing, keyed by engine. */
  states: Partial<Record<EngineId, ModelState>>;
}

function ProgressBar({ state, name }: { state: ModelState; name: string }) {
  if (state.ready || (!state.loading && !state.error)) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-text-secondary">{name}</span>
        {state.error
          ? <span className="text-xs text-danger">Failed</span>
          : <span className="font-mono text-xs text-text-muted tabular-nums">
              {Math.round(state.downloadProgress)}%
            </span>
        }
      </div>
      {!state.error && (
        <div className="h-1 bg-border rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ease-out ${state.downloadProgress < 99 ? "progress-animated" : "bg-success"}`}
            style={{ width: state.downloadProgress <= 0 ? "0%" : `${Math.max(4, state.downloadProgress)}%` }}
          />
        </div>
      )}
    </div>
  );
}

function isPreparing(state: ModelState | undefined): state is ModelState {
  return !!state && (state.loading || (!!state.error && !state.ready));
}

export function DownloadProgress({ states }: DownloadProgressProps) {
  const preparing = ENGINE_REGISTRY.flatMap((engine) => {
    const state = states[engine.id];
    return isPreparing(state) ? [{ id: engine.id, label: engine.label, state }] : [];
  });
  if (preparing.length === 0) return null;

  return (
    <div className="px-5 py-4 rounded-[22px] surface flex flex-col gap-4 animate-fade-up">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-text-secondary">
          Preparing Model
        </span>
        <span className="text-xs text-text-muted">Downloads once</span>
      </div>
      {preparing.map(({ id, label, state }) => (
        <ProgressBar key={id} name={label} state={state} />
      ))}
    </div>
  );
}
