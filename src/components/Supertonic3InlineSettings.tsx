import { SUPERTONIC3_LANGUAGES, SUPERTONIC3_VOICES } from "../constants";
import { SUPERTONIC3_LANGUAGE_NAMES } from "../models/supertonic3";
import { SeedField } from "./SeedField";

interface Props {
  voice: string;
  language: string;
  onVoiceChange: (voice: string) => void;
  onLanguageChange: (language: string) => void;
  seed: number | null;
  onSeedChange: (seed: number | null) => void;
}

export function Supertonic3InlineSettings({ voice, language, onVoiceChange, onLanguageChange, seed, onSeedChange }: Props) {
  const inputClass = "w-full rounded-lg border border-border bg-text-primary/[0.06] px-3 py-2 text-sm text-text-primary";
  return (
    <section aria-label="Supertonic 3 voice settings" className="space-y-3 rounded-2xl border border-border bg-text-primary/[0.03] p-3">
      <div>
        <p className="text-sm font-semibold text-text-secondary">Supertonic 3 voice</p>
        <p className="mt-0.5 text-xs text-text-muted">31 languages, local ONNX inference, and expression tags such as &lt;laugh&gt;.</p>
      </div>
      <label className="block text-xs font-medium text-text-secondary">
        Preset voice
        <select aria-label="Supertonic 3 voice" value={voice} onChange={(event) => onVoiceChange(event.target.value)} className={`mt-1 ${inputClass}`}>
          {SUPERTONIC3_VOICES.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>
      <label className="block text-xs font-medium text-text-secondary">
        Language
        <select aria-label="Supertonic 3 language" value={language} onChange={(event) => onLanguageChange(event.target.value)} className={`mt-1 ${inputClass}`}>
          {SUPERTONIC3_LANGUAGES.map((option) => <option key={option} value={option}>{SUPERTONIC3_LANGUAGE_NAMES[option]} · {option}</option>)}
        </select>
      </label>
      <SeedField seed={seed} onChange={onSeedChange} />
    </section>
  );
}
