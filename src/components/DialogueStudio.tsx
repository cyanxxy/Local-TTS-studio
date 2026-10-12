import { useCallback, useEffect, useId, useMemo, useRef } from "react";
import { AlertTriangle, Download, Loader2, Play, RefreshCw, Square, Subtitles, Users } from "lucide-react";
import { useDialogueSession, type UseDialogueSessionReturn } from "../hooks/useDialogueSession";
import { formatClock } from "../lib/formatClock";
import type { PresetSynthesize } from "../lib/presetSynthesis";
import { createRuntimeSynthesize, presetFromSelection, type SynthesisBase } from "../lib/studioSynthesis";
import type { VoicePreset } from "../lib/voiceLibrary/types";
import { engineVoices, getEngine, type SurfaceEngineId } from "../models/registry";
import type { EngineVoice } from "../models/types";
import { useSynthesisSession } from "../shared/synthesisSessionContext";

const PLACEHOLDER = "Narrator: It was a quiet morning.\nAnna: [cheerful] Did you hear that?\nBen: (looking up) Hear what?";

const SELECT_CLASS = "w-full rounded-lg border border-black/10 bg-text-primary/[0.06] px-2.5 py-2 text-xs text-text-primary";
const SECONDARY_BUTTON = "flex items-center gap-1.5 rounded-full bg-text-primary/[0.08] px-3.5 py-2 text-xs font-semibold text-text-primary transition-colors hover:bg-text-primary/[0.14] disabled:opacity-50";

export interface CastableEngine {
  id: SurfaceEngineId;
  label: string;
}

interface DialogueStudioViewProps {
  dialogue: UseDialogueSessionReturn;
  castableEngines: readonly CastableEngine[];
  voicesFor: (engineId: SurfaceEngineId) => readonly EngineVoice[];
}

/** The script editor, casting, render controls and exports of a dialogue. */
export function DialogueStudioView({ dialogue, castableEngines, voicesFor }: DialogueStudioViewProps) {
  const ids = useId();
  const scriptId = `${ids}-script`;
  const issuesId = `${ids}-issues`;
  const rendering = dialogue.status === "rendering";
  const busy = rendering || dialogue.regeneratingTurn !== null;
  const canRender = dialogue.plan !== null && !busy;
  const total = dialogue.plan?.steps.length ?? 0;
  const renderedCount = dialogue.turns.size;

  const chooseVoice = (speakerKey: string, engineId: SurfaceEngineId, voiceId: string) => {
    const voice = voicesFor(engineId).find((entry) => entry.id === voiceId);
    const preset: VoicePreset = { engineId, voiceId, settings: {}, ...(voice ? { label: voice.label } : {}) };
    dialogue.castSpeaker(speakerKey, preset);
  };

  const statusMessage = rendering && dialogue.progress
    ? `Rendering line ${dialogue.progress.position} of ${dialogue.progress.total}.`
    : dialogue.regeneratingTurn !== null
      ? `Regenerating line ${dialogue.regeneratingTurn + 1}.`
      : dialogue.status === "done"
        ? `Dialogue rendered: ${renderedCount} lines.`
        : dialogue.status === "cancelled"
          ? `Render cancelled after ${renderedCount} of ${total} lines.`
          : dialogue.status === "error"
            ? "Dialogue render failed."
            : "";

  return (
    <div className="mt-6 surface rounded-[24px]">
      <p role="status" aria-live="polite" className="sr-only">{statusMessage}</p>
      <div className="grid grid-cols-1 md:grid-cols-5">
        <div className="flex min-h-[320px] flex-col border-border/40 p-4 sm:p-6 md:col-span-3 md:border-r">
          <label htmlFor={scriptId} className="mb-3 text-sm font-semibold text-text-secondary">Dialogue script</label>
          <textarea
            id={scriptId}
            className="min-h-[220px] w-full flex-1 resize-none bg-transparent font-sans text-lg leading-relaxed text-text-primary outline-none placeholder:text-text-muted/50"
            placeholder={PLACEHOLDER}
            value={dialogue.source}
            spellCheck={false}
            aria-describedby={dialogue.issues.length > 0 ? issuesId : undefined}
            onChange={(event) => dialogue.setSource(event.target.value)}
          />
          <p className="mt-2 text-xs text-text-muted">
            Start a line with a speaker name and a colon. [Tags] shape delivery and (directions) are not spoken.
          </p>
          {dialogue.issues.length > 0 && (
            <ul id={issuesId} aria-label="Script issues" className="mt-3 flex flex-col gap-1">
              {dialogue.issues.map((issue, index) => (
                <li key={`${issue.line}-${index}`} className="flex items-start gap-2 text-xs text-warning">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
                  <span>Line {issue.line}: {issue.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-col gap-5 border-t border-border/40 p-4 sm:p-6 md:col-span-2 md:border-t-0">
          <section aria-label="Cast">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-text-secondary">
                <Users size={14} aria-hidden="true" />
                Cast
              </h2>
              <button type="button" className="text-xs font-semibold text-accent disabled:opacity-50" disabled={dialogue.speakers.length === 0} onClick={dialogue.autoCast}>
                Auto-cast
              </button>
            </div>
            {dialogue.speakers.length === 0 ? (
              <p className="text-xs text-text-muted">Speakers appear here as you write lines.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {dialogue.speakers.map((speaker) => {
                  const preset = dialogue.casting[speaker.key];
                  const engineId = (preset?.engineId ?? castableEngines[0]?.id) as SurfaceEngineId;
                  const voices = voicesFor(engineId);
                  return (
                    <li key={speaker.key} className="rounded-xl border border-black/5 p-3">
                      <p className="text-sm font-semibold text-text-primary">
                        {speaker.name}
                        <span className="ml-2 font-normal text-text-muted">{speaker.turnCount} {speaker.turnCount === 1 ? "line" : "lines"}</span>
                      </p>
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <select
                          aria-label={`Engine for ${speaker.name}`}
                          className={SELECT_CLASS}
                          value={engineId}
                          onChange={(event) => {
                            const next = event.target.value as SurfaceEngineId;
                            const first = voicesFor(next)[0];
                            chooseVoice(speaker.key, next, first?.id ?? "");
                          }}
                        >
                          {castableEngines.map((engine) => (
                            <option key={engine.id} value={engine.id}>{engine.label}</option>
                          ))}
                        </select>
                        <select
                          aria-label={`Voice for ${speaker.name}`}
                          className={SELECT_CLASS}
                          value={preset?.voiceId ?? ""}
                          onChange={(event) => chooseVoice(speaker.key, engineId, event.target.value)}
                        >
                          {!voices.some((voice) => voice.id === preset?.voiceId) && (
                            <option value={preset?.voiceId ?? ""}>{preset?.label ?? preset?.voiceId ?? "Choose a voice"}</option>
                          )}
                          {voices.map((voice) => (
                            <option key={voice.id} value={voice.id}>{voice.label}</option>
                          ))}
                        </select>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section aria-label="Pauses" className="grid grid-cols-2 gap-3">
            <label className="text-xs font-medium text-text-secondary">
              Between speakers
              <input
                type="number"
                min={0}
                max={5}
                step={0.05}
                className={`${SELECT_CLASS} mt-1`}
                aria-invalid={dialogue.gapProblem !== null}
                value={dialogue.gaps.speakerChangeGapSec}
                onChange={(event) => dialogue.setGaps({ speakerChangeGapSec: Number(event.target.value) })}
              />
            </label>
            <label className="text-xs font-medium text-text-secondary">
              Within a speaker
              <input
                type="number"
                min={0}
                max={5}
                step={0.05}
                className={`${SELECT_CLASS} mt-1`}
                aria-invalid={dialogue.gapProblem !== null}
                value={dialogue.gaps.sameSpeakerGapSec}
                onChange={(event) => dialogue.setGaps({ sameSpeakerGapSec: Number(event.target.value) })}
              />
            </label>
          </section>
          {dialogue.gapProblem && <p role="alert" className="-mt-3 text-xs text-danger">{dialogue.gapProblem}</p>}

          <div className="flex flex-col gap-2">
            {rendering ? (
              <button type="button" onClick={dialogue.cancel} className={SECONDARY_BUTTON}>
                <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                Cancel{dialogue.progress ? ` (turn ${dialogue.progress.position} of ${dialogue.progress.total})` : ""}
              </button>
            ) : (
              <button
                type="button"
                disabled={!canRender}
                onClick={() => void dialogue.render()}
                className="rounded-full bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-opacity disabled:opacity-50"
              >
                Render dialogue
              </button>
            )}
            {dialogue.plan === null && dialogue.gapProblem === null && dialogue.uncastSpeakers.length > 0 && (
              <p className="text-xs text-text-muted">Choose a voice for {dialogue.uncastSpeakers.map((speaker) => speaker.name).join(", ")}.</p>
            )}
            {rendering && dialogue.progress && (
              <div
                role="progressbar"
                aria-label="Dialogue render progress"
                aria-valuemin={0}
                aria-valuemax={dialogue.progress.total}
                aria-valuenow={renderedCount}
                className="h-1 overflow-hidden rounded-full bg-text-primary/10"
              >
                <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${(renderedCount / Math.max(1, dialogue.progress.total)) * 100}%` }} />
              </div>
            )}
            {dialogue.status === "cancelled" && (
              <p className="text-xs text-text-muted">Cancelled after {renderedCount} of {total} lines. Finished lines are kept; render again to redo all.</p>
            )}
            {dialogue.error && (
              <p role="alert" className="rounded-lg border border-danger/30 bg-danger-light px-3 py-2 text-xs text-danger">{dialogue.error}</p>
            )}
          </div>
        </div>
      </div>

      {dialogue.plan && renderedCount > 0 && (
        <div className="border-t border-border/40 p-4 sm:p-6">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="mr-auto text-sm font-semibold text-text-secondary">
              Lines{dialogue.stitched ? ` · ${formatClock(dialogue.stitched.durationSec)}` : ""}
            </h2>
            <button
              type="button"
              className={SECONDARY_BUTTON}
              disabled={!dialogue.stitched}
              onClick={dialogue.playing ? dialogue.stopPlayback : dialogue.play}
            >
              {dialogue.playing ? <Square size={13} aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}
              {dialogue.playing ? "Stop" : "Play"}
            </button>
            <button type="button" className={SECONDARY_BUTTON} disabled={!dialogue.stitched || busy} onClick={() => void dialogue.exportAudio()}>
              <Download size={13} aria-hidden="true" />
              Export audio
            </button>
            <button type="button" className={SECONDARY_BUTTON} disabled={!dialogue.stitched} onClick={() => dialogue.downloadCaptions("vtt")}>
              <Subtitles size={13} aria-hidden="true" />
              VTT
            </button>
            <button type="button" className={SECONDARY_BUTTON} disabled={!dialogue.stitched} onClick={() => dialogue.downloadCaptions("srt")}>
              <Subtitles size={13} aria-hidden="true" />
              SRT
            </button>
          </div>
          <ol className="flex flex-col gap-1" aria-label="Rendered lines">
            {dialogue.plan.steps.map((step) => {
              const turn = dialogue.turns.get(step.turnIndex);
              const outdated = dialogue.outdatedTurns.has(step.turnIndex);
              const regenerating = dialogue.regeneratingTurn === step.turnIndex;
              return (
                <li key={step.turnIndex} className="flex items-center gap-3 rounded-xl px-2 py-1.5 hover:bg-text-primary/[0.04]">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-text-primary">
                      <span className="font-semibold">{step.speaker}:</span> {step.text}
                    </p>
                    <p className="text-xs text-text-muted">
                      {turn ? `${formatClock(turn.samples.length / turn.sampleRate)}` : "Not rendered"}
                      {outdated && " · edited since rendering"}
                    </p>
                  </div>
                  <button
                    type="button"
                    className={SECONDARY_BUTTON}
                    disabled={busy}
                    aria-label={`${turn ? "Regenerate" : "Render"} line ${step.turnIndex + 1}`}
                    onClick={() => void dialogue.regenerateTurn(step.turnIndex)}
                  >
                    {regenerating ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
                    {turn ? "Regenerate" : "Render"}
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}

/** Dialogue mode of Studio, wired to the shared session's engines. */
export function DialogueStudio() {
  const session = useSynthesisSession();
  const { engines, creator, studio, environment } = session;
  const base = useMemo<SynthesisBase>(
    () => ({ settings: engines.surfaceEngineSettings, tuning: creator.generationSettings }),
    [creator.generationSettings, engines.surfaceEngineSettings],
  );
  const sourceRef = useRef({ runtimes: engines.runtimes, base });
  useEffect(() => {
    sourceRef.current = { runtimes: engines.runtimes, base };
  });
  const synthesize = useCallback<PresetSynthesize>(
    (text, preset, signal) => createRuntimeSynthesize(
      () => sourceRef.current.runtimes,
      () => sourceRef.current.base,
    )(text, preset, signal),
    [],
  );

  const castableEngines = useMemo<CastableEngine[]>(() => {
    const ids: SurfaceEngineId[] = [
      ...environment.browserSupport.supportedModels,
      ...engines.desktopModelOptions.studio.map((option) => option.key),
    ];
    return ids.map((id) => ({ id, label: getEngine(id).label }));
  }, [engines.desktopModelOptions.studio, environment.browserSupport.supportedModels]);

  const kokoroVoices = engines.kokoroVoices;
  const voicesFor = useMemo(
    () => (engineId: SurfaceEngineId) => engineVoices(engineId, engineId === "kokoro" ? { runtimeVoices: kokoroVoices } : undefined),
    [kokoroVoices],
  );

  const voicePool = useMemo<VoicePreset[]>(() => {
    const selected = presetFromSelection(studio.engineId, base);
    const voices = voicesFor(studio.engineId);
    if (voices.length === 0) return [selected];
    // Studio's own voice leads, so a one-speaker script sounds like Studio.
    return [selected, ...voices.filter((voice) => voice.id !== selected.voiceId).map((voice): VoicePreset => ({
      engineId: studio.engineId,
      voiceId: voice.id,
      settings: {},
      label: voice.label,
    }))];
  }, [base, studio.engineId, voicesFor]);

  const dialogue = useDialogueSession({ synthesize, exportOptions: creator.exportOptions, voicePool });
  return <DialogueStudioView dialogue={dialogue} castableEngines={castableEngines} voicesFor={voicesFor} />;
}
