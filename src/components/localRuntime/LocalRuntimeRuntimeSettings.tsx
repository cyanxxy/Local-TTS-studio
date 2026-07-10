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
        <h3 className="text-xs font-semibold uppercase tracking-widest text-text-secondary">Runtime</h3>
        <button
          type="button"
          onClick={onRecheckRuntime}
          disabled={runtimeBusy}
          className={`
            rounded-lg border px-3 py-2 text-xs font-semibold transition-colors
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
        {runtime?.runtime && <p>Runtime: {runtime.runtime}</p>}
        {runtime?.package && <p>Package: {runtime.package}</p>}
        {runtime?.packageVersion && <p>Package version: {runtime.packageVersion}</p>}
        {runtime?.provider && <p>Provider: {runtime.provider}</p>}
        {runtime?.upstreamRevision && <p className="break-all">Runtime revision: {runtime.upstreamRevision}</p>}
        {runtime?.recommendedModelRepo && <p className="break-all">Recommended model: {runtime.recommendedModelRepo}</p>}
        {runtime?.recommendedBaseModelRepo && <p className="break-all">Recommended Base model: {runtime.recommendedBaseModelRepo}</p>}
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
