import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, ArrowRight, Check, CheckCircle2, Mic, Play, Scissors, Square, Upload, XCircle } from "lucide-react";
import { MAX_REFERENCE_WAV_BYTES, REFERENCE_TARGET_LABELS, referenceTargetNeedsTranscript, type ReferenceCheck, type ReferenceCloneTarget } from "../../lib/referenceAudio";
import { downmixToMono } from "../../lib/pcmTransforms";
import { decodeWav, encodeWavPcm16 } from "../../lib/wavCodec";
import {
  assessSelection,
  autoTrimRange,
  buildClonedVoice,
  targetsNeedTranscript,
  type ClipSource,
  type TranscribeClip,
  type TrimRange,
} from "../../lib/voiceLibrary/cloneWizard";
import type { VoiceRecord } from "../../lib/voiceLibrary/types";
import { QWEN3_ENGINE_LANGUAGES } from "../../models/qwen3";
import { useAudition, type CreateAuditionAudio } from "../../hooks/useAudition";
import { useMicRecorder, type UseMicRecorderOptions } from "../../hooks/useMicRecorder";
import type { UseVoiceLibraryReturn } from "../../hooks/useVoiceLibrary";
import type { ApplyResult, ApplySurface } from "../../hooks/useVoiceApplier";
import { useFocusRecovery } from "../useFocusRecovery";
import { WaveformTrimmer } from "./WaveformTrimmer";
import { progressFillStyle } from "../progressFill";
import { errorCalloutClass, infoCalloutClass, inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from "./ui";

const STEPS = ["Sample", "Trim and check", "Transcript", "Save"] as const;
const TARGETS: readonly ReferenceCloneTarget[] = ["qwen3-base", "neutts", "chatterbox"];
const TARGET_HINTS: Record<ReferenceCloneTarget, string> = {
  "qwen3-base": "Needs the exact transcript. 3-20 s of speech.",
  neutts: "Needs the exact transcript. 3-20 s of speech.",
  chatterbox: "No transcript. 5-10 s of speech.",
};
const MAX_UPLOAD_SECONDS = 600;
const PREVIEW_KEY = "clone-selection";

export interface CloneWizardProps {
  library: Pick<UseVoiceLibraryReturn, "createVoice">;
  /** Open a saved voice in Studio or the Reader. */
  onUse?: (record: VoiceRecord, surface: ApplySurface) => Promise<ApplyResult>;
  /** Automatic transcription; when given, the transcript step offers a Transcribe button. */
  transcribe?: TranscribeClip;
  createRecorder?: UseMicRecorderOptions["createRecorder"];
  createAudio?: CreateAuditionAudio;
  /** False while the wizard is hidden; a recording in progress is stopped, never left running unseen. */
  active?: boolean;
}

function formatSeconds(value: number): string {
  return `${value.toFixed(1)} s`;
}

function CheckIcon({ status }: { status: ReferenceCheck["status"] }) {
  if (status === "pass") return <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-success" aria-hidden />;
  if (status === "warn") return <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden />;
  return <XCircle size={14} className="mt-0.5 shrink-0 text-danger" aria-hidden />;
}

function CheckList({ checks }: { checks: readonly ReferenceCheck[] }) {
  return (
    <ul aria-label="Recording quality checks" className="space-y-1.5">
      {checks.map((check) => (
        <li key={check.id} className="flex gap-2 text-xs text-text-secondary">
          <CheckIcon status={check.status} />
          <span>
            <span className="sr-only">{check.status === "pass" ? "Passed: " : check.status === "warn" ? "Warning: " : "Problem: "}</span>
            {check.message}
            {check.fix && <span className="block text-text-muted">{check.fix}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Instant Voice Cloning: record or choose a sample, trim it with feedback on
 * its quality for each engine, type what it says, and save it to the library.
 */
export function CloneWizard({ library, onUse, transcribe, createRecorder, createAudio, active = true }: CloneWizardProps) {
  const [step, setStep] = useState(0);
  const sectionRef = useRef<HTMLElement>(null);
  // Moving between steps unmounts the control that was pressed (Next on the
  // last step, Save, Start/Stop recording, Clone another voice); focus moves
  // to the first control of what is now shown instead of the page body.
  useFocusRecovery(sectionRef);
  const [source, setSource] = useState<ClipSource | null>(null);
  const [range, setRange] = useState<TrimRange>({ startSec: 0, endSec: 0 });
  const [targets, setTargets] = useState<readonly ReferenceCloneTarget[]>(["qwen3-base"]);
  const [normalize, setNormalize] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [language, setLanguage] = useState("English");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [transcribeError, setTranscribeError] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ record: VoiceRecord; warnings: ReferenceCheck[] } | null>(null);
  const [useMessage, setUseMessage] = useState<ApplyResult | null>(null);
  const transcribeAbort = useRef<AbortController | null>(null);

  const mic = useMicRecorder({ createRecorder });
  const audition = useAudition(createAudio);
  const { state: micState, stop: stopMic } = mic;

  // Hiding the wizard (another tab) must not leave the microphone open. The
  // take so far is kept, so coming back offers "Use this recording".
  useEffect(() => {
    if (!active && (micState === "recording" || micState === "starting")) void stopMic();
  }, [active, micState, stopMic]);

  // A transcription still running when the wizard goes away is abandoned.
  useEffect(() => () => transcribeAbort.current?.abort(), []);

  const settings = useMemo(() => ({ range, targets, transcript, normalize }), [normalize, range, targets, transcript]);
  const assessment = useMemo(
    () => (source ? assessSelection(source, settings, step >= 2) : null),
    [settings, source, step],
  );
  const needsTranscript = targetsNeedTranscript(targets);
  const selectionDuration = range.endSec - range.startSec;

  const loadSource = useCallback((next: ClipSource) => {
    audition.stop();
    setSource(next);
    setRange(autoTrimRange(next.samples, next.sampleRate));
    setName(next.label);
    setSourceError(null);
    setSaved(null);
  }, [audition]);

  const handleFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setSourceError(null);
    try {
      if (file.size > MAX_REFERENCE_WAV_BYTES) {
        throw new Error(`That file is larger than ${Math.round(MAX_REFERENCE_WAV_BYTES / 1_000_000)} MB. Choose a shorter WAV.`);
      }
      const decoded = decodeWav(await file.arrayBuffer());
      const samples = downmixToMono(decoded.channels);
      if (samples.length === 0) throw new Error("That WAV file has no audio.");
      if (samples.length / decoded.sampleRate > MAX_UPLOAD_SECONDS) {
        throw new Error("That recording is longer than 10 minutes. Cut out the part you want first.");
      }
      loadSource({
        samples,
        sampleRate: decoded.sampleRate,
        channelCount: decoded.channels.length,
        origin: "upload",
        label: file.name.replace(/\.[^.]+$/, "") || "My voice",
      });
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : "That file could not be read.");
    }
  }, [loadSource]);

  const useRecording = useCallback(() => {
    const { recording } = mic;
    if (!recording) return;
    loadSource({
      samples: recording.samples,
      sampleRate: recording.sampleRate,
      channelCount: 1,
      origin: "recording",
      label: "My recording",
    });
    mic.reset();
  }, [loadSource, mic]);

  const toggleTarget = useCallback((target: ReferenceCloneTarget) => {
    setTargets((current) => {
      const next = current.includes(target) ? current.filter((item) => item !== target) : [...current, target];
      return TARGETS.filter((item) => next.includes(item));
    });
  }, []);

  const auditionSelection = useCallback(() => {
    if (!source) return;
    if (audition.playingKey === PREVIEW_KEY) {
      audition.stop();
      return;
    }
    const from = Math.round(range.startSec * source.sampleRate);
    const to = Math.round(range.endSec * source.sampleRate);
    void audition.play(PREVIEW_KEY, encodeWavPcm16(source.samples.subarray(from, to), source.sampleRate)).catch(() => {
      setSourceError("The clip could not be played.");
    });
  }, [audition, range.endSec, range.startSec, source]);

  const runTranscribe = useCallback(async () => {
    if (!source || !transcribe) return;
    transcribeAbort.current?.abort();
    const controller = new AbortController();
    transcribeAbort.current = controller;
    setTranscribing(true);
    setTranscribeError(null);
    try {
      const from = Math.round(range.startSec * source.sampleRate);
      const to = Math.round(range.endSec * source.sampleRate);
      const text = await transcribe({ samples: source.samples.slice(from, to), sampleRate: source.sampleRate, language }, controller.signal);
      if (!controller.signal.aborted) setTranscript(text.trim());
    } catch (error) {
      if (!controller.signal.aborted) setTranscribeError(error instanceof Error ? error.message : "The clip could not be transcribed.");
    } finally {
      if (transcribeAbort.current === controller) {
        transcribeAbort.current = null;
        setTranscribing(false);
      }
    }
  }, [language, range.endSec, range.startSec, source, transcribe]);

  const save = useCallback(async () => {
    if (!source) return;
    setSaving(true);
    setSaveError(null);
    try {
      const built = buildClonedVoice(source, settings, { name, description: description || undefined, language });
      const record = await library.createVoice(built.voice);
      setSaved({ record, warnings: built.warnings });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "The voice could not be saved.");
    } finally {
      setSaving(false);
    }
  }, [description, language, library, name, settings, source]);

  const restart = useCallback(() => {
    audition.stop();
    setStep(0);
    setSource(null);
    setTranscript("");
    setDescription("");
    setSaved(null);
    setSaveError(null);
    setUseMessage(null);
  }, [audition]);

  const applyTo = useCallback(async (surface: ApplySurface) => {
    if (!saved || !onUse) return;
    setUseMessage(await onUse(saved.record, surface));
  }, [onUse, saved]);

  const recording = mic.state === "recording" || mic.state === "starting" || mic.state === "stopping";
  const hasFail = assessment?.status === "fail";
  const canAdvance = step === 0
    ? source !== null
    : step === 1
      ? source !== null && targets.length > 0 && !hasFail
      : step === 2
        ? !needsTranscript || transcript.trim().length > 0
        : false;

  return (
    <section ref={sectionRef} aria-label="Instant voice cloning" className="space-y-5">
      <ol className="flex flex-wrap gap-2" aria-label="Cloning steps">
        {STEPS.map((label, index) => (
          <li
            key={label}
            aria-current={index === step ? "step" : undefined}
            className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${
              index === step ? "border-accent/45 bg-accent/10 text-accent" : index < step ? "border-border text-text-secondary" : "border-border text-text-muted"
            }`}
          >
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-text-primary/10 text-2xs">
              {index < step ? <Check size={10} aria-hidden /> : index + 1}
            </span>
            {label}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            Record 5-20 seconds of one person speaking clearly in a quiet room, or choose a WAV file. You will trim it next.
          </p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-3 rounded-2xl border border-border bg-text-primary/[0.03] p-4">
              <p className="text-sm font-semibold text-text-secondary">Record from the microphone</p>
              <div className="flex flex-wrap items-center gap-2">
                {!recording ? (
                  <button type="button" className={primaryButtonClass} onClick={() => void mic.start()}>
                    <Mic size={14} aria-hidden /> Start recording
                  </button>
                ) : (
                  <button type="button" className={primaryButtonClass} disabled={mic.state !== "recording"} onClick={() => void mic.stop()}>
                    <Square size={14} aria-hidden /> Stop recording
                  </button>
                )}
                {recording && mic.level && (
                  <>
                    <div
                      role="progressbar"
                      aria-label="Input level"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(Math.min(1, mic.level.peak) * 100)}
                      className="h-2 w-28 overflow-hidden rounded-full bg-text-primary/10"
                    >
                      <div className="h-full w-full bg-accent" style={progressFillStyle(mic.level.peak * 100)} />
                    </div>
                    <span className="font-mono text-xs tabular-nums text-text-muted">{formatSeconds(mic.level.elapsedSec)}</span>
                  </>
                )}
              </div>
              {mic.error && <p role="alert" className={errorCalloutClass}>{mic.error.message}</p>}
              {mic.recording && !recording && (
                <div className={`${infoCalloutClass} flex flex-wrap items-center justify-between gap-2`}>
                  <span>Recorded {formatSeconds(mic.recording.durationSec)}{mic.recording.stoppedBy === "max-duration" ? " (time limit reached)" : ""}.</span>
                  <button type="button" className={secondaryButtonClass} onClick={useRecording}>Use this recording</button>
                </div>
              )}
            </div>
            <div className="space-y-3 rounded-2xl border border-border bg-text-primary/[0.03] p-4">
              <p className="text-sm font-semibold text-text-secondary">Choose a WAV file</p>
              <label className={`${secondaryButtonClass} cursor-pointer`}>
                <Upload size={14} aria-hidden /> Choose file
                <input
                  type="file"
                  accept=".wav,audio/wav,audio/x-wav"
                  aria-label="WAV file"
                  className="sr-only"
                  onChange={(event) => {
                    void handleFile(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
              </label>
            </div>
          </div>
          {sourceError && <p role="alert" className={errorCalloutClass}>{sourceError}</p>}
          {source && (
            <p className={infoCalloutClass}>
              Ready: {source.label}, {formatSeconds(source.samples.length / source.sampleRate)}. Continue to trim it.
            </p>
          )}
        </div>
      )}

      {step === 1 && source && assessment && (
        <div className="space-y-4">
          <WaveformTrimmer samples={source.samples} sampleRate={source.sampleRate} range={range} onRangeChange={setRange} />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={secondaryButtonClass} onClick={auditionSelection}>
              {audition.playingKey === PREVIEW_KEY ? <Square size={14} aria-hidden /> : <Play size={14} aria-hidden />}
              {audition.playingKey === PREVIEW_KEY ? "Stop" : "Play selection"}
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => setRange(autoTrimRange(source.samples, source.sampleRate))}>
              <Scissors size={14} aria-hidden /> Trim silence
            </button>
            <label className="flex items-center gap-2 text-xs font-medium text-text-secondary">
              <input type="checkbox" checked={normalize} onChange={(event) => setNormalize(event.target.checked)} />
              Normalize volume
            </label>
            <span className="ml-auto font-mono text-xs tabular-nums text-text-muted">Selected {formatSeconds(selectionDuration)}</span>
          </div>

          <fieldset>
            <legend className={labelClass}>Clone for</legend>
            <div className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-3">
              {TARGETS.map((target) => (
                <label
                  key={target}
                  className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 text-xs ${
                    targets.includes(target) ? "border-accent/45 bg-accent/10" : "border-border bg-text-primary/[0.04]"
                  }`}
                >
                  <input type="checkbox" checked={targets.includes(target)} onChange={() => toggleTarget(target)} className="mt-0.5" />
                  <span>
                    <span className="block font-semibold text-text-primary">{REFERENCE_TARGET_LABELS[target]}</span>
                    <span className="block text-text-muted">{TARGET_HINTS[target]}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {targets.length === 0
            ? <p className={errorCalloutClass}>Choose at least one engine to clone for.</p>
            : <CheckList checks={assessment.checks} />}
        </div>
      )}

      {step === 2 && source && assessment && (
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            {needsTranscript
              ? "Type exactly what is said in the selected part of the clip, word for word. The clone is only as good as this match."
              : "Chatterbox clones from the audio alone, so a transcript is optional. Add one if you want it kept with the voice."}
          </p>
          <label className={labelClass}>
            Transcript
            <textarea
              aria-label="Transcript"
              value={transcript}
              onChange={(event) => setTranscript(event.target.value)}
              className={`mt-1 min-h-28 ${inputClass}`}
              placeholder="Type what the clip says…"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            {/* Seam for automatic transcription: pass `transcribe` to enable it. */}
            {transcribe && (
              <button type="button" className={secondaryButtonClass} disabled={transcribing} onClick={() => void runTranscribe()}>
                {transcribing ? "Transcribing…" : "Transcribe automatically"}
              </button>
            )}
            <label className="flex items-center gap-2 text-xs font-medium text-text-secondary">
              Language
              <select aria-label="Clip language" value={language} onChange={(event) => setLanguage(event.target.value)} className={inputClass} style={{ width: "auto" }}>
                {QWEN3_ENGINE_LANGUAGES.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
          </div>
          {transcribeError && <p role="alert" className={errorCalloutClass}>{transcribeError}</p>}
          {needsTranscript && transcript.trim().length > 0 && <CheckList checks={assessment.checks.filter((check) => check.id === "transcript")} />}
          {targets.some((target) => !referenceTargetNeedsTranscript(target)) && needsTranscript && (
            <p className="text-2xs text-text-muted">Chatterbox ignores the transcript; the other engines you chose use it.</p>
          )}
        </div>
      )}

      {step === 3 && source && assessment && (
        <div className="space-y-4">
          {!saved ? (
            <>
              <label className={labelClass}>
                Voice name
                <input aria-label="Voice name" value={name} onChange={(event) => setName(event.target.value)} className={`mt-1 ${inputClass}`} maxLength={80} />
              </label>
              <label className={labelClass}>
                Notes (optional)
                <input aria-label="Notes" value={description} onChange={(event) => setDescription(event.target.value)} className={`mt-1 ${inputClass}`} maxLength={500} />
              </label>
              <p className="text-xs text-text-muted">
                {formatSeconds(selectionDuration)} for {targets.map((target) => REFERENCE_TARGET_LABELS[target]).join(", ")}.
              </p>
              <CheckList checks={assessment.checks.filter((check) => check.status !== "pass")} />
              {saveError && <p role="alert" className={errorCalloutClass}>{saveError}</p>}
              <button type="button" className={primaryButtonClass} disabled={saving || name.trim().length === 0} onClick={() => void save()}>
                {saving ? "Saving…" : "Save to My Voices"}
              </button>
            </>
          ) : (
            <div className="space-y-3">
              <p role="status" className={infoCalloutClass}>Saved “{saved.record.name}” to My Voices.</p>
              {saved.warnings.length > 0 && <CheckList checks={saved.warnings} />}
              <div className="flex flex-wrap gap-2">
                {onUse && (
                  <>
                    <button type="button" className={primaryButtonClass} onClick={() => void applyTo("studio")}>Use in Studio</button>
                    <button type="button" className={secondaryButtonClass} onClick={() => void applyTo("reader")}>Use in Reader</button>
                  </>
                )}
                <button type="button" className={secondaryButtonClass} onClick={restart}>Clone another voice</button>
              </div>
              {useMessage && <p role="status" className={useMessage.ok ? infoCalloutClass : errorCalloutClass}>{useMessage.message}</p>}
            </div>
          )}
        </div>
      )}

      {!saved && (
        <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-4">
          <button type="button" className={secondaryButtonClass} disabled={step === 0} onClick={() => { audition.stop(); setStep(step - 1); }}>
            <ArrowLeft size={14} aria-hidden /> Back
          </button>
          {step < 3 && (
            <button type="button" className={primaryButtonClass} disabled={!canAdvance} onClick={() => { audition.stop(); setStep(step + 1); }}>
              Next <ArrowRight size={14} aria-hidden />
            </button>
          )}
        </div>
      )}
    </section>
  );
}
