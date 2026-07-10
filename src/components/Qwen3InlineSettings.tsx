import { useQwen3Runtime } from "../contexts/Qwen3RuntimeContext";
import { QWEN3_LANGUAGE_OPTIONS, QWEN3_SPEAKER_OPTIONS } from "./localRuntime/modelOptions";

export function Qwen3InlineSettings({ onOpenSetup }: { onOpenSetup?: () => void }) {
  const qwen = useQwen3Runtime();
  const voiceClone = qwen.profile.mode === "voiceClone";
  const inputClass = "w-full rounded-lg border border-black/10 bg-white/55 px-3 py-2 text-sm text-text-primary backdrop-blur-sm";

  return (
    <section aria-label="Qwen3 voice settings" className="space-y-3 rounded-2xl border border-white/50 bg-white/25 p-3 shadow-glass-sm backdrop-blur-md">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-text-muted">Qwen voice</p>
          <p className="mt-0.5 text-xs text-text-muted">Shared across Studio, Reader, and Qwen3-TTS.</p>
        </div>
        {onOpenSetup && (
          <button type="button" onClick={onOpenSetup} className="shrink-0 text-xs font-semibold text-accent hover:underline">
            Model setup
          </button>
        )}
      </div>

      <label className="block text-xs font-medium text-text-secondary">
        Profile
        <select aria-label="Qwen profile" value={qwen.profile.repo} onChange={(event) => qwen.setProfileRepo(event.target.value)} className={`mt-1 ${inputClass}`}>
          {qwen.profiles.map((profile) => <option key={profile.repo} value={profile.repo}>{profile.label}</option>)}
        </select>
      </label>

      {!voiceClone && (
        <fieldset>
          <legend className="text-xs font-medium text-text-secondary">Exact speaker</legend>
          <div className="mt-1.5 grid grid-cols-3 gap-1.5">
            {QWEN3_SPEAKER_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={qwen.speaker === option.value}
                onClick={() => qwen.setSpeaker(option.value)}
                className={`min-w-0 rounded-lg border px-2 py-2 text-xs font-semibold transition-colors ${
                  qwen.speaker === option.value
                    ? "border-accent/45 bg-accent/10 text-accent shadow-accent-sm"
                    : "border-white/55 bg-white/40 text-text-secondary hover:bg-white/65 hover:text-text-primary"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block text-xs font-medium text-text-secondary">
          Language
          <select aria-label="Qwen language" value={qwen.language} onChange={(event) => qwen.setLanguage(event.target.value)} className={`mt-1 ${inputClass}`}>
            {QWEN3_LANGUAGE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
      </div>

      {voiceClone && (
        <p className="rounded-lg border border-accent/20 bg-accent-light/40 px-3 py-2 text-xs text-text-secondary">
          Voice-clone reference: {qwen.referenceAudioName || "not selected"}. Use Model setup to choose the WAV and exact transcript.
        </p>
      )}

      <details className="group">
        <summary className="cursor-pointer text-xs font-semibold text-text-secondary">Advanced voice controls</summary>
        <div className="mt-3 space-y-3">
          {!voiceClone && (
            <label className="block text-xs font-medium text-text-secondary">
              Voice instruction
              <textarea aria-label="Qwen voice instruction" value={qwen.instruct} onChange={(event) => qwen.setInstruct(event.target.value)} className={`mt-1 min-h-16 ${inputClass}`} placeholder="Warm, calm, conversational…" />
            </label>
          )}
          <div className="grid grid-cols-3 gap-2">
            <label className="text-xs text-text-secondary">Temperature<input aria-label="Qwen temperature" type="number" min={0.2} max={2} step={0.05} value={qwen.temperature} onChange={(event) => qwen.setTemperature(Number(event.target.value))} className={`mt-1 ${inputClass}`} /></label>
            <label className="text-xs text-text-secondary">Top-k<input aria-label="Qwen top-k" type="number" min={0} max={1000} step={1} value={qwen.topK} onChange={(event) => qwen.setTopK(Number(event.target.value))} className={`mt-1 ${inputClass}`} /></label>
            <label className="text-xs text-text-secondary">Max tokens<input aria-label="Qwen max tokens" type="number" min={64} max={8192} step={64} value={qwen.maxNewTokens} onChange={(event) => qwen.setMaxNewTokens(Number(event.target.value))} className={`mt-1 ${inputClass}`} /></label>
          </div>
        </div>
      </details>
    </section>
  );
}
