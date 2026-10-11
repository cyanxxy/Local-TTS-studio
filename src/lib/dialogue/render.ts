import { resampleAudio } from "../pcmTransforms";
import { collectSynthesizedAudio, type PresetSynthesize } from "../presetSynthesis";
import type { DialogueRenderPlan, DialogueRenderStep } from "./plan";

/**
 * Render a dialogue plan turn by turn and stitch the turns, which engines
 * deliver at different sample rates, into one timeline with a caption cue per
 * turn. Turns render one at a time: local engines serve one request at a time
 * and the order of the timeline is the order of the script.
 */

export interface RenderedDialogueTurn {
  step: DialogueRenderStep;
  samples: Float32Array;
  sampleRate: number;
}

export interface DialogueCue {
  turnIndex: number;
  speaker: string;
  text: string;
  startSec: number;
  endSec: number;
}

export interface StitchedDialogue {
  samples: Float32Array;
  sampleRate: number;
  durationSec: number;
  cues: DialogueCue[];
}

/** Rate reported for an empty timeline, matching most engines' native rate. */
export const DEFAULT_DIALOGUE_SAMPLE_RATE = 24_000;

function roundSec(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Join rendered turns in order, each preceded by its planned gap. The output
 * rate defaults to the highest input rate so no engine's audio is
 * downsampled; pass `sampleRate` to target a fixed export rate instead.
 */
export function stitchDialogueTurns(
  turns: readonly RenderedDialogueTurn[],
  options: { sampleRate?: number } = {},
): StitchedDialogue {
  const sampleRate = options.sampleRate
    ?? (turns.length === 0 ? DEFAULT_DIALOGUE_SAMPLE_RATE : Math.max(...turns.map((turn) => turn.sampleRate)));
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error("The dialogue sample rate must be positive.");

  const placed = turns.map((turn, index) => ({
    turn,
    // The first turn starts the timeline; its planned gap is always 0 anyway.
    gapFrames: index === 0 ? 0 : Math.round(turn.step.gapBeforeSec * sampleRate),
    samples: resampleAudio(turn.samples, turn.sampleRate, sampleRate),
  }));
  const totalFrames = placed.reduce((total, item) => total + item.gapFrames + item.samples.length, 0);
  const samples = new Float32Array(totalFrames);
  const cues: DialogueCue[] = [];
  let cursor = 0;
  for (const item of placed) {
    cursor += item.gapFrames;
    samples.set(item.samples, cursor);
    cues.push({
      turnIndex: item.turn.step.turnIndex,
      speaker: item.turn.step.speaker,
      text: item.turn.step.text,
      startSec: roundSec(cursor / sampleRate),
      endSec: roundSec((cursor + item.samples.length) / sampleRate),
    });
    cursor += item.samples.length;
  }
  return { samples, sampleRate, durationSec: roundSec(totalFrames / sampleRate), cues };
}

function escapeVttText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cueText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatTimestamp(seconds: number, separator: "." | ","): string {
  const totalMs = Math.round(Math.max(0, seconds) * 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}${separator}${pad(ms, 3)}`;
}

/** WebVTT with a voice span per cue, so players can label or style speakers. */
export function dialogueCuesToVtt(cues: readonly DialogueCue[]): string {
  const body = cues
    .filter((cue) => cueText(cue.text).length > 0)
    .map((cue) => (
      `${formatTimestamp(cue.startSec, ".")} --> ${formatTimestamp(cue.endSec, ".")}\n`
      + `<v ${escapeVttText(cueText(cue.speaker))}>${escapeVttText(cueText(cue.text))}\n`
    ))
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

/** SRT has no voice markup, so each cue is prefixed with its speaker. */
export function dialogueCuesToSrt(cues: readonly DialogueCue[]): string {
  return cues
    .filter((cue) => cueText(cue.text).length > 0)
    .map((cue, index) => (
      `${index + 1}\n${formatTimestamp(cue.startSec, ",")} --> ${formatTimestamp(cue.endSec, ",")}\n`
      + `${cueText(cue.speaker)}: ${cueText(cue.text)}\n`
    ))
    .join("\n");
}

/** Render one step; also the building block for re-taking a single line. */
export async function renderDialogueTurn(
  step: DialogueRenderStep,
  synthesize: PresetSynthesize,
  signal: AbortSignal,
): Promise<RenderedDialogueTurn> {
  signal.throwIfAborted();
  const audio = await collectSynthesizedAudio(synthesize(step.text, step.preset, signal), signal);
  return { step, samples: audio.samples, sampleRate: audio.sampleRate };
}

export interface RenderDialogueOptions {
  plan: DialogueRenderPlan;
  synthesize: PresetSynthesize;
  signal?: AbortSignal;
  /** Called before each turn starts rendering. */
  onTurnStart?: (step: DialogueRenderStep, position: number, total: number) => void;
  /** Called as soon as each turn has rendered, for progress and early playback. */
  onTurnRendered?: (turn: RenderedDialogueTurn, position: number, total: number) => void;
  /** Output rate of the stitched timeline; defaults to the highest turn rate. */
  sampleRate?: number;
}

export interface RenderedDialogue {
  turns: RenderedDialogueTurn[];
  stitched: StitchedDialogue;
}

/**
 * Render every step in order and stitch the result. An abort or engine error
 * stops the run and rejects; turns already reported through `onTurnRendered`
 * remain valid for the caller to keep.
 */
export async function renderDialogue(options: RenderDialogueOptions): Promise<RenderedDialogue> {
  const signal = options.signal ?? new AbortController().signal;
  const total = options.plan.steps.length;
  const turns: RenderedDialogueTurn[] = [];
  for (const [position, step] of options.plan.steps.entries()) {
    options.onTurnStart?.(step, position, total);
    const turn = await renderDialogueTurn(step, options.synthesize, signal);
    turns.push(turn);
    options.onTurnRendered?.(turn, position, total);
  }
  return { turns, stitched: stitchDialogueTurns(turns, { sampleRate: options.sampleRate }) };
}

/** Swap in a re-rendered turn (matched by turn index) for re-stitching. */
export function replaceRenderedTurn(
  turns: readonly RenderedDialogueTurn[],
  replacement: RenderedDialogueTurn,
): RenderedDialogueTurn[] {
  const index = turns.findIndex((turn) => turn.step.turnIndex === replacement.step.turnIndex);
  if (index < 0) throw new Error(`Turn ${replacement.step.turnIndex} is not part of this dialogue.`);
  return turns.map((turn, position) => (position === index ? replacement : turn));
}
