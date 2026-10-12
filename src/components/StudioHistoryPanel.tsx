import { useId, useState } from "react";
import { ChevronDown, Download, History, Play, RotateCcw, Star, Trash2 } from "lucide-react";
import { formatClock } from "../lib/formatClock";
import {
  GENERATION_HISTORY_LIMITS,
  type GenerationHistoryEntry,
  type GenerationHistoryUsage,
} from "../lib/history/generationHistory";
import { getEngine, isEngineId } from "../models/registry";
import { formatBytes } from "./localRuntime/utils";

interface StudioHistoryPanelProps {
  /** Newest first. */
  entries: readonly GenerationHistoryEntry[];
  usage: GenerationHistoryUsage;
  loading: boolean;
  /** A failed read of the history store, or of a history action. */
  error: string | null;
  onReplay: (id: string) => void;
  onDownload: (entry: GenerationHistoryEntry) => void;
  onReuse: (id: string) => void;
  onSetFavorite: (id: string, favorite: boolean) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  onClear: (options: { keepFavorites: boolean }) => Promise<unknown>;
}

function engineLabel(engineId: string): string {
  return isEngineId(engineId) ? getEngine(engineId).label : engineId;
}

function formatWhen(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const ICON_BUTTON = "flex h-8 w-8 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-text-primary/[0.08] hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";

/** Every saved Studio generation, with replay, export, reuse, favorites and cleanup. */
export function StudioHistoryPanel({
  entries,
  usage,
  loading,
  error,
  onReplay,
  onDownload,
  onReuse,
  onSetFavorite,
  onDelete,
  onClear,
}: StudioHistoryPanelProps) {
  const [open, setOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const panelId = useId();
  const limits = GENERATION_HISTORY_LIMITS;
  const bytesShare = Math.min(100, Math.round((usage.totalBytes / limits.maxTotalBytes) * 100));
  const hasUnfavorited = entries.some((entry) => !entry.favorite);

  const run = async (action: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await action();
    } catch (cause) {
      setActionError(errorText(cause));
    }
  };

  return (
    <div className="glass rounded-[20px] overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-text-primary/[0.07]"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-text-secondary">
          <History size={14} aria-hidden="true" />
          Generation History
          {usage.entryCount > 0 && <span className="font-mono text-xs text-text-muted">{usage.entryCount}</span>}
        </span>
        <ChevronDown
          size={14}
          aria-hidden="true"
          className={`text-text-muted transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div id={panelId} className="animate-fade-up border-t border-black/5 px-4 pb-4 pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs text-text-secondary" data-testid="history-usage">
                {usage.entryCount} of {limits.maxEntries} generations · {formatBytes(usage.totalBytes)} of {formatBytes(limits.maxTotalBytes)}
                {" "}· {usage.favoriteCount} of {limits.maxFavoriteEntries} favorites
              </p>
              <div
                role="progressbar"
                aria-label="History storage used"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={bytesShare}
                className="mt-1.5 h-1 w-48 overflow-hidden rounded-full bg-text-primary/10"
              >
                <div className="h-full rounded-full bg-accent" style={{ width: `${bytesShare}%` }} />
              </div>
            </div>
            {confirmingClear ? (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-text-secondary">Remove all but favorites?</span>
                <button
                  type="button"
                  className="rounded-full bg-danger px-3 py-1 font-semibold text-white"
                  onClick={() => {
                    setConfirmingClear(false);
                    void run(() => onClear({ keepFavorites: true }));
                  }}
                >
                  Confirm
                </button>
                <button type="button" className="rounded-full px-3 py-1 text-text-secondary" onClick={() => setConfirmingClear(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={!hasUnfavorited}
                onClick={() => setConfirmingClear(true)}
                className="rounded-full px-3 py-1 text-xs font-semibold text-text-secondary transition-colors hover:bg-text-primary/[0.08] disabled:opacity-50"
              >
                Clear history
              </button>
            )}
          </div>

          {(error ?? actionError) && (
            <p role="alert" className="mt-3 rounded-lg border border-danger/30 bg-danger-light px-3 py-2 text-xs text-danger">
              {error ?? actionError}
            </p>
          )}

          {entries.length === 0 ? (
            <p className="mt-4 text-xs text-text-muted">
              {loading ? "Loading history…" : "Generations you finish in Studio are kept here."}
            </p>
          ) : (
            <ul className="mt-3 flex max-h-96 flex-col gap-1 overflow-y-auto" aria-label="Saved generations">
              {entries.map((entry) => (
                <li key={entry.id} className="flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-text-primary/[0.04]">
                  <button
                    type="button"
                    className={ICON_BUTTON}
                    aria-label={`Play "${entry.title}"`}
                    onClick={() => onReplay(entry.id)}
                  >
                    <Play size={14} aria-hidden="true" />
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text-primary">{entry.title}</p>
                    <p className="truncate text-xs text-text-muted">
                      {engineLabel(entry.engineId)} · {entry.voice.label ?? entry.voice.voiceId}
                      {entry.seed === undefined ? "" : ` · seed ${entry.seed}`}
                      {" "}· {formatClock(entry.durationSec)} · {formatWhen(entry.createdAt)}
                      {entry.completed ? "" : " · stopped early"}
                    </p>
                  </div>
                  <button
                    type="button"
                    className={ICON_BUTTON}
                    aria-label={`Reuse settings of "${entry.title}"`}
                    title="Reuse text, engine, voice and settings"
                    onClick={() => onReuse(entry.id)}
                  >
                    <RotateCcw size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={ICON_BUTTON}
                    aria-label={`Download "${entry.title}"`}
                    onClick={() => onDownload(entry)}
                  >
                    <Download size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={`${ICON_BUTTON} ${entry.favorite ? "text-accent" : ""}`}
                    aria-label={entry.favorite ? `Remove "${entry.title}" from favorites` : `Favorite "${entry.title}"`}
                    aria-pressed={entry.favorite}
                    onClick={() => void run(() => onSetFavorite(entry.id, !entry.favorite))}
                  >
                    <Star size={14} aria-hidden="true" fill={entry.favorite ? "currentColor" : "none"} />
                  </button>
                  <button
                    type="button"
                    className={ICON_BUTTON}
                    aria-label={`Delete "${entry.title}"`}
                    onClick={() => void run(() => onDelete(entry.id))}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
