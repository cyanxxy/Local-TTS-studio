import { useQwen3Runtime } from "../contexts/Qwen3RuntimeContext";
import { QWEN3_MAX_NEW_TOKENS_PER_PASSAGE, QWEN3_MAX_SEED, QWEN3_MIN_NEW_TOKENS } from "../../electron/localTtsLimits";
import {
  QWEN3_LANGUAGE_OPTIONS,
  QWEN3_SPEAKER_OPTIONS,
  qwen3SupportsInstruct,
} from "./localRuntime/modelOptions";

export function Qwen3InlineSettings({ onOpenSetup }: { onOpenSetup?: () => void }) {
  const qwen = useQwen3Runtime();
  const voiceClone = qwen.profile.mode === "voiceClone";
  const voiceDesign = qwen.profile.mode === "voiceDesign";
  const profileReadiness = new Map(qwen.setup?.profiles.map((profile) => [profile.repo, profile.readiness]) ?? []);
  const inputClass = "w-full rounded-lg border border-black/10 bg-text-primary/[0.06] px-3 py-2 text-sm text-text-primary";

  return (
    <section aria-label="Qwen3 voice settings" className="space-y-3 rounded-2xl border border-border bg-text-primary/[0.03] p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-text-secondary">Qwen voice</p>
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
          {qwen.profiles.map((profile) => {
            const readiness = profileReadiness.get(profile.repo) ?? "missing";
            return (
              <option key={profile.repo} value={profile.repo} disabled={readiness === "missing"}>
                {profile.label}{readiness === "missing" ? " · download in Model setup" : ""}
              </option>
            );
          })}
        </select>
      </label>

      {qwen.readiness === "missing" && (
        <div className="rounded-lg border border-danger/20 bg-danger-light/70 px-3 py-2 text-xs text-danger">
          <p>This profile is not installed.</p>
          {onOpenSetup && (
            <button type="button" onClick={onOpenSetup} className="mt-1 font-semibold underline underline-offset-2">
              Open Model setup to download it
            </button>
          )}
        </div>
      )}

      {!voiceClone && !voiceDesign && (
        <fieldset>
          <legend className="text-xs font-medium text-text-secondary">Exact speaker</legend>
          <div className="mt-1.5 grid grid-cols-3 gap-1.5">
            {QWEN3_SPEAKER_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-label={option.value}
                aria-pressed={qwen.speaker === option.value}
                onClick={() => qwen.setSpeaker(option.value)}
                className={`min-w-0 rounded-lg border px-2 py-2 text-xs font-semibold transition-colors ${
                  qwen.speaker === option.value
                    ? "border-accent/45 bg-accent/10 text-accent shadow-accent-sm"
                    : "border-border bg-text-primary/[0.04] text-text-secondary hover:bg-text-primary/[0.07] hover:text-text-primary"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-2xs leading-4 text-text-muted">
            Best quality comes from matching the language to the voice: Aiden or Ryan for English.
          </p>
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
          {qwen.referenceAudioDurationSec !== null && qwen.referenceAudioDurationSec < 3 && (
            <span className="mt-1 block text-danger">
              This clip is only {qwen.referenceAudioDurationSec.toFixed(1)} s. Cloning works best with 3-20 seconds of clear speech.
            </span>
          )}
        </p>
      )}

      {voiceDesign && (
        <label className="block text-xs font-medium text-text-secondary">
          Voice description
          <textarea aria-label="Qwen voice description" value={qwen.instruct} onChange={(event) => qwen.setInstruct(event.target.value)} className={`mt-1 min-h-20 ${inputClass}`} placeholder="A warm, low, reassuring narrator with measured pacing…" />
        </label>
      )}

      <details className="group">
        <summary className="cursor-pointer text-xs font-semibold text-text-secondary">Advanced voice controls</summary>
        <div className="mt-3 space-y-3">
          {!voiceDesign && qwen3SupportsInstruct(qwen.profile.repo) && (
            <label className="block text-xs font-medium text-text-secondary">
              Voice instruction
              <textarea aria-label="Qwen voice instruction" value={qwen.instruct} onChange={(event) => qwen.setInstruct(event.target.value)} className={`mt-1 min-h-16 ${inputClass}`} placeholder="Warm, calm, conversational…" />
            </label>
          )}
          <div className="grid grid-cols-3 gap-2">
            <label className="text-xs text-text-secondary">Temperature<input aria-label="Qwen temperature" type="number" min={0.2} max={2} step={0.05} value={qwen.temperature} onChange={(event) => qwen.setTemperature(Number(event.target.value))} className={`mt-1 ${inputClass}`} /></label>
            <label className="text-xs text-text-secondary">Top-k<input aria-label="Qwen top-k" type="number" min={0} max={1000} step={1} value={qwen.topK} onChange={(event) => qwen.setTopK(Number(event.target.value))} className={`mt-1 ${inputClass}`} /></label>
            <label className="text-xs text-text-secondary">Max tokens per passage<input aria-label="Qwen max tokens per passage" type="number" min={QWEN3_MIN_NEW_TOKENS} max={QWEN3_MAX_NEW_TOKENS_PER_PASSAGE} step={32} value={qwen.maxNewTokens} onChange={(event) => qwen.setMaxNewTokens(Number(event.target.value))} className={`mt-1 ${inputClass}`} /></label>
          </div>
          <p className="text-2xs leading-4 text-text-muted">
            Qwen speaks text in passages of about 200 characters (about 100 for Chinese, Japanese, or Korean). Each passage stops at {QWEN3_MAX_NEW_TOKENS_PER_PASSAGE} tokens, about 30 seconds of speech.
          </p>
          <label className="block text-xs text-text-secondary">
            Seed (optional)
            <input aria-label="Qwen seed" type="number" min={0} max={QWEN3_MAX_SEED} step={1} value={qwen.seed ?? ""} placeholder="Random" onChange={(event) => qwen.setSeed(event.target.value === "" ? null : Number(event.target.value))} className={`mt-1 ${inputClass}`} />
            <span className="mt-1 block text-2xs leading-4 text-text-muted">Reuse a seed to repeat a take. Leave it empty for a fresh variation each time.</span>
          </label>
        </div>
      </details>
    </section>
  );
}
