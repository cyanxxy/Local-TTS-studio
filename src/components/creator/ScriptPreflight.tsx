import { useDeferredValue, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { ChunkPauseKind } from "../../types";
import { buildScriptPreflight, type PreflightChunk } from "../../lib/text/preflight";
import { cleanupText } from "../../lib/text/cleanup";
import { isSpeechNormalizationSupported } from "../../lib/text/normalize";
import type { BreakAwareChunk } from "../../lib/text/speechMarkup";
import type { PronunciationMatchRule } from "../../lib/textTuning";

interface ScriptPreflightProps {
  text: string;
  /** The active engine's chunker, so passages split as generation will split them. */
  chunkScript: (text: string) => BreakAwareChunk[];
  engineLabel: string;
  rules: readonly PronunciationMatchRule[];
  normalize: boolean;
  cleanup: boolean;
  /** The language the active engine speaks; normalization only runs where there is a normalizer. */
  speechLanguage?: string;
  pauseOverridesSec: Partial<Record<ChunkPauseKind, number>>;
  /** Speaking speed, for engines that take one. */
  speed: number;
}

const MAX_LISTED_PASSAGES = 40;
const MAX_MAPPED_PASSAGES = 200;

/** m:ss, or h:mm:ss from an hour on. */
export function formatEstimate(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

function formatPause(seconds: number): string {
  return seconds < 1 ? `${Math.round(seconds * 1000)} ms` : `${Math.round(seconds * 10) / 10} s`;
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 90 ? `${flat.slice(0, 87)}…` : flat;
}

/**
 * What generation will do with the script, before any audio is made: the
 * spoken text, a map of passages and pauses, and a duration estimate for the
 * active engine.
 */
export function ScriptPreflight({
  text,
  chunkScript,
  engineLabel,
  rules,
  normalize,
  cleanup,
  speechLanguage,
  pauseOverridesSec,
  speed,
}: ScriptPreflightProps) {
  const [open, setOpen] = useState(false);
  const [showSpoken, setShowSpoken] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const deferredText = useDeferredValue(text);
  const normalizing = normalize && isSpeechNormalizationSupported(speechLanguage);

  const preflight = useMemo(() => {
    if (!open || !deferredText.trim()) return null;
    const script = cleanup ? cleanupText(deferredText).text : deferredText;
    return buildScriptPreflight(script, {
      chunk: chunkScript,
      pronunciationRules: rules,
      normalization: normalizing ? { language: speechLanguage } : false,
      pauseOverridesSec,
      speed,
    });
  }, [chunkScript, cleanup, deferredText, normalizing, open, pauseOverridesSec, rules, speechLanguage, speed]);

  const totals = preflight?.totals;
  const mapped = preflight?.chunks.slice(0, MAX_MAPPED_PASSAGES) ?? [];
  const listed = showAll ? (preflight?.chunks ?? []) : (preflight?.chunks.slice(0, MAX_LISTED_PASSAGES) ?? []);

  return (
    <div className="rounded-xl border border-border bg-text-primary/[0.03]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-semibold text-text-secondary"
      >
        Script preflight
        <ChevronDown size={14} aria-hidden="true" className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="space-y-3 border-t border-border/70 p-3">
          {!totals || !preflight ? (
            <p className="text-xs text-text-muted">Write or paste a script to preview it.</p>
          ) : (
            <>
              <dl className="grid grid-cols-3 gap-2 text-center">
                <div>
                  <dt className="text-2xs text-text-muted">Estimated length</dt>
                  <dd className="font-mono text-sm text-text-primary" data-testid="preflight-duration">
                    {formatEstimate(totals.durationSec)}
                  </dd>
                </div>
                <div>
                  <dt className="text-2xs text-text-muted">Passages</dt>
                  <dd className="font-mono text-sm text-text-primary">{totals.chunkCount}</dd>
                </div>
                <div>
                  <dt className="text-2xs text-text-muted">Pauses</dt>
                  <dd className="font-mono text-sm text-text-primary">{formatEstimate(totals.pauseSec)}</dd>
                </div>
              </dl>
              <p className="text-xs text-text-muted">
                {totals.changedChunkCount === 0
                  ? "The script is spoken exactly as written."
                  : `${totals.changedChunkCount} of ${totals.chunkCount} ${totals.chunkCount === 1 ? "passage is" : "passages are"} spoken differently from how ${totals.changedChunkCount === 1 ? "it is" : "they are"} written.`}
                {" "}An estimate for {engineLabel}; real length depends on the voice.
              </p>

              <div
                role="img"
                aria-label={`Map of ${totals.chunkCount} passages and the pauses between them`}
                className="flex h-6 w-full gap-px overflow-hidden rounded-md bg-border/60"
              >
                {preflight.leadingPauseSec > 0 && (
                  <span
                    style={{ flexGrow: preflight.leadingPauseSec, minWidth: 2 }}
                    className="bg-accent/20"
                    title={`Opening pause ${formatPause(preflight.leadingPauseSec)}`}
                  />
                )}
                {mapped.flatMap((chunk) => [
                  <span
                    key={`s${chunk.index}`}
                    style={{ flexGrow: Math.max(chunk.estimatedSpeechSec, 0.05), minWidth: 2 }}
                    className="bg-accent/70"
                    title={`Passage ${chunk.index + 1}: ${snippet(chunk.spokenText)}`}
                  />,
                  ...(chunk.pauseAfterSec > 0
                    ? [<span
                        key={`p${chunk.index}`}
                        style={{ flexGrow: chunk.pauseAfterSec, minWidth: 2 }}
                        className={chunk.isBreak ? "bg-accent/30" : "bg-text-primary/10"}
                        title={`${chunk.isBreak ? "Pause tag" : "Pause"} ${formatPause(chunk.pauseAfterSec)}`}
                      />]
                    : []),
                ])}
              </div>
              {preflight.chunks.length > MAX_MAPPED_PASSAGES && (
                <p className="text-xs text-text-muted">The map shows the first {MAX_MAPPED_PASSAGES} passages.</p>
              )}

              <label className="flex cursor-pointer items-center gap-2 text-xs text-text-secondary select-none">
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={showSpoken}
                  onChange={(event) => setShowSpoken(event.target.checked)}
                />
                Show the spoken text
              </label>
              {showSpoken && (
                <p
                  className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border/70 bg-panel p-2 text-sm text-text-primary"
                  data-testid="preflight-spoken"
                >
                  {preflight.spokenText}
                </p>
              )}

              <ol className="space-y-1.5">
                {listed.map((chunk: PreflightChunk) => (
                  <li key={chunk.index} className="flex items-baseline gap-2 text-xs">
                    <span className="w-6 shrink-0 text-right font-mono text-2xs tabular-nums text-text-muted">
                      {chunk.index + 1}
                    </span>
                    <span className="min-w-0 flex-1 break-words text-text-primary">
                      {snippet(chunk.spokenText)}
                      {chunk.spokenText !== chunk.text && (
                        <span className="ml-1.5 rounded bg-accent/10 px-1 text-2xs text-accent">changed</span>
                      )}
                    </span>
                    <span className="shrink-0 font-mono text-2xs tabular-nums text-text-muted">
                      {chunk.pauseAfterSec > 0 ? `${chunk.isBreak ? "pause " : ""}${formatPause(chunk.pauseAfterSec)}` : ""}
                    </span>
                  </li>
                ))}
              </ol>
              {!showAll && preflight.chunks.length > MAX_LISTED_PASSAGES && (
                <button
                  type="button"
                  className="text-xs font-medium text-accent hover:underline"
                  onClick={() => setShowAll(true)}
                >
                  Show all {preflight.chunks.length} passages
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
