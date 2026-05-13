import type { LocalTtsProbeResult } from "../../electron";

interface LocalRuntimeRuntimeSettingsProps {
  modelName: string;
  onRecheckRuntime: () => void;
  onPythonOverrideChange: (value: string) => void;
  pythonOverride: string;
  runtime: LocalTtsProbeResult | null;
  runtimeBusy: boolean;
}

function getCompatibilityLabel(mode: LocalTtsProbeResult["compatibilityMode"]): string {
  if (mode === "legacy_0_1_x") return "Legacy 0.1.x";
  if (mode === "current_1_2_x_or_newer") return "Current 1.2.x+";
  return "-";
}

export function LocalRuntimeRuntimeSettings({
  modelName,
  onRecheckRuntime,
  onPythonOverrideChange,
  pythonOverride,
  runtime,
  runtimeBusy,
}: LocalRuntimeRuntimeSettingsProps) {
  return (
    <section className="rounded-lg border border-border bg-surface/60 p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <label className="flex-1 text-xs font-semibold uppercase tracking-wider text-text-secondary">
          {modelName} Python Executable (optional)
          <input
            type="text"
            value={pythonOverride}
            onChange={(event) => onPythonOverrideChange(event.target.value)}
            placeholder="/absolute/path/to/python"
            className="mt-2 w-full rounded-md border border-border bg-panel px-3 py-2 text-sm normal-case text-text-primary"
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
              : "border-border-strong text-text-primary hover:border-text-primary"
            }
          `}
        >
          {runtimeBusy ? "Checking..." : "Re-check Runtime"}
        </button>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-2 text-[11px] text-text-secondary md:grid-cols-2">
        <p className="break-all">Resolved interpreter: {runtime?.pythonBinary ?? "-"}</p>
        <p>Resolved from: {runtime?.resolvedFrom ?? "-"}</p>
        <p>Python version: {runtime?.pythonVersion ?? "-"}</p>
        <p>Package version: {runtime?.packageVersion ?? "-"}</p>
        <p>Compatibility mode: {getCompatibilityLabel(runtime?.compatibilityMode)}</p>
        <p>espeak-ng: {runtime?.espeakVersion ?? "Not detected"}</p>
      </div>

      {runtime?.warnings?.length ? (
        <div className="mt-3 space-y-1 text-[11px] text-warning">
          {runtime.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      ) : null}
    </section>
  );
}
