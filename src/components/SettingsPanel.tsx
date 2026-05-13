import { useState } from "react";
import { ChevronDown, RefreshCw, Trash2 } from "lucide-react";
import type { ModelType } from "../types";
import { MODELS } from "../constants";

type StatusType = "success" | "error" | "info";

interface SettingsPanelProps {
  activeModel: ModelType;
  busy: boolean;
  status: { type: StatusType; message: string } | null;
  onClearCache: () => void;
  onRedownloadActive: () => void;
}

export function SettingsPanel({
  activeModel,
  busy,
  status,
  onClearCache,
  onRedownloadActive,
}: SettingsPanelProps) {
  const [open, setOpen] = useState(false);
  const modelLabel = activeModel === "kokoro" ? MODELS.kokoro.label : MODELS.supertonic.label;

  return (
    <div className="border border-border rounded-xl overflow-hidden">
      {/* Toggle header */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-border/30 transition-colors"
      >
        <span className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
          Settings
        </span>
        <ChevronDown
          size={14}
          className={`text-text-muted transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {/* Collapsible content */}
      {open && (
        <div className="px-4 pb-4 flex flex-col gap-2 border-t border-border animate-fade-up">
          <p className="text-[11px] text-text-muted pt-3 pb-1">
            Model files stay cached locally after the first download, but the app still has to reinitialize them after a refresh.
          </p>

          <button
            onClick={onClearCache}
            disabled={busy}
            className={`w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${
              busy
                ? "border-border text-text-muted cursor-not-allowed"
                : "border-border-strong text-text-secondary hover:border-border-strong hover:text-text-primary"
            }`}
          >
            <Trash2 size={12} />
            Clear Model Cache
          </button>

          <button
            onClick={onRedownloadActive}
            disabled={busy}
            className={`w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
              busy
                ? "bg-border text-text-muted cursor-not-allowed"
                : "bg-border-strong text-text-secondary hover:text-text-primary"
            }`}
          >
            <RefreshCw size={12} />
            Re-download {modelLabel}
          </button>

          {status && (
            <p
              className={`text-[11px] mt-1 ${
                status.type === "success"
                  ? "text-success"
                  : status.type === "error"
                  ? "text-danger"
                  : "text-text-muted"
              }`}
            >
              {status.message}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
