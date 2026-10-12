import { useId, useState } from "react";
import { Check, Copy, Plus } from "lucide-react";
import { SeedField } from "./SeedField";
import { CHATTERBOX_TAG_TOKENS } from "../lib/chatterboxTags";
import {
  CHATTERBOX_DOWNLOAD_BYTES,
  CHATTERBOX_TEMPERATURE_RANGE,
  type ChatterboxSettings,
} from "../models/chatterbox";
import type { ModelState } from "../types";

interface ChatterboxInlineSettingsProps {
  settings: ChatterboxSettings;
  onChange: (patch: Partial<Pick<ChatterboxSettings, "temperature" | "seed">>) => void;
  modelState: ModelState;
  /** Adds a tag to the script. Without it (the Reader) a tag is copied for pasting instead. */
  onInsertTag?: (tag: string) => void;
}

/**
 * Chatterbox's sampling controls and tags, with the plain facts about its cost:
 * a large first-use download and generation slower than playback.
 */
export function ChatterboxInlineSettings({ settings, onChange, modelState, onInsertTag }: ChatterboxInlineSettingsProps) {
  const temperatureId = useId();
  const [copied, setCopied] = useState<string | null>(null);
  const downloadLabel = `${(CHATTERBOX_DOWNLOAD_BYTES / 1e9).toFixed(1)} GB`;

  const chooseTag = (tag: string) => {
    if (onInsertTag) {
      onInsertTag(tag);
      return;
    }
    void navigator.clipboard?.writeText(tag).then(() => setCopied(tag), () => setCopied(null));
  };

  return (
    <section aria-label="Chatterbox settings" className="space-y-3 rounded-2xl border border-border bg-text-primary/[0.03] p-3">
      <p className="rounded-xl border border-accent/15 bg-accent-light/60 px-3 py-2 text-xs leading-5 text-text-secondary">
        {modelState.ready
          ? "Chatterbox generates slower than real time, roughly two seconds of work for each second of speech. Audio plays as each passage finishes, so playback may pause between passages; the whole script is ready once generation completes."
          : `First use downloads about ${downloadLabel} and needs WebGPU. After that it loads from this device. Generation is slower than real time, so audio arrives passage by passage.`}
      </p>

      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <label htmlFor={temperatureId} className="text-xs font-medium text-text-secondary">Variation (temperature)</label>
          <span className="font-mono text-xs tabular-nums text-text-primary">{settings.temperature.toFixed(2)}</span>
        </div>
        <input
          id={temperatureId}
          type="range"
          min={CHATTERBOX_TEMPERATURE_RANGE.min}
          max={CHATTERBOX_TEMPERATURE_RANGE.max}
          step={CHATTERBOX_TEMPERATURE_RANGE.step}
          value={settings.temperature}
          onChange={(event) => onChange({ temperature: event.target.valueAsNumber })}
        />
        <div className="mt-1 flex justify-between">
          <span className="text-2xs text-text-muted">Steady</span>
          <span className="text-2xs text-text-muted">Expressive</span>
        </div>
      </div>

      <SeedField seed={settings.seed} onChange={(seed) => onChange({ seed })} />

      <div>
        <p className="text-xs font-medium text-text-secondary">Expression tags</p>
        <p className="mt-0.5 text-2xs leading-4 text-text-muted">
          Type a tag in square brackets where it should happen, for example “That is hilarious [laugh]”. Any other
          bracketed direction is skipped, not read aloud. {onInsertTag ? "Select a tag to add it to the end of the script." : "Select a tag to copy it."}
        </p>
        <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Supported tags">
          {CHATTERBOX_TAG_TOKENS.map((tag) => (
            <li key={tag}>
              <button
                type="button"
                onClick={() => chooseTag(tag)}
                aria-label={`${onInsertTag ? "Add" : "Copy"} ${tag}`}
                className="flex items-center gap-1 rounded-full border border-border bg-text-primary/[0.03] px-2 py-0.5 font-mono text-2xs text-text-secondary transition-colors hover:bg-text-primary/[0.07] hover:text-text-primary"
              >
                {tag}
                {onInsertTag
                  ? <Plus size={10} aria-hidden="true" className="opacity-50" />
                  : copied === tag
                  ? <Check size={10} aria-hidden="true" className="text-success" />
                  : <Copy size={10} aria-hidden="true" className="opacity-50" />}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
