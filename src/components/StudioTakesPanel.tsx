import { memo, useId, useMemo, useState } from "react";
import { Check, ChevronDown, Layers, Loader2, Pin, Play, Square, Trash2 } from "lucide-react";
import { formatClock } from "../lib/formatClock";
import { compareTakes, measureTakeAudio } from "../lib/takes";
import { WHOLE_SCRIPT_TARGET, type UseStudioTakesReturn } from "../hooks/useStudioTakes";

interface StudioTakesPanelProps {
  takes: UseStudioTakesReturn;
  /** The text to vary is empty or the engine is busy with a Studio generation. */
  disabled?: boolean;
  /** The passage to preselect, usually the one the player is on. */
  activeSegmentId?: string | null;
}

const VARIATION_COUNT = 3;

const ICON_BUTTON = "flex h-8 w-8 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-text-primary/[0.08] hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";

/** Render seeded variations of the script or one passage, audition them, and pick the one the timeline keeps. */
export const StudioTakesPanel = memo(function StudioTakesPanel({ takes, disabled = false, activeSegmentId = null }: StudioTakesPanelProps) {
  const [open, setOpen] = useState(false);
  const [chosenTargetId, setChosenTargetId] = useState<string | null>(null);
  const panelId = useId();
  const selectId = useId();
  const { targets, stacks, applied, rendering, error, seedControl, unavailableReason, auditioningTakeId } = takes;

  const fallbackId = activeSegmentId && targets.some((target) => target.id === activeSegmentId) ? activeSegmentId : WHOLE_SCRIPT_TARGET;
  const targetId = chosenTargetId && targets.some((target) => target.id === chosenTargetId) ? chosenTargetId : fallbackId;
  const target = targets.find((entry) => entry.id === targetId) ?? targets[0];
  const stack = stacks[targetId];
  const rows = useMemo(() => (stack ? compareTakes(stack, measureTakeAudio) : []), [stack]);
  const busy = rendering !== null;
  const canRender = !disabled && !busy && unavailableReason === null && target.text.trim().length > 0;

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
          <Layers size={14} aria-hidden="true" />
          Variations
        </span>
        <ChevronDown
          size={14}
          aria-hidden="true"
          className={`text-text-muted transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div id={panelId} className="animate-fade-up border-t border-border/60 px-4 pb-4 pt-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-0 flex-1">
              <label htmlFor={selectId} className="text-xs font-medium text-text-secondary">Passage</label>
              <select
                id={selectId}
                value={targetId}
                disabled={busy}
                onChange={(event) => setChosenTargetId(event.target.value)}
                className="mt-1 w-full rounded-lg border border-border bg-text-primary/[0.06] px-2.5 py-2 text-xs text-text-primary"
              >
                {targets.map((entry) => (
                  <option key={entry.id} value={entry.id}>{entry.label}</option>
                ))}
              </select>
            </div>
            {busy ? (
              <button
                type="button"
                onClick={takes.cancel}
                className="flex items-center gap-2 rounded-full bg-text-primary/[0.08] px-4 py-2 text-xs font-semibold text-text-primary"
              >
                <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                Cancel ({rendering.done}/{rendering.total})
              </button>
            ) : (
              <button
                type="button"
                disabled={!canRender}
                onClick={() => void takes.renderVariations(targetId, VARIATION_COUNT)}
                className="rounded-full bg-accent-fill px-4 py-2 text-xs font-semibold text-white transition-opacity disabled:opacity-50"
              >
                Variations ×{VARIATION_COUNT}
              </button>
            )}
          </div>
          <p className="mt-2 text-xs text-text-muted">
            {unavailableReason
              ?? (seedControl
                ? "Each take uses its own seed, so a take you like can be reproduced."
                : "This engine has no seed; takes differ by a small change of speaking speed.")}
          </p>

          {error && (
            <p role="alert" className="mt-3 rounded-lg border border-danger/30 bg-danger-light px-3 py-2 text-xs text-danger">
              {error}
            </p>
          )}

          {rows.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1" aria-label="Takes">
              {rows.map((row) => {
                const isApplied = applied[targetId] === row.takeId;
                const auditioning = auditioningTakeId === row.takeId;
                return (
                  <li key={row.takeId} className="flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-text-primary/[0.04]">
                    <button
                      type="button"
                      className={ICON_BUTTON}
                      aria-label={auditioning ? `Stop ${row.label}` : `Listen to ${row.label}`}
                      onClick={() => (auditioning ? takes.stopAudition() : takes.audition(targetId, row.takeId))}
                    >
                      {auditioning ? <Square size={13} aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}
                    </button>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-text-primary">{row.label}</p>
                      <p className="text-xs text-text-muted">
                        {formatClock(row.durationSec)} · {row.rmsDbfs} dB RMS
                        {row.durationDeltaSec !== 0 && ` · ${row.durationDeltaSec > 0 ? "+" : ""}${row.durationDeltaSec}s`}
                      </p>
                    </div>
                    {isApplied ? (
                      <span className="flex items-center gap-1 text-xs font-semibold text-accent">
                        <Check size={13} aria-hidden="true" />
                        In timeline
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => takes.pickTake(targetId, row.takeId)}
                        aria-label={`Use ${row.label}`}
                        className="rounded-full bg-text-primary/[0.08] px-3 py-1 text-xs font-semibold text-text-primary hover:bg-text-primary/[0.14]"
                      >
                        Use take
                      </button>
                    )}
                    <button
                      type="button"
                      className={`${ICON_BUTTON} ${row.pinned ? "text-accent" : ""}`}
                      aria-label={row.pinned ? `Unpin ${row.label}` : `Pin ${row.label}`}
                      aria-pressed={row.pinned}
                      onClick={() => takes.pinTake(targetId, row.takeId, !row.pinned)}
                    >
                      <Pin size={13} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className={ICON_BUTTON}
                      aria-label={`Remove ${row.label}`}
                      onClick={() => takes.removeTake(targetId, row.takeId)}
                    >
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
});
