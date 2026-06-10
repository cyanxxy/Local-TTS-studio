import type { ModelState } from "../types";
import { MODELS } from "../constants";

interface DownloadProgressProps {
  kokoroState: ModelState;
  supertonicState: ModelState;
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

export function DownloadProgress({ kokoroState, supertonicState }: DownloadProgressProps) {
  const showKokoro = kokoroState.loading || (!!kokoroState.error && !kokoroState.ready);
  const showSupertonic = supertonicState.loading || (!!supertonicState.error && !supertonicState.ready);
  if (!showKokoro && !showSupertonic) return null;

  return (
    <div className="px-5 py-4 rounded-[22px] glass-panel flex flex-col gap-4 animate-fade-up">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-widest text-text-muted">
          Preparing Model
        </span>
        <span className="text-xs text-text-muted">Downloads once</span>
      </div>
      {showKokoro && (
        <ProgressBar name={MODELS.kokoro.label} state={kokoroState} />
      )}
      {showSupertonic && (
        <ProgressBar name={MODELS.supertonic.label} state={supertonicState} />
      )}
    </div>
  );
}
