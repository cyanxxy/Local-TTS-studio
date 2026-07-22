import { SUPERTONIC3_LANGUAGES, SUPERTONIC3_VOICES } from "../constants";

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English", ko: "Korean", ja: "Japanese", ar: "Arabic", bg: "Bulgarian", cs: "Czech",
  da: "Danish", de: "German", el: "Greek", es: "Spanish", et: "Estonian", fi: "Finnish",
  fr: "French", hi: "Hindi", hr: "Croatian", hu: "Hungarian", id: "Indonesian", it: "Italian",
  lt: "Lithuanian", lv: "Latvian", nl: "Dutch", pl: "Polish", pt: "Portuguese", ro: "Romanian",
  ru: "Russian", sk: "Slovak", sl: "Slovenian", sv: "Swedish", tr: "Turkish", uk: "Ukrainian", vi: "Vietnamese",
};

interface Props {
  voice: string;
  language: string;
  onVoiceChange: (voice: string) => void;
  onLanguageChange: (language: string) => void;
}

export function Supertonic3InlineSettings({ voice, language, onVoiceChange, onLanguageChange }: Props) {
  const inputClass = "w-full rounded-lg border border-black/10 bg-white/55 px-3 py-2 text-sm text-text-primary backdrop-blur-sm";
  return (
    <section aria-label="Supertonic 3 voice settings" className="space-y-3 rounded-2xl border border-white/50 bg-white/25 p-3 shadow-glass-sm backdrop-blur-md">
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-text-muted">Supertonic 3 voice</p>
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
          {SUPERTONIC3_LANGUAGES.map((option) => <option key={option} value={option}>{LANGUAGE_NAMES[option]} · {option}</option>)}
        </select>
      </label>
    </section>
  );
}
