import type { LocalTtsProbeResult } from "../../electron";

interface LocalRuntimeRuntimeSettingsProps {
  onRecheckRuntime: () => void;
  runtime: LocalTtsProbeResult | null;
  runtimeBusy: boolean;
}

export function LocalRuntimeRuntimeSettings({
  onRecheckRuntime,
  runtime,
  runtimeBusy,
}: LocalRuntimeRuntimeSettingsProps) {
  return (
    <section className="rounded-xl border border-black/10 bg-surface/55 backdrop-blur-md p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Rust Runtime</h3>
          <p className="mt-1 text-sm text-text-muted">Local bridge and model execution are Rust-only.</p>
        </div>
        <button
          type="button"
          onClick={onRecheckRuntime}
          disabled={runtimeBusy}
          className={`
            rounded-md border px-3 py-2 text-xs font-semibold transition-colors
            ${runtimeBusy
              ? "cursor-not-allowed border-border text-text-muted"
              : "border-white/55 bg-white/40 backdrop-blur-md text-text-primary hover:bg-white/60"
            }
          `}
        >
          {runtimeBusy ? "Checking…" : "Re-check Runtime"}
        </button>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-2 text-sm text-text-secondary md:grid-cols-2">
        <p>Runtime: {runtime?.runtime ?? "-"}</p>
        <p>Package: {runtime?.package ?? "-"}</p>
        <p>Package version: {runtime?.packageVersion ?? "-"}</p>
        {runtime?.recommendedModelRepo && <p className="break-all">Recommended model: {runtime.recommendedModelRepo}</p>}
        {runtime?.recommendedBaseModelRepo && <p className="break-all">Recommended Base model: {runtime.recommendedBaseModelRepo}</p>}
        {runtime?.recommendedDeviceMap && <p>Recommended device: {runtime.recommendedDeviceMap}</p>}
        {runtime?.recommendedDtype && <p>Recommended dtype: {runtime.recommendedDtype}</p>}
        {runtime?.recommendedAttention && <p>Recommended attention: {runtime.recommendedAttention}</p>}
      </div>

      {runtime?.warnings?.length ? (
        <div className="mt-3 space-y-1 text-sm text-warning">
          {runtime.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      ) : null}
    </section>
  );
}
