import type {
  LocalTtsCacheInfo,
  LocalTtsProbeResult,
} from "../../electron";
import { formatBytes, statusClass, type StatusTone } from "./utils";

interface LocalRuntimeSidebarProps {
  busy: boolean;
  cacheInfo: LocalTtsCacheInfo | null;
  electronAvailable: boolean;
  links: Array<{ label: string; href: string }>;
  onClearCache: () => void;
  onRedownload: () => void;
  runtime: LocalTtsProbeResult | null;
  runtimeBusy: boolean;
  runtimeReady: boolean;
  status: { tone: StatusTone; text: string } | null;
}

export function LocalRuntimeSidebar({
  busy,
  cacheInfo,
  electronAvailable,
  links,
  onClearCache,
  onRedownload,
  runtime,
  runtimeBusy,
  runtimeReady,
  status,
}: LocalRuntimeSidebarProps) {
  return (
    <aside className="flex flex-col gap-4 rounded-2xl border border-border/60 bg-panel p-4 shadow-md transition-all duration-300 hover:border-border hover:shadow-lg sm:p-6 lg:col-span-2">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Runtime Status</h3>
        <p className="text-[11px] text-text-muted mt-2">
          {runtimeBusy
            ? "Checking local runtime..."
            : runtimeReady
              ? "Local runtime is ready."
              : "Local runtime is not ready yet."}
        </p>
        {runtime && (
          <div className="mt-3 space-y-1 text-[11px] text-text-secondary break-words">
            <p className="break-all">Interpreter: {runtime.pythonBinary}</p>
            <p>Resolved from: {runtime.resolvedFrom}</p>
            <p>Python: {runtime.pythonVersion}</p>
            {runtime.package && <p>Package: {runtime.package}{runtime.packageVersion ? ` ${runtime.packageVersion}` : ""}</p>}
            {runtime.compatibilityMode && <p>Mode: {runtime.compatibilityMode}</p>}
            {runtime.requiresPython && <p>Requirement: {runtime.requiresPython}</p>}
            <p>espeak-ng: {runtime.espeakVersion ?? "Not detected"}</p>
            {runtime.warnings?.map((warning) => (
              <p key={warning} className="text-warning">{warning}</p>
            ))}
          </div>
        )}
      </div>

      <div className="border border-border rounded-lg p-4 bg-surface/70">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Cache</h3>
        <p className="text-[11px] text-text-muted mt-1">
          First download is cached under app local data. Re-runs use local cache unless cleared.
        </p>

        <div className="mt-3 space-y-1 text-[11px] text-text-secondary">
          <p className="break-all">Path: {cacheInfo?.path ?? "-"}</p>
          <p>Size: {cacheInfo ? formatBytes(cacheInfo.sizeBytes) : "-"}</p>
        </div>

        <div className="mt-3 flex flex-col gap-2">
          <button
            onClick={onClearCache}
            disabled={!electronAvailable || busy}
            className={`
              px-3 py-2 rounded-md text-xs font-semibold border transition-colors
              ${!electronAvailable || busy
                ? "border-border text-text-muted cursor-not-allowed"
                : "border-border-strong text-text-primary bg-panel hover:border-text-primary"
              }
            `}
          >
            Clear Local Cache
          </button>

          <button
            onClick={onRedownload}
            disabled={!electronAvailable || busy || !runtimeReady}
            className={`
              px-3 py-2 rounded-md text-xs font-semibold transition-colors
              ${!electronAvailable || busy || !runtimeReady
                ? "bg-border text-text-muted cursor-not-allowed"
                : "bg-text-primary text-panel hover:bg-accent"
              }
            `}
          >
            Re-download Model
          </button>
        </div>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Sources</h3>
        <div className="mt-2 flex flex-wrap gap-2">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs px-2 py-1 rounded-md border border-border hover:border-border-strong text-text-secondary hover:text-text-primary transition-colors"
            >
              {link.label}
            </a>
          ))}
        </div>
      </div>

      {status && (
        <p className={`break-words text-xs ${statusClass(status.tone)}`}>
          {status.text}
        </p>
      )}
    </aside>
  );
}
