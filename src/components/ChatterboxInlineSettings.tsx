import { useId, useState } from "react";
import { Check, Copy, X } from "lucide-react";
import { CHATTERBOX_TAG_TOKENS } from "../lib/chatterboxTags";
import {
  CHATTERBOX_DOWNLOAD_BYTES,
  CHATTERBOX_MAX_SEED,
  CHATTERBOX_TEMPERATURE_RANGE,
  type ChatterboxSettings,
} from "../models/chatterbox";
import type { ModelState } from "../types";

interface ChatterboxInlineSettingsProps {
  settings: ChatterboxSettings;
  onChange: (patch: Partial<Pick<ChatterboxSettings, "temperature" | "seed">>) => void;
  modelState: ModelState;
}

/**
 * Chatterbox's sampling controls and tags, with the plain facts about its cost:
 * a large first-use download and generation slower than playback.
 */
export function ChatterboxInlineSettings({ settings, onChange, modelState }: ChatterboxInlineSettingsProps) {
  const temperatureId = useId();
  const seedId = useId();
  const [copied, setCopied] = useState<string | null>(null);
  const downloadLabel = `${(CHATTERBOX_DOWNLOAD_BYTES / 1e9).toFixed(1)} GB`;

  const copyTag = (tag: string) => {
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

      <div>
        <label htmlFor={seedId} className="text-xs font-medium text-text-secondary">Seed</label>
        <div className="mt-1 flex items-center gap-2">
          <input
            id={seedId}
            type="number"
            min={0}
            max={CHATTERBOX_MAX_SEED}
            step={1}
            placeholder="Random each time"
            value={settings.seed ?? ""}
            onChange={(event) => {
              const next = event.target.valueAsNumber;
              onChange({ seed: Number.isInteger(next) && next >= 0 && next <= CHATTERBOX_MAX_SEED ? next : null });
            }}
            className="w-full rounded-lg border border-black/10 bg-text-primary/[0.06] px-3 py-1.5 text-sm text-text-primary"
          />
          {settings.seed !== null && (
            <button
              type="button"
              aria-label="Use a random seed"
              title="Use a random seed"
              onClick={() => onChange({ seed: null })}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border text-text-muted hover:text-text-primary"
            >
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>
        <p className="mt-1 text-2xs leading-4 text-text-muted">A fixed seed repeats the same delivery for the same text and voice.</p>
      </div>

      <div>
        <p className="text-xs font-medium text-text-secondary">Expression tags</p>
        <p className="mt-0.5 text-2xs leading-4 text-text-muted">
          Type a tag in square brackets where it should happen, for example “That is hilarious [laugh]”. Any other
          bracketed direction is skipped, not read aloud. Select a tag to copy it.
        </p>
        <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Supported tags">
          {CHATTERBOX_TAG_TOKENS.map((tag) => (
            <li key={tag}>
              <button
                type="button"
                onClick={() => copyTag(tag)}
                aria-label={`Copy ${tag}`}
                className="flex items-center gap-1 rounded-full border border-border bg-text-primary/[0.03] px-2 py-0.5 font-mono text-2xs text-text-secondary transition-colors hover:bg-text-primary/[0.07] hover:text-text-primary"
              >
                {tag}
                {copied === tag
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
