import { useEffect, useId, useMemo, useState } from "react";
import { Check, ChevronDown, Download, ExternalLink, Shuffle } from "lucide-react";
import {
  findPiperVoice,
  PIPER_CACHE_NAME,
  PIPER_VOICES,
  type PiperQuality,
  type PiperVoiceEntry,
} from "../lib/piperVoices";
import {
  joinPiperVoice,
  piperVoiceAttribution,
  piperAccentLabel,
  piperQualityLabel,
  piperVoiceDownloadBytes,
  PIPER_QUALITY_ORDER,
  splitPiperVoice,
} from "../models/piper";
import type { ModelState } from "../types";
import { progressFillStyle } from "./progressFill";

interface PiperVoiceBrowserProps {
  /** The GENERATE voice string: a catalog id, plus `#<speaker>` for multi-speaker voices. */
  voice: string;
  onVoiceChange: (voice: string) => void;
  /** The Piper worker's load state; its progress is a voice download. */
  modelState?: ModelState;
}

type QualityFilter = PiperQuality | "all";

function formatSize(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/** Ids of the catalog voices whose graph is already in the Piper cache, or null when it cannot be read. */
async function readDownloadedVoices(): Promise<ReadonlySet<string> | null> {
  if (typeof caches === "undefined") return null;
  try {
    if (!(await caches.has(PIPER_CACHE_NAME))) return new Set();
    const cache = await caches.open(PIPER_CACHE_NAME);
    const urls = (await cache.keys()).map((request) => request.url);
    return new Set(PIPER_VOICES.filter((entry) => urls.some((url) => url.endsWith(entry.model))).map((entry) => entry.id));
  } catch {
    return null;
  }
}

function clampSpeaker(value: number, voice: PiperVoiceEntry): number {
  return Math.max(0, Math.min(voice.numSpeakers - 1, Math.trunc(value)));
}

/**
 * Piper's voice browser: the curated catalog grouped by accent and filterable
 * by quality, with each voice's download size, whether it is already on this
 * device, its licence and its attribution. A voice downloads the first time it
 * speaks, so the selected voice also shows that download's progress.
 */
export function PiperVoiceBrowser({ voice, onVoiceChange, modelState }: PiperVoiceBrowserProps) {
  const [expanded, setExpanded] = useState(false);
  const [qualityFilter, setQualityFilter] = useState<QualityFilter>("all");
  const [downloaded, setDownloaded] = useState<ReadonlySet<string> | null>(null);
  const listId = useId();
  const speakerId = useId();

  const { id: selectedId, speaker } = splitPiperVoice(voice);
  const selected = findPiperVoice(selectedId);
  const downloading = modelState?.loading === true;

  // Re-read the cache when a download finishes, so a voice that just arrived reads as downloaded.
  useEffect(() => {
    if (downloading) return;
    let current = true;
    void readDownloadedVoices().then((ids) => {
      if (current) setDownloaded(ids);
    });
    return () => {
      current = false;
    };
  }, [downloading, voice]);

  const qualities = useMemo(
    () => PIPER_QUALITY_ORDER.filter((quality) => PIPER_VOICES.some((entry) => entry.quality === quality)),
    [],
  );
  const groups = useMemo(() => {
    const visible = PIPER_VOICES.filter((entry) => qualityFilter === "all" || entry.quality === qualityFilter);
    const byAccent = new Map<string, PiperVoiceEntry[]>();
    for (const entry of visible) {
      const accent = `${piperAccentLabel(entry)} English`;
      byAccent.set(accent, [...(byAccent.get(accent) ?? []), entry]);
    }
    return [...byAccent.entries()].map(([accent, entries]) => ({
      accent,
      entries: [...entries].sort((a, b) => (
        PIPER_QUALITY_ORDER.indexOf(a.quality) - PIPER_QUALITY_ORDER.indexOf(b.quality) || a.name.localeCompare(b.name)
      )),
    }));
  }, [qualityFilter]);

  const choose = (entry: PiperVoiceEntry) => {
    onVoiceChange(joinPiperVoice(entry, entry.numSpeakers > 1 ? speaker ?? 0 : null));
  };
  const chooseSpeaker = (entry: PiperVoiceEntry, next: number) => {
    onVoiceChange(joinPiperVoice(entry, clampSpeaker(next, entry)));
  };

  const progress = Math.round(modelState?.downloadProgress ?? 0);

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-semibold text-text-secondary">Voice</span>

      {selected && (
        <div className="rounded-xl border border-accent/25 bg-accent-light/60 px-3 py-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-medium text-text-primary">{selected.name}</span>
            <span className="text-xs text-text-muted">
              {piperAccentLabel(selected)} · {piperQualityLabel(selected.quality)} quality
            </span>
          </div>

          {selected.numSpeakers > 1 && (
            <div className="mt-2 flex items-end gap-2">
              <label htmlFor={speakerId} className="flex-1 text-xs font-medium text-text-secondary">
                Speaker (1 to {selected.numSpeakers})
                <input
                  id={speakerId}
                  type="number"
                  min={1}
                  max={selected.numSpeakers}
                  value={(speaker ?? 0) + 1}
                  onChange={(event) => {
                    const next = event.target.valueAsNumber;
                    if (Number.isFinite(next)) chooseSpeaker(selected, next - 1);
                  }}
                  className="mt-1 w-full rounded-lg border border-border bg-text-primary/[0.06] px-3 py-1.5 text-sm text-text-primary"
                />
              </label>
              <button
                type="button"
                onClick={() => chooseSpeaker(selected, Math.floor(Math.random() * selected.numSpeakers))}
                aria-label="Pick a random speaker"
                title="Pick a random speaker"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-text-primary/[0.04] text-text-secondary transition-colors hover:bg-text-primary/[0.07] hover:text-text-primary"
              >
                <Shuffle size={14} aria-hidden="true" />
              </button>
            </div>
          )}

          {downloading ? (
            <div className="mt-2" role="status" aria-live="polite">
              <div className="flex items-center justify-between text-xs text-text-secondary">
                <span>Downloading voice</span>
                <span className="font-mono tabular-nums">{progress}%</span>
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-border">
                <div
                  className={`h-full w-full rounded-full transition-transform duration-500 ease-out ${progress < 99 ? "bg-accent" : "bg-success"}`}
                  style={progressFillStyle(progress <= 0 ? 0 : Math.max(4, progress))}
                />
              </div>
            </div>
          ) : (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-text-muted">
              {downloaded?.has(selected.id)
                ? <><Check size={12} aria-hidden="true" className="text-success" /> On this device</>
                : <><Download size={12} aria-hidden="true" /> {formatSize(piperVoiceDownloadBytes(selected))} download the first time it speaks</>}
            </p>
          )}

          <p className="mt-2 text-xs leading-5 text-text-muted">
            <span className="font-medium text-text-secondary">Licence: </span>
            {selected.license.url
              ? (
                <a href={selected.license.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-accent hover:underline">
                  {selected.license.id} <ExternalLink size={10} aria-hidden="true" />
                </a>
              )
              : selected.license.id}
            <br />
            {piperVoiceAttribution(selected)}
          </p>
        </div>
      )}

      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        aria-controls={listId}
        className="flex w-full items-center justify-between rounded-xl border border-border bg-text-primary/[0.04] px-3 py-2 text-sm text-text-primary transition-colors hover:bg-text-primary/[0.07]"
      >
        <span>Browse {PIPER_VOICES.length} voices</span>
        <ChevronDown size={14} aria-hidden="true" className={`text-text-muted transition-transform duration-200 ${expanded ? "rotate-180" : ""}`} />
      </button>

      {expanded && (
        <div id={listId} className="flex flex-col gap-2">
          <div role="group" aria-label="Filter by quality" className="flex flex-wrap gap-1.5">
            {(["all", ...qualities] as const).map((quality) => (
              <button
                key={quality}
                type="button"
                aria-pressed={qualityFilter === quality}
                onClick={() => setQualityFilter(quality)}
                className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                  qualityFilter === quality
                    ? "border-accent/40 bg-accent-light font-medium text-text-primary"
                    : "border-border bg-text-primary/[0.03] text-text-muted hover:bg-text-primary/[0.07] hover:text-text-primary"
                }`}
              >
                {quality === "all" ? "All" : piperQualityLabel(quality)}
              </button>
            ))}
          </div>

          <div className="max-h-64 overflow-y-auto rounded-xl border border-border">
            {groups.map(({ accent, entries }, index) => (
              <section key={accent} aria-label={accent}>
                {index > 0 && <div className="mx-3 border-t border-border/60" />}
                <h4 className="px-3 pb-1 pt-2.5 text-xs font-semibold text-text-secondary">{accent}</h4>
                {entries.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    aria-pressed={entry.id === selectedId}
                    onClick={() => choose(entry)}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                      entry.id === selectedId
                        ? "bg-accent-light font-medium text-text-primary"
                        : "text-text-secondary hover:bg-text-primary/[0.07] hover:text-text-primary"
                    }`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{entry.name}</span>
                      <span className="block text-2xs text-text-muted">
                        {piperQualityLabel(entry.quality)} · {formatSize(piperVoiceDownloadBytes(entry))}
                        {downloaded?.has(entry.id) ? " · downloaded" : ""}
                        {entry.numSpeakers > 1 ? ` · ${entry.numSpeakers} speakers` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 rounded-full border border-border px-2 py-0.5 font-mono text-2xs text-text-muted">
                      {entry.license.id}
                    </span>
                    {entry.id === selectedId && <Check size={12} aria-hidden="true" className="shrink-0 text-accent" />}
                  </button>
                ))}
              </section>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
