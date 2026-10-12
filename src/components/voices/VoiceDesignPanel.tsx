import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Play, RefreshCw, Sparkles, Square } from "lucide-react";
import {
  DEFAULT_VOICE_DESIGN_PREVIEW_COUNT,
  createVoiceDesignPreviewSession,
  defaultVoiceDesignPreviewText,
  nextPreviewSeed,
  planVoiceDesignPreviews,
  renderVoiceDesignPreviews,
  saveSelectedPreview,
  voiceDesignPreviewReducer,
  type VoiceDesignPreviewAction,
  type VoiceDesignPreviewSession,
} from "../../lib/voiceDesignPreviews";
import type { PresetSynthesize } from "../../lib/presetSynthesis";
import type { VoiceRecord } from "../../lib/voiceLibrary/types";
import { encodeWavPcm16 } from "../../lib/wavCodec";
import { QWEN3_ENGINE_LANGUAGES, QWEN3_INSTRUCT_MAX_LENGTH } from "../../models/qwen3";
import { useAudition, type CreateAuditionAudio } from "../../hooks/useAudition";
import type { ApplyResult, ApplySurface } from "../../hooks/useVoiceApplier";
import type { UseVoiceLibraryReturn } from "../../hooks/useVoiceLibrary";
import { errorCalloutClass, infoCalloutClass, inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from "./ui";

export interface VoiceDesignPanelProps {
  library: Pick<UseVoiceLibraryReturn, "createVoices">;
  synthesize: PresetSynthesize;
  /** False while no Qwen3 VoiceDesign model is installed. */
  available: boolean;
  unavailableReason?: string;
  onUse?: (record: VoiceRecord, surface: ApplySurface) => Promise<ApplyResult>;
  createAudio?: CreateAuditionAudio;
}

type SessionState = VoiceDesignPreviewSession | null;
type SessionAction = VoiceDesignPreviewAction | { type: "start"; session: VoiceDesignPreviewSession } | { type: "replace"; session: VoiceDesignPreviewSession };

function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  if (action.type === "start" || action.type === "replace") return action.session;
  return state ? voiceDesignPreviewReducer(state, action) : state;
}

/**
 * Voice Design: describe a voice, audition three seeded renders of that
 * description, and save the one you like as a designed voice (optionally also
 * as a Qwen3 Base clone reference built from the same audio).
 */
export function VoiceDesignPanel({ library, synthesize, available, unavailableReason, onUse, createAudio }: VoiceDesignPanelProps) {
  const [description, setDescription] = useState("");
  const [language, setLanguage] = useState("English");
  const [previewText, setPreviewText] = useState(() => defaultVoiceDesignPreviewText("English"));
  const [textEdited, setTextEdited] = useState(false);
  const [session, dispatch] = useReducer(sessionReducer, null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [alsoClone, setAlsoClone] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ designed: VoiceRecord; cloned: VoiceRecord | null; warnings: string[] } | null>(null);
  const [useMessage, setUseMessage] = useState<ApplyResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const audition = useAudition(createAudio);

  useEffect(() => () => abortRef.current?.abort(), []);

  const render = useCallback(async (
    plan: VoiceDesignPreviewSession["plan"],
    requestIds?: readonly string[],
  ) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    try {
      await renderVoiceDesignPreviews({
        plan,
        synthesize,
        dispatch: (action) => { if (!controller.signal.aborted) dispatch(action); },
        signal: controller.signal,
        requestIds,
      });
    } catch (renderError) {
      if (!controller.signal.aborted) setError(renderError instanceof Error ? renderError.message : "The previews could not be rendered.");
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setBusy(false);
      }
    }
  }, [synthesize]);

  const generate = useCallback(async () => {
    setError(null);
    setSaved(null);
    setUseMessage(null);
    audition.stop();
    let plan;
    try {
      plan = planVoiceDesignPreviews({ description, language, previewText, count: DEFAULT_VOICE_DESIGN_PREVIEW_COUNT });
    } catch (planError) {
      setError(planError instanceof Error ? planError.message : "Check the description and try again.");
      return;
    }
    dispatch({ type: "start", session: createVoiceDesignPreviewSession(plan) });
    await render(plan);
  }, [audition, description, language, previewText, render]);

  const regenerate = useCallback(async (requestId: string) => {
    if (!session) return;
    audition.stop();
    setError(null);
    const next = voiceDesignPreviewReducer(session, { type: "regenerate", requestId, seed: nextPreviewSeed(session.plan) });
    dispatch({ type: "replace", session: next });
    const added = next.plan.requests.find((request) => !session.plan.requests.some((existing) => existing.id === request.id));
    if (added) await render(next.plan, [added.id]);
  }, [audition, render, session]);

  const togglePlay = useCallback((requestId: string) => {
    const result = session?.results[requestId];
    if (!result?.samples || !result.sampleRate) return;
    if (audition.playingKey === requestId) {
      audition.stop();
      return;
    }
    void audition.play(requestId, encodeWavPcm16(result.samples, result.sampleRate)).catch(() => {
      setError("The preview could not be played.");
    });
  }, [audition, session]);

  const save = useCallback(async () => {
    if (!session) return;
    setSaving(true);
    setError(null);
    try {
      const outcome = await saveSelectedPreview(library, session, { name, alsoClone });
      setSaved({ designed: outcome.designed, cloned: outcome.cloned, warnings: outcome.warnings.map((check) => check.message) });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The voice could not be saved.");
    } finally {
      setSaving(false);
    }
  }, [alsoClone, library, name, session]);

  const applyTo = useCallback(async (surface: ApplySurface) => {
    if (!saved || !onUse) return;
    setUseMessage(await onUse(saved.designed, surface));
  }, [onUse, saved]);

  const selectedReady = session?.selectedId != null && session.results[session.selectedId]?.status === "ready";

  return (
    <section aria-label="Voice design" className="space-y-5">
      <p className="text-sm text-text-secondary">
        Describe the voice you want. Open TTS renders three previews with different seeds so you can pick the one that sounds right.
      </p>
      {!available && (
        <p className={infoCalloutClass}>{unavailableReason ?? "Install the Qwen3 VoiceDesign model in Qwen3 model setup to design voices."}</p>
      )}
      <label className={labelClass}>
        Voice description
        <textarea
          aria-label="Voice description"
          value={description}
          maxLength={QWEN3_INSTRUCT_MAX_LENGTH}
          onChange={(event) => setDescription(event.target.value)}
          className={`mt-1 min-h-24 ${inputClass}`}
          placeholder="A warm, low, reassuring narrator with measured pacing…"
        />
      </label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className={labelClass}>
          Language
          <select
            aria-label="Design language"
            value={language}
            onChange={(event) => {
              setLanguage(event.target.value);
              if (!textEdited) setPreviewText(defaultVoiceDesignPreviewText(event.target.value));
            }}
            className={`mt-1 ${inputClass}`}
          >
            {QWEN3_ENGINE_LANGUAGES.filter((option) => option !== "Auto").map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <label className={`${labelClass} sm:col-span-2`}>
          Preview sentence
          <input
            aria-label="Preview sentence"
            value={previewText}
            onChange={(event) => { setPreviewText(event.target.value); setTextEdited(true); }}
            className={`mt-1 ${inputClass}`}
          />
        </label>
      </div>
      <button type="button" className={primaryButtonClass} disabled={!available || busy || description.trim().length === 0} onClick={() => void generate()}>
        <Sparkles size={14} aria-hidden /> {session ? "Generate new previews" : "Generate 3 previews"}
      </button>

      {error && <p role="alert" className={errorCalloutClass}>{error}</p>}

      {session && (
        <fieldset className="space-y-2" disabled={saving}>
          <legend className={labelClass}>Previews</legend>
          <ul className="space-y-2">
            {session.plan.requests.map((request, index) => {
              const result = session.results[request.id];
              const ready = result?.status === "ready";
              return (
                <li key={request.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-text-primary/[0.03] p-3">
                  <label className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                    <input
                      type="radio"
                      name="design-preview"
                      aria-label={`Choose preview ${index + 1}`}
                      checked={session.selectedId === request.id}
                      disabled={!ready}
                      onChange={() => dispatch({ type: "select", requestId: request.id })}
                    />
                    Preview {index + 1}
                  </label>
                  <span className="font-mono text-xs text-text-muted">seed {request.seed}</span>
                  <span className="text-xs text-text-secondary" aria-live="polite">
                    {result?.status === "rendering" ? "Rendering…" : result?.status === "pending" ? "Waiting…" : result?.status === "failed" ? result.error : ready && result.firstAudioMs != null ? `Ready · first audio in ${(result.firstAudioMs / 1000).toFixed(1)} s` : "Ready"}
                  </span>
                  <span className="ml-auto flex gap-2">
                    <button type="button" className={secondaryButtonClass} disabled={!ready} aria-label={`${audition.playingKey === request.id ? "Stop" : "Play"} preview ${index + 1}`} onClick={() => togglePlay(request.id)}>
                      {audition.playingKey === request.id ? <Square size={14} aria-hidden /> : <Play size={14} aria-hidden />}
                    </button>
                    <button type="button" className={secondaryButtonClass} disabled={busy || result?.status === "rendering"} aria-label={`New seed for preview ${index + 1}`} onClick={() => void regenerate(request.id)}>
                      <RefreshCw size={14} aria-hidden />
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}

      {selectedReady && !saved && (
        <div className="space-y-3 rounded-2xl border border-border bg-text-primary/[0.03] p-4">
          <label className={labelClass}>
            Voice name
            <input aria-label="Designed voice name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} className={`mt-1 ${inputClass}`} />
          </label>
          <label className="flex items-start gap-2 text-xs font-medium text-text-secondary">
            <input type="checkbox" checked={alsoClone} onChange={(event) => setAlsoClone(event.target.checked)} className="mt-0.5" />
            <span>
              Also save as a Qwen3 Base clone reference
              <span className="block font-normal text-text-muted">Keeps this exact sample as a reference, so the voice stays the same across sessions.</span>
            </span>
          </label>
          <button type="button" className={primaryButtonClass} disabled={saving || name.trim().length === 0} onClick={() => void save()}>
            {saving ? "Saving…" : "Save voice"}
          </button>
        </div>
      )}

      {saved && (
        <div className="space-y-3">
          <p role="status" className={infoCalloutClass}>
            Saved “{saved.designed.name}” to My Voices{saved.cloned ? ", with a Qwen3 Base clone of the same sample" : ""}.
          </p>
          {saved.warnings.map((warning) => <p key={warning} className="text-xs text-text-muted">{warning}</p>)}
          {onUse && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className={primaryButtonClass} onClick={() => void applyTo("studio")}>Use in Studio</button>
              <button type="button" className={secondaryButtonClass} onClick={() => void applyTo("reader")}>Use in Reader</button>
            </div>
          )}
          {useMessage && <p role="status" className={useMessage.ok ? infoCalloutClass : errorCalloutClass}>{useMessage.message}</p>}
        </div>
      )}
    </section>
  );
}
