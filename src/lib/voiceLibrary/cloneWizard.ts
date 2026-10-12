import {
  analyzeReferenceClip,
  assessReferenceClip,
  findSpeechBounds,
  normalizePeak,
  prepareReferenceClip,
  referenceTargetNeedsTranscript,
  trimClip,
  type ReferenceCheck,
  type ReferenceCheckStatus,
  type ReferenceCloneTarget,
  type ReferenceClipAnalysis,
} from "../referenceAudio";
import { encodeWavPcm16 } from "../wavCodec";
import type { NewClonedVoice, VoiceSource } from "./types";

/**
 * The logic behind the Instant Voice Cloning wizard: the trimmed clip, its
 * quality checks across the chosen target engines, and the voice that gets
 * saved. Pure, so the wizard component only holds state and renders.
 */

/** The shortest selection the trim editor allows. */
export const MIN_TRIM_SEC = 0.5;

export interface TrimRange {
  startSec: number;
  endSec: number;
}

/** Keep a trim inside the clip and at least MIN_TRIM_SEC long (or the whole clip when shorter). */
export function clampTrim(range: TrimRange, durationSec: number): TrimRange {
  const minLength = Math.min(MIN_TRIM_SEC, durationSec);
  const startSec = Math.min(Math.max(0, range.startSec), Math.max(0, durationSec - minLength));
  const endSec = Math.min(durationSec, Math.max(range.endSec, startSec + minLength));
  return { startSec, endSec };
}

/** Peak level per bin, scaled so the loudest bin is 1, for drawing a waveform. */
export function computePeaks(samples: Float32Array, bins: number): Float32Array {
  const count = Math.max(1, Math.floor(bins));
  const peaks = new Float32Array(count);
  if (samples.length === 0) return peaks;
  const perBin = samples.length / count;
  let loudest = 0;
  for (let bin = 0; bin < count; bin += 1) {
    const from = Math.floor(bin * perBin);
    const to = Math.min(samples.length, Math.max(from + 1, Math.floor((bin + 1) * perBin)));
    let peak = 0;
    for (let index = from; index < to; index += 1) {
      const magnitude = Math.abs(samples[index]);
      if (Number.isFinite(magnitude) && magnitude > peak) peak = magnitude;
    }
    peaks[bin] = peak;
    if (peak > loudest) loudest = peak;
  }
  if (loudest > 0) for (let bin = 0; bin < count; bin += 1) peaks[bin] /= loudest;
  return peaks;
}

/** The speech span of a clip as a trim: silent edges cut, with padding kept. */
export function autoTrimRange(samples: Float32Array, sampleRate: number): TrimRange {
  return clampTrim(findSpeechBounds(samples, sampleRate), samples.length / sampleRate);
}

export function targetsNeedTranscript(targets: readonly ReferenceCloneTarget[]): boolean {
  return targets.some(referenceTargetNeedsTranscript);
}

export interface ClipSource {
  samples: Float32Array;
  sampleRate: number;
  channelCount: number;
  origin: VoiceSource;
  /** File name or "Recording", used as a default voice name. */
  label: string;
}

export interface CloneSettings {
  range: TrimRange;
  targets: readonly ReferenceCloneTarget[];
  transcript: string;
  normalize: boolean;
}

export interface CloneAssessment {
  analysis: ReferenceClipAnalysis;
  status: ReferenceCheckStatus;
  /** One entry per check; where targets disagree, the worst verdict wins. */
  checks: ReferenceCheck[];
}

const STATUS_RANK: Record<ReferenceCheckStatus, number> = { pass: 0, warn: 1, fail: 2 };

/** Merge per-target checks into one list, keeping the worst verdict for each check. */
export function mergeChecks(lists: readonly (readonly ReferenceCheck[])[]): ReferenceCheck[] {
  const merged = new Map<ReferenceCheck["id"], ReferenceCheck>();
  for (const list of lists) {
    for (const check of list) {
      const existing = merged.get(check.id);
      if (!existing || STATUS_RANK[check.status] > STATUS_RANK[existing.status]) merged.set(check.id, check);
    }
  }
  return [...merged.values()];
}

function worstStatus(checks: readonly ReferenceCheck[]): ReferenceCheckStatus {
  return checks.reduce<ReferenceCheckStatus>((worst, check) => (STATUS_RANK[check.status] > STATUS_RANK[worst] ? check.status : worst), "pass");
}

function selectedSamples(source: ClipSource, settings: Pick<CloneSettings, "range" | "normalize">): Float32Array {
  const trimmed = trimClip(source.samples, source.sampleRate, settings.range);
  return settings.normalize ? normalizePeak(trimmed) : trimmed;
}

/**
 * The checks for the selected part of the clip against every chosen target.
 * The transcript is checked only when `withTranscript` is set, so the trim
 * step does not fail a clip for a transcript nobody has typed yet.
 */
export function assessSelection(source: ClipSource, settings: CloneSettings, withTranscript = false): CloneAssessment {
  const samples = selectedSamples(source, settings);
  const analysis = analyzeReferenceClip(samples, source.sampleRate, { channelCount: source.channelCount });
  if (settings.targets.length === 0) return { analysis, status: "pass", checks: [] };
  const checks = mergeChecks(settings.targets.map((target) => assessReferenceClip(
    analysis,
    target,
    withTranscript && referenceTargetNeedsTranscript(target) ? { transcript: settings.transcript } : {},
  ).checks));
  return { analysis, status: worstStatus(checks), checks };
}

export interface CloneVoiceDetails {
  name: string;
  description?: string;
  language: string;
}

export interface BuiltClone {
  voice: NewClonedVoice;
  /** Warnings worth showing before and after saving. */
  warnings: ReferenceCheck[];
}

function failureMessage(checks: readonly ReferenceCheck[]): string {
  return checks
    .filter((check) => check.status === "fail")
    .map((check) => [check.message, check.fix].filter(Boolean).join(" "))
    .join(" ");
}

/**
 * The cloned voice to save: the trimmed clip resampled to the clone rate,
 * checked for every target. Throws with the checks' guidance when a hard limit
 * fails (too long, clipped, no speech, missing transcript).
 */
export function buildClonedVoice(source: ClipSource, settings: CloneSettings, details: CloneVoiceDetails): BuiltClone {
  if (settings.targets.length === 0) throw new Error("Choose at least one engine to clone for.");
  const needsTranscript = targetsNeedTranscript(settings.targets);
  const transcript = settings.transcript.trim();
  if (needsTranscript && transcript.length === 0) throw new Error("Type exactly what is said in the clip.");
  const trimmed = selectedSamples(source, settings);
  const wav = encodeWavPcm16(trimmed, source.sampleRate);
  const warnings: ReferenceCheck[] = [];
  let referenceWav: Uint8Array | null = null;
  for (const target of settings.targets) {
    const prepared = prepareReferenceClip(wav, {
      target,
      transcript: referenceTargetNeedsTranscript(target) ? transcript : undefined,
    });
    const failures = failureMessage(prepared.assessment.checks);
    if (failures) throw new Error(failures);
    for (const check of prepared.assessment.checks) {
      if (check.status === "warn" && !warnings.some((existing) => existing.id === check.id)) warnings.push(check);
    }
    // Preparation does not depend on the target, so every pass yields the same clip.
    referenceWav = prepared.wav;
  }
  if (!referenceWav) throw new Error("Choose at least one engine to clone for.");
  return {
    voice: {
      kind: "cloned",
      name: details.name,
      description: details.description,
      transcript,
      language: details.language,
      targets: settings.targets,
      source: source.origin,
      referenceWav,
    },
    warnings,
  };
}

/**
 * The seam for automatic transcription. Whisper is paused, so the wizard asks
 * for the transcript by hand; passing a function of this type to the wizard
 * adds a "Transcribe" button that fills the field with its result.
 */
export type TranscribeClip = (
  clip: { samples: Float32Array; sampleRate: number; language: string },
  signal: AbortSignal,
) => Promise<string>;
