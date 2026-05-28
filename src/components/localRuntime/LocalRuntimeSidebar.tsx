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
    <aside className="flex flex-col gap-4 rounded-[22px] glass-panel p-4 transition-all duration-300 sm:p-6 lg:col-span-2">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Runtime Status</h3>
        <p className="text-sm text-text-muted mt-2">
          {runtimeBusy
            ? "Checking local runtime..."
            : runtimeReady
              ? "Local runtime is ready."
              : "Local runtime is not ready yet."}
        </p>
        {runtime && (
          <div className="mt-3 space-y-1 text-sm text-text-secondary break-words">
            <p className="break-all">Interpreter: {runtime.pythonBinary}</p>
            <p>Resolved from: {runtime.resolvedFrom}</p>
            <p>Python: {runtime.pythonVersion}</p>
            {runtime.package && <p>Package: {runtime.package}{runtime.packageVersion ? ` ${runtime.packageVersion}` : ""}</p>}
            {runtime.compatibilityMode && <p>Mode: {runtime.compatibilityMode}</p>}
            {runtime.requiresPython && <p>Requirement: {runtime.requiresPython}</p>}
            {runtime.espeakVersion != null && <p>espeak-ng: {runtime.espeakVersion}</p>}
            {runtime.warnings?.map((warning) => (
              <p key={warning} className="text-warning">{warning}</p>
            ))}
          </div>
        )}
      </div>

      <div className="border border-black/10 rounded-xl p-4 bg-surface/55 backdrop-blur-md">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Cache</h3>
        <p className="text-sm text-text-muted mt-1">
          First download is cached under app local data. Re-runs use local cache unless cleared.
        </p>

        <div className="mt-3 space-y-1 text-sm text-text-secondary">
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
                : "border-white/55 bg-white/45 backdrop-blur-md text-text-primary hover:bg-white/65"
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
                : "glass-accent text-white"
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
              className="text-xs px-2.5 py-1 rounded-full border border-white/55 bg-white/40 backdrop-blur-sm text-text-secondary hover:bg-white/60 hover:text-text-primary transition-colors"
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
