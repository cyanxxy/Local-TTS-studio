import { useId, useMemo, useState } from "react";
import { Eraser, Undo2 } from "lucide-react";
import {
  ALL_TEXT_CLEANUP_ACTIONS,
  DEFAULT_TEXT_CLEANUP_ACTIONS,
  cleanupText,
  type TextCleanupAction,
} from "../../lib/text/cleanup";
import { buildTextDiff, type TextDiffPart } from "../../lib/text/textEdits";
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

const CONTEXT_CHARS = 24;
const MAX_CHANGES_SHOWN = 12;

interface PreviewPart {
  type: TextDiffPart["type"];
  text: string;
}

/**
 * The diff reduced to its changes with a little text around each, so a long
 * script previews briefly. Consecutive removals and insertions are one change.
 */
export function condenseDiff(parts: readonly TextDiffPart[]): { shown: PreviewPart[]; hiddenChanges: number } {
  const shown: PreviewPart[] = [];
  let changes = 0;
  let hiddenChanges = 0;
  parts.forEach((part, index) => {
    const startsChange = part.type !== "equal" && (index === 0 || parts[index - 1].type === "equal");
    if (startsChange) changes += 1;
    if (part.type !== "equal") {
      if (changes <= MAX_CHANGES_SHOWN) shown.push({ type: part.type, text: part.text });
      else if (startsChange) hiddenChanges += 1;
      return;
    }
    if (changes > MAX_CHANGES_SHOWN) return;
    // Only the sides that touch a change are kept: not the start of the script before the first one, nor its end after the last.
    const touchesPrevious = index > 0;
    const touchesNext = index < parts.length - 1;
    const text = part.text;
    if (text.length <= CONTEXT_CHARS * 2) {
      shown.push({ type: "equal", text });
    } else if (touchesPrevious && touchesNext) {
      shown.push({ type: "equal", text: `${text.slice(0, CONTEXT_CHARS)} … ${text.slice(-CONTEXT_CHARS)}` });
    } else if (touchesNext) {
      shown.push({ type: "equal", text: `… ${text.slice(-CONTEXT_CHARS)}` });
    } else {
      shown.push({ type: "equal", text: `${text.slice(0, CONTEXT_CHARS)} …` });
    }
  });
  return { shown, hiddenChanges };
}

/** One-click cleanup of the script, previewed as a diff before anything changes. */
export function TextCleanupPanel({ text, onTextChange }: TextCleanupPanelProps) {
  const [actions, setActions] = useState<ReadonlySet<TextCleanupAction>>(() => new Set(DEFAULT_TEXT_CLEANUP_ACTIONS));
  const [urlMode, setUrlMode] = useState<"domain" | "remove">("domain");
  const [undoText, setUndoText] = useState<string | null>(null);
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

      <div aria-live="polite">
        <div className="text-xs font-semibold text-text-secondary">Preview</div>
        {changeCount === 0 ? (
          <p className="mt-1 text-xs text-text-muted">
            {text.trim() ? "Nothing to clean up with these options." : "Write or paste a script to clean it."}
          </p>
        ) : (
          <>
            <p className="mt-1 text-xs text-text-muted">
              {changeCount} {changeCount === 1 ? "change" : "changes"}: {countsText}.
            </p>
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
            setUndoText(text);
            onTextChange(result.text);
          }}
        >
          <Eraser size={12} aria-hidden="true" />
          Clean up script
        </button>
        {undoText !== null && (
          <button
            type="button"
            className={subtleButtonClass}
            onClick={() => {
              onTextChange(undoText);
              setUndoText(null);
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
