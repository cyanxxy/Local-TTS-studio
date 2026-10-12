import { useState, type FormEvent } from "react";
import { getEngine, isEngineId } from "../../models/registry";
import type { CatalogVoice } from "../../lib/voiceLibrary/catalog";
import type { VoicePresetSettings } from "../../lib/voiceLibrary/types";
import { inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from "./ui";

interface SavePresetFormProps {
  voice: CatalogVoice;
  onSave: (input: { name: string; settings: VoicePresetSettings }) => Promise<void>;
  onCancel: () => void;
}

function numberOrUndefined(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Save an engine voice with its settings as a preset. Only the settings the
 * engine honours are offered, taken from its capabilities.
 */
export function SavePresetForm({ voice, onSave, onCancel }: SavePresetFormProps) {
  const capabilities = isEngineId(voice.engineId) ? getEngine(voice.engineId).capabilities : null;
  const initial = voice.preset.settings;
  const [name, setName] = useState(voice.origin === "library" ? `${voice.name} copy` : voice.name);
  const [speed, setSpeed] = useState(initial.speed?.toString() ?? "");
  const [seed, setSeed] = useState(initial.seed?.toString() ?? "");
  const [instruction, setInstruction] = useState(initial.instruction ?? "");
  const [language, setLanguage] = useState(initial.language ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const idPrefix = `preset-${voice.key}`;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const settings: VoicePresetSettings = {};
    const speedValue = numberOrUndefined(speed);
    const seedValue = numberOrUndefined(seed);
    if (capabilities?.speed && speedValue !== undefined) settings.speed = speedValue;
    if (capabilities?.seed && seedValue !== undefined) settings.seed = seedValue;
    if (capabilities?.instruct && instruction.trim()) settings.instruction = instruction.trim();
    if (language.trim()) settings.language = language.trim();
    setSaving(true);
    setError(null);
    try {
      await onSave({ name, settings });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The preset could not be saved.");
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} aria-label={`Save preset for ${voice.name}`} className="mt-3 space-y-3 rounded-xl border border-border bg-text-primary/[0.03] p-3">
      <label className={labelClass} htmlFor={`${idPrefix}-name`}>
        Preset name
        <input id={`${idPrefix}-name`} value={name} maxLength={80} onChange={(event) => setName(event.target.value)} className={`mt-1 ${inputClass}`} />
      </label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {capabilities?.speed && (
          <label className={labelClass}>
            Speed
            <input aria-label="Speed" type="number" min={0.5} max={2} step={0.05} value={speed} placeholder="Default" onChange={(event) => setSpeed(event.target.value)} className={`mt-1 ${inputClass}`} />
          </label>
        )}
        {capabilities?.seed && (
          <label className={labelClass}>
            Seed
            <input aria-label="Seed" type="number" min={0} step={1} value={seed} placeholder="Random" onChange={(event) => setSeed(event.target.value)} className={`mt-1 ${inputClass}`} />
          </label>
        )}
        <label className={labelClass}>
          Language
          <input aria-label="Language" value={language} placeholder="Engine default" maxLength={32} onChange={(event) => setLanguage(event.target.value)} className={`mt-1 ${inputClass}`} />
        </label>
      </div>
      {capabilities?.instruct && (
        <label className={labelClass}>
          Style instruction
          <textarea aria-label="Style instruction" value={instruction} onChange={(event) => setInstruction(event.target.value)} className={`mt-1 min-h-16 ${inputClass}`} placeholder="Warm, calm, conversational…" />
        </label>
      )}
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className={primaryButtonClass} disabled={saving || name.trim().length === 0}>{saving ? "Saving…" : "Save preset"}</button>
        <button type="button" className={secondaryButtonClass} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
