export function SupertonicLanguageSettings({ language, onChange }: {
  language: string;
  onChange: (language: string) => void;
}) {
  return (
    <label className="block text-xs font-medium text-text-secondary">
      Supertonic 2 language
      <select aria-label="Supertonic 2 language" value={language} onChange={(event) => onChange(event.target.value)} className="mt-1 w-full rounded-lg border border-black/10 bg-white/55 px-3 py-2 text-sm text-text-primary">
        {Object.entries({ en: "English", ko: "Korean", es: "Spanish", pt: "Portuguese", fr: "French" }).map(([value, label]) => (
          <option key={value} value={value}>{label}</option>
        ))}
      </select>
    </label>
  );
}
