import { useEffect, useId, useMemo, useState } from "react";
import { Eraser, Undo2 } from "lucide-react";
import {
  ALL_TEXT_CLEANUP_ACTIONS,
  DEFAULT_TEXT_CLEANUP_ACTIONS,
  cleanupText,
  type TextCleanupAction,
} from "../../lib/text/cleanup";
import { condenseDiff } from "../../lib/creator/display";
import { buildTextDiff } from "../../lib/text/textEdits";
import { accentButtonClass, checkboxLabelClass, selectClass, subtleButtonClass } from "./creatorStyles";

interface TextCleanupPanelProps {
  text: string;
  onTextChange: (text: string) => void;
}

const ACTION_LABELS: Record<TextCleanupAction, { label: string; hint: string }> = {
  markdown: { label: "Markdown", hint: "Headings, bold, links and list markers" },
  citations: { label: "Citations", hint: "[1], [12] and (Smith, 2020)" },
  footnotes: { label: "Footnote marks", hint: "Superscript digits and ^1" },
  urls: { label: "Links", hint: "Web addresses" },
  emoji: { label: "Emoji", hint: "Pictographs a voice would skip or mangle" },
  pdfArtifacts: { label: "PDF line wrapping", hint: "Hyphenated line ends, page numbers, hard-wrapped lines" },
  htmlEntities: { label: "HTML entities", hint: "&amp; and &#8217;" },
  repeatedPunctuation: { label: "Repeated punctuation", hint: "!!!, ??? and ,," },
  whitespace: { label: "Extra spaces", hint: "Runs of spaces and blank lines" },
};

/** How long the summary must hold still before screen readers hear it. */
const ANNOUNCE_DELAY_MS = 750;

/** One-click cleanup of the script, previewed as a diff before anything changes. */
export function TextCleanupPanel({ text, onTextChange }: TextCleanupPanelProps) {
  const [actions, setActions] = useState<ReadonlySet<TextCleanupAction>>(() => new Set(DEFAULT_TEXT_CLEANUP_ACTIONS));
  const [urlMode, setUrlMode] = useState<"domain" | "remove">("domain");
  // Undo is only offered while the script is still exactly what the cleanup produced.
  const [undo, setUndo] = useState<{ before: string; after: string } | null>(null);
  const idPrefix = useId();

  const result = useMemo(
    () => cleanupText(text, { actions: ALL_TEXT_CLEANUP_ACTIONS.filter((action) => actions.has(action)), urlMode }),
    [actions, text, urlMode],
  );
  const preview = useMemo(() => condenseDiff(buildTextDiff(result)), [result]);
  const changeCount = result.edits.length;
  const countsText = ALL_TEXT_CLEANUP_ACTIONS
    .filter((action) => result.counts[action] > 0)
    .map((action) => `${result.counts[action]} ${ACTION_LABELS[action].label.toLowerCase()}`)
    .join(", ");

  const summary = changeCount === 0
    ? (text.trim() ? "Nothing to clean up with these options." : "Write or paste a script to clean it.")
    : `${changeCount} ${changeCount === 1 ? "change" : "changes"}: ${countsText}.`;
  // Only the one-line summary is announced, and only once typing pauses: a
  // live region around the whole diff re-read every removed and added
  // fragment on each keystroke in the script.
  // Nothing is announced on mount; the visible summary is already there.
  const [announced, setAnnounced] = useState("");
  const [announcedFor, setAnnouncedFor] = useState(summary);
  useEffect(() => {
    if (summary === announcedFor) return;
    const timer = window.setTimeout(() => {
      setAnnouncedFor(summary);
      setAnnounced(summary);
    }, ANNOUNCE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [announcedFor, summary]);

  const toggle = (action: TextCleanupAction) => {
    setActions((current) => {
      const next = new Set(current);
      if (!next.delete(action)) next.add(action);
      return next;
    });
  };

  return (
    <div className="space-y-3 rounded-xl border border-border bg-text-primary/[0.03] p-3">
      <fieldset>
        <legend className="text-xs font-medium text-text-secondary">Remove from the script</legend>
        <div className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
          {ALL_TEXT_CLEANUP_ACTIONS.map((action) => (
            <label key={action} className={`${checkboxLabelClass} text-xs`} title={ACTION_LABELS[action].hint}>
              <input
                type="checkbox"
                checked={actions.has(action)}
                className="mt-0.5 accent-accent"
                onChange={() => toggle(action)}
              />
              {ACTION_LABELS[action].label}
            </label>
          ))}
        </div>
      </fieldset>

      {actions.has("urls") && (
        <div>
          <label htmlFor={`${idPrefix}-url-mode`} className="text-xs font-medium text-text-secondary">
            Links
          </label>
          <select
            id={`${idPrefix}-url-mode`}
            value={urlMode}
            className={`${selectClass} mt-1`}
            onChange={(event) => setUrlMode(event.target.value as "domain" | "remove")}
          >
            <option value="domain">Keep the site name</option>
            <option value="remove">Remove completely</option>
          </select>
        </div>
      )}

      <div>
        <div className="text-xs font-semibold text-text-secondary">Preview</div>
        <p role="status" className="sr-only">{announced}</p>
        {changeCount === 0 ? (
          <p className="mt-1 text-xs text-text-muted">{summary}</p>
        ) : (
          <>
            <p className="mt-1 text-xs text-text-muted">{summary}</p>
            <p
              className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border/70 bg-panel p-2 text-sm text-text-primary"
              data-testid="cleanup-preview"
            >
              {preview.shown.map((part, index) => {
                if (part.type === "removed") {
                  return (
                    <del key={index} className="rounded bg-danger/10 text-danger line-through decoration-danger/60">
                      <span className="sr-only">Removed: </span>{part.text}
                    </del>
                  );
                }
                if (part.type === "inserted") {
                  return (
                    <ins key={index} className="rounded bg-success/10 text-success no-underline">
                      <span className="sr-only">Added: </span>{part.text}
                    </ins>
                  );
                }
                return <span key={index}>{part.text}</span>;
              })}
              {preview.hiddenChanges > 0 && (
                <span className="text-text-muted"> … and {preview.hiddenChanges} more {preview.hiddenChanges === 1 ? "change" : "changes"}</span>
              )}
            </p>
          </>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={accentButtonClass}
          disabled={changeCount === 0}
          onClick={() => {
            setUndo({ before: text, after: result.text });
            onTextChange(result.text);
          }}
        >
          <Eraser size={12} aria-hidden="true" />
          Clean up script
        </button>
        {undo !== null && undo.after === text && (
          <button
            type="button"
            className={subtleButtonClass}
            onClick={() => {
              onTextChange(undo.before);
              setUndo(null);
            }}
          >
            <Undo2 size={12} aria-hidden="true" />
            Undo cleanup
          </button>
        )}
      </div>
    </div>
  );
}
