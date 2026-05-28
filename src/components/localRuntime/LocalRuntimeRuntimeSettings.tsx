import type { LocalTtsProbeResult } from "../../electron";

interface LocalRuntimeRuntimeSettingsProps {
  onRecheckRuntime: () => void;
  onPythonOverrideChange: (value: string) => void;
  pythonOverride: string;
  runtime: LocalTtsProbeResult | null;
  runtimeBusy: boolean;
  showCompatibility?: boolean;
  showEspeak?: boolean;
}

function getCompatibilityLabel(mode: LocalTtsProbeResult["compatibilityMode"]): string {
  if (mode === "legacy_0_1_x") return "Legacy 0.1.x";
  if (mode === "current_1_2_x_or_newer") return "Current 1.2.x+";
  return "-";
}

export function LocalRuntimeRuntimeSettings({
  onRecheckRuntime,
  onPythonOverrideChange,
  pythonOverride,
  runtime,
  runtimeBusy,
  showCompatibility = false,
  showEspeak = false,
}: LocalRuntimeRuntimeSettingsProps) {
  return (
    <section className="rounded-xl border border-black/10 bg-surface/55 backdrop-blur-md p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <label className="flex-1 text-xs font-medium text-text-secondary">
          Python Executable (optional)
          <input
            type="text"
            value={pythonOverride}
            onChange={(event) => onPythonOverrideChange(event.target.value)}
            placeholder="/absolute/path/to/python"
            className="mt-2 w-full rounded-lg border border-black/10 bg-white/55 backdrop-blur-sm px-3 py-2 text-sm normal-case text-text-primary"
          />
        </label>

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
        <p className="break-all">Interpreter: {runtime?.pythonBinary ?? "-"}</p>
        <p>Resolved from: {runtime?.resolvedFrom ?? "-"}</p>
        <p>Python version: {runtime?.pythonVersion ?? "-"}</p>
        <p>Package version: {runtime?.packageVersion ?? "-"}</p>
        {runtime?.transformersVersion ? <p>transformers: {runtime.transformersVersion}</p> : null}
        {runtime?.torchVersion ? <p>torch: {runtime.torchVersion}</p> : null}
        {showCompatibility && <p>Compatibility mode: {getCompatibilityLabel(runtime?.compatibilityMode)}</p>}
        {showEspeak && <p>espeak-ng: {runtime?.espeakVersion ?? "Not detected"}</p>}
        {runtime?.recommendedModelRepo && <p className="break-all">Recommended model: {runtime.recommendedModelRepo}</p>}
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
