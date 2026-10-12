import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createAuditionPlayer, type AuditionPlayer } from "../lib/auditionPlayer";
import { downloadAudioChunks } from "../lib/audioExportClient";
import { downloadBlob } from "../lib/exportAudio";
import {
  autoCastSpeakers,
  findUncastSpeakers,
  planDialogueRender,
  type DialogueCasting,
  type DialogueGapOptions,
  type DialogueRenderPlan,
} from "../lib/dialogue/plan";
import {
  dialogueCuesToSrt,
  dialogueCuesToVtt,
  renderDialogue,
  renderDialogueTurn,
  stitchDialogueTurns,
  type RenderedDialogueTurn,
  type StitchedDialogue,
} from "../lib/dialogue/render";
import {
  parseDialogueScript,
  type DialogueScript,
  type DialogueSpeaker,
} from "../lib/dialogue/script";
import type { PresetSynthesize } from "../lib/presetSynthesis";
import type { VoicePreset } from "../lib/voiceLibrary/types";
import type { AudioExportOptions } from "../types";

export type DialogueRenderStatus = "idle" | "rendering" | "done" | "cancelled" | "error";

export interface DialogueSessionOptions {
  synthesize: PresetSynthesize;
  exportOptions: AudioExportOptions;
  /**
   * Voices to cast new speakers from, in order. Stage 2's Voice Library adds
   * its saved presets here; the casting UI needs nothing else to change.
   */
  voicePool: readonly VoicePreset[];
  initialSource?: string;
}

export interface DialogueProgress {
  /** 1-based position of the turn being rendered. */
  position: number;
  total: number;
}

export interface UseDialogueSessionReturn {
  source: string;
  setSource: (source: string) => void;
  script: DialogueScript;
  /** Parser issues plus script-level problems such as being too long. */
  issues: Array<{ line: number; message: string }>;
  speakers: DialogueSpeaker[];
  casting: DialogueCasting;
  uncastSpeakers: DialogueSpeaker[];
  castSpeaker: (speakerKey: string, preset: VoicePreset) => void;
  /** Forget manual voice choices and cast every speaker from the pool again. */
  autoCast: () => void;
  gaps: Required<DialogueGapOptions>;
  setGaps: (gaps: Partial<Required<DialogueGapOptions>>) => void;
  plan: DialogueRenderPlan | null;
  status: DialogueRenderStatus;
  progress: DialogueProgress | null;
  error: string | null;
  /** Rendered turns by turn index. */
  turns: ReadonlyMap<number, RenderedDialogueTurn>;
  /** Turn indexes whose text or voice changed since they were rendered. */
  outdatedTurns: ReadonlySet<number>;
  regeneratingTurn: number | null;
  stitched: StitchedDialogue | null;
  playing: boolean;
  render: () => Promise<void>;
  cancel: () => void;
  regenerateTurn: (turnIndex: number) => Promise<void>;
  play: () => void;
  stopPlayback: () => void;
  exportAudio: () => Promise<void>;
  downloadCaptions: (format: "vtt" | "srt") => void;
}

const DEFAULT_GAPS: Required<DialogueGapOptions> = { speakerChangeGapSec: 0.35, sameSpeakerGapSec: 0.2 };
const EXPORT_FILE_NAME = "open-tts-dialogue";

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameVoice(a: VoicePreset, b: VoicePreset): boolean {
  return a.engineId === b.engineId && a.voiceId === b.voiceId && JSON.stringify(a.settings) === JSON.stringify(b.settings);
}

/**
 * A dialogue script, its casting and its render. The script is parsed live,
 * speakers are cast from the voice pool unless the user chose a voice, and
 * rendering runs turn by turn through `synthesize` with progress, cancel and
 * per-turn regenerate. Turns that finished stay available after a cancel or
 * failure, so only the missing ones need rendering again.
 */
export function useDialogueSession({
  synthesize,
  exportOptions,
  voicePool,
  initialSource = "",
}: DialogueSessionOptions): UseDialogueSessionReturn {
  const [source, setSource] = useState(initialSource);
  const [overrides, setOverrides] = useState<Record<string, VoicePreset>>({});
  const [gaps, setGapsState] = useState(DEFAULT_GAPS);
  const [status, setStatus] = useState<DialogueRenderStatus>("idle");
  const [progress, setProgress] = useState<DialogueProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<ReadonlyMap<number, RenderedDialogueTurn>>(() => new Map());
  const [regeneratingTurn, setRegeneratingTurn] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const auditionRef = useRef<AuditionPlayer | null>(null);

  const parsed = useMemo<{ script: DialogueScript; problem: string | null }>(() => {
    try {
      return { script: parseDialogueScript(source), problem: null };
    } catch (cause) {
      return { script: { turns: [], speakers: [], issues: [] }, problem: errorMessage(cause) };
    }
  }, [source]);
  const { script } = parsed;

  const casting = useMemo(
    () => autoCastSpeakers(script, overrides, voicePool),
    [overrides, script, voicePool],
  );
  const uncastSpeakers = useMemo(() => findUncastSpeakers(script, casting), [casting, script]);
  const plan = useMemo(() => {
    if (script.turns.length === 0) return null;
    try {
      return planDialogueRender(script, casting, gaps);
    } catch {
      // Only an uncast speaker or an out-of-range gap stops a plan; the
      // casting rows and gap inputs already say which.
      return null;
    }
  }, [casting, gaps, script]);
  const issues = useMemo(
    () => (parsed.problem ? [{ line: 1, message: parsed.problem }, ...script.issues] : script.issues),
    [parsed.problem, script.issues],
  );

  const outdatedTurns = useMemo(() => {
    const outdated = new Set<number>();
    if (!plan) return outdated;
    const steps = new Map(plan.steps.map((step) => [step.turnIndex, step]));
    for (const [turnIndex, turn] of turns) {
      const step = steps.get(turnIndex);
      if (!step || step.text !== turn.step.text || !sameVoice(step.preset, turn.step.preset)) outdated.add(turnIndex);
    }
    return outdated;
  }, [plan, turns]);

  // Timeline order follows the script; a turn that no longer exists drops out.
  const orderedTurns = useMemo(() => {
    const order = plan ? plan.steps.map((step) => step.turnIndex) : [...turns.keys()].sort((a, b) => a - b);
    return order.flatMap((turnIndex) => {
      const turn = turns.get(turnIndex);
      return turn ? [turn] : [];
    });
  }, [plan, turns]);
  const stitched = useMemo(
    () => (orderedTurns.length > 0 ? stitchDialogueTurns(orderedTurns) : null),
    [orderedTurns],
  );

  const latest = useRef({ synthesize, exportOptions, plan, stitched });
  useEffect(() => {
    latest.current = { synthesize, exportOptions, plan, stitched };
  });

  useEffect(() => () => {
    controllerRef.current?.abort();
    auditionRef.current?.dispose();
  }, []);

  const castSpeaker = useCallback((speakerKey: string, preset: VoicePreset) => {
    setOverrides((current) => ({ ...current, [speakerKey]: preset }));
  }, []);
  const autoCast = useCallback(() => setOverrides({}), []);
  const setGaps = useCallback((next: Partial<Required<DialogueGapOptions>>) => {
    setGapsState((current) => ({ ...current, ...next }));
  }, []);

  const stopPlayback = useCallback(() => {
    auditionRef.current?.stop();
    setPlaying(false);
  }, []);

  const render = useCallback(async () => {
    const { plan: currentPlan, synthesize: synth } = latest.current;
    if (!currentPlan || currentPlan.steps.length === 0) {
      setError("Write at least one line and give every speaker a voice before rendering.");
      return;
    }
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    auditionRef.current?.stop();
    setPlaying(false);
    setError(null);
    setStatus("rendering");
    setTurns(new Map());
    setProgress({ position: 1, total: currentPlan.steps.length });
    try {
      await renderDialogue({
        plan: currentPlan,
        synthesize: synth,
        signal: controller.signal,
        onTurnStart: (_step, position, total) => setProgress({ position: position + 1, total }),
        onTurnRendered: (turn) => setTurns((current) => new Map(current).set(turn.step.turnIndex, turn)),
      });
      setStatus("done");
    } catch (cause) {
      if (isAbort(cause)) {
        setStatus("cancelled");
      } else {
        setError(errorMessage(cause));
        setStatus("error");
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      setProgress(null);
    }
  }, []);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  const regenerateTurn = useCallback(async (turnIndex: number) => {
    const { plan: currentPlan, synthesize: synth } = latest.current;
    const step = currentPlan?.steps.find((entry) => entry.turnIndex === turnIndex);
    if (!step) {
      setError("That line is no longer in the script.");
      return;
    }
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setError(null);
    setRegeneratingTurn(turnIndex);
    try {
      const rendered = await renderDialogueTurn(step, synth, controller.signal);
      setTurns((current) => new Map(current).set(turnIndex, rendered));
    } catch (cause) {
      if (!isAbort(cause)) setError(errorMessage(cause));
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      setRegeneratingTurn(null);
    }
  }, []);

  const play = useCallback(() => {
    const audio = latest.current.stitched;
    if (!audio) return;
    try {
      auditionRef.current ??= createAuditionPlayer();
      setPlaying(true);
      void auditionRef.current.play({ samples: audio.samples, sampleRate: audio.sampleRate }, () => setPlaying(false))
        .catch((cause: unknown) => {
          setPlaying(false);
          setError(errorMessage(cause));
        });
    } catch (cause) {
      setPlaying(false);
      setError(errorMessage(cause));
    }
  }, []);

  const exportAudio = useCallback(async () => {
    const audio = latest.current.stitched;
    if (!audio) return;
    setError(null);
    try {
      await downloadAudioChunks(
        [{ audio: audio.samples, samplingRate: audio.sampleRate }],
        latest.current.exportOptions,
        { fileName: EXPORT_FILE_NAME },
      );
    } catch (cause) {
      if (!isAbort(cause)) setError(errorMessage(cause));
    }
  }, []);

  const downloadCaptions = useCallback((format: "vtt" | "srt") => {
    const audio = latest.current.stitched;
    if (!audio) return;
    const body = format === "vtt" ? dialogueCuesToVtt(audio.cues) : dialogueCuesToSrt(audio.cues);
    downloadBlob(new Blob([body], { type: format === "vtt" ? "text/vtt" : "application/x-subrip" }), `${EXPORT_FILE_NAME}.${format}`);
  }, []);

  return {
    source,
    setSource,
    script,
    issues,
    speakers: script.speakers,
    casting,
    uncastSpeakers,
    castSpeaker,
    autoCast,
    gaps,
    setGaps,
    plan,
    status,
    progress,
    error,
    turns,
    outdatedTurns,
    regeneratingTurn,
    stitched,
    playing,
    render,
    cancel,
    regenerateTurn,
    play,
    stopPlayback,
    exportAudio,
    downloadCaptions,
  };
}
