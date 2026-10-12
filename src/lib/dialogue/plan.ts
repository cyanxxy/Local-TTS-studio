import type { VoicePreset } from "../voiceLibrary/types";
import type { DialogueScript, DialogueSpeaker } from "./script";

/**
 * Casting maps each speaker (by speakerKey) to a voice preset, and the render
 * plan turns a parsed script plus its casting into the ordered list of turns
 * to synthesize, each with its voice and the silence that precedes it.
 */

export type DialogueCasting = Readonly<Record<string, VoicePreset>>;

export interface DialogueRenderStep {
  turnIndex: number;
  speaker: string;
  speakerKey: string;
  text: string;
  preset: VoicePreset;
  /** Silence inserted before this turn; 0 for the first turn. */
  gapBeforeSec: number;
}

export interface DialogueRenderPlan {
  steps: DialogueRenderStep[];
  /** Total silence between turns, for duration estimates. */
  totalGapSec: number;
}

export interface DialogueGapOptions {
  /** Pause when the speaker changes. */
  speakerChangeGapSec?: number;
  /** Pause between consecutive turns of the same speaker (a new paragraph or a beat). */
  sameSpeakerGapSec?: number;
}

export const DEFAULT_DIALOGUE_GAPS = {
  speakerChangeGapSec: 0.35,
  sameSpeakerGapSec: 0.2,
} as const;

export const MAX_DIALOGUE_GAP_SEC = 5;

/** Thrown when a plan is requested for speakers without a voice. */
export class DialogueCastingError extends Error {
  readonly missingSpeakers: DialogueSpeaker[];

  constructor(missingSpeakers: DialogueSpeaker[]) {
    super(`Choose a voice for ${missingSpeakers.map((speaker) => speaker.name).join(", ")}.`);
    this.name = "DialogueCastingError";
    this.missingSpeakers = missingSpeakers;
  }
}

function resolveGap(value: number | undefined, fallback: number, label: string): number {
  const gap = value ?? fallback;
  if (!Number.isFinite(gap) || gap < 0 || gap > MAX_DIALOGUE_GAP_SEC) {
    throw new Error(`${label} must be between 0 and ${MAX_DIALOGUE_GAP_SEC} seconds.`);
  }
  return gap;
}

export function findUncastSpeakers(script: Pick<DialogueScript, "speakers">, casting: DialogueCasting): DialogueSpeaker[] {
  return script.speakers.filter((speaker) => !Object.hasOwn(casting, speaker.key));
}

/**
 * Cast every speaker that has no voice yet, keeping existing choices. Uncast
 * speakers take the pool's voices in order, preferring ones nobody uses yet,
 * so a fresh two-person script gets two different voices. Casting entries for
 * speakers no longer in the script are dropped.
 */
export function autoCastSpeakers(
  script: Pick<DialogueScript, "speakers">,
  casting: DialogueCasting,
  pool: readonly VoicePreset[],
): DialogueCasting {
  const next: Record<string, VoicePreset> = {};
  for (const speaker of script.speakers) {
    if (Object.hasOwn(casting, speaker.key)) next[speaker.key] = casting[speaker.key];
  }
  if (pool.length === 0) return next;
  const voiceKey = (preset: VoicePreset) => `${preset.engineId}\u0000${preset.voiceId}`;
  const usage = new Map<string, number>();
  for (const preset of Object.values(next)) usage.set(voiceKey(preset), (usage.get(voiceKey(preset)) ?? 0) + 1);
  for (const speaker of script.speakers) {
    if (Object.hasOwn(next, speaker.key)) continue;
    // Least-used voice first; ties keep pool order.
    let choice = pool[0];
    for (const candidate of pool) {
      if ((usage.get(voiceKey(candidate)) ?? 0) < (usage.get(voiceKey(choice)) ?? 0)) choice = candidate;
    }
    next[speaker.key] = choice;
    usage.set(voiceKey(choice), (usage.get(voiceKey(choice)) ?? 0) + 1);
  }
  return next;
}

/**
 * The ordered turns to render. Every speaker must be cast; the error lists
 * the ones that are not so the UI can point at them.
 */
export function planDialogueRender(
  script: DialogueScript,
  casting: DialogueCasting,
  gaps: DialogueGapOptions = {},
): DialogueRenderPlan {
  const speakerChangeGapSec = resolveGap(gaps.speakerChangeGapSec, DEFAULT_DIALOGUE_GAPS.speakerChangeGapSec, "The pause between speakers");
  const sameSpeakerGapSec = resolveGap(gaps.sameSpeakerGapSec, DEFAULT_DIALOGUE_GAPS.sameSpeakerGapSec, "The pause within a speaker");
  const missing = findUncastSpeakers(script, casting);
  if (missing.length > 0) throw new DialogueCastingError(missing);

  let totalGapSec = 0;
  const steps = script.turns.map((turn, index): DialogueRenderStep => {
    const previous = index > 0 ? script.turns[index - 1] : null;
    const gapBeforeSec = previous === null
      ? 0
      : previous.speakerKey === turn.speakerKey ? sameSpeakerGapSec : speakerChangeGapSec;
    totalGapSec += gapBeforeSec;
    return {
      turnIndex: turn.index,
      speaker: turn.speaker,
      speakerKey: turn.speakerKey,
      text: turn.text,
      preset: casting[turn.speakerKey],
      gapBeforeSec,
    };
  });
  return { steps, totalGapSec: Math.round(totalGapSec * 1000) / 1000 };
}

/**
 * Consecutive steps that share an engine. Runtimes that keep one model
 * resident at a time can load each engine once per run instead of per turn.
 */
export function groupStepsByEngine(steps: readonly DialogueRenderStep[]): Array<{ engineId: string; steps: DialogueRenderStep[] }> {
  const runs: Array<{ engineId: string; steps: DialogueRenderStep[] }> = [];
  for (const step of steps) {
    const last = runs.at(-1);
    if (last && last.engineId === step.preset.engineId) last.steps.push(step);
    else runs.push({ engineId: step.preset.engineId, steps: [step] });
  }
  return runs;
}
