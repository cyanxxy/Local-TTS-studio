import { MAX_REFERENCE_AUDIO_FILE_BYTES } from "../../electron/localTtsLimits";
import { downmixToMono, resampleAudio } from "./pcmTransforms";
import { decodeWav, encodeWavPcm16 } from "./wavCodec";

/**
 * Quality checks and light editing for voice-clone reference clips. Qwen3 Base
 * and NeuTTS clone a voice from a short WAV plus its exact transcript, so a
 * clipped, noisy, quiet or badly trimmed clip produces a poor clone. These
 * helpers measure the clip, explain what to fix, and trim, downmix, resample
 * and normalize it before it is saved or sent to the bridge.
 */

export type ReferenceCloneTarget = "qwen3-base" | "neutts" | "chatterbox";
export type ReferenceCheckStatus = "pass" | "warn" | "fail";
export type ReferenceCheckId =
  | "duration"
  | "clipping"
  | "loudness"
  | "noise"
  | "edge-silence"
  | "speech-ratio"
  | "sample-rate"
  | "dc-offset"
  | "transcript";

export interface ReferenceClipAnalysis {
  durationSec: number;
  sampleRate: number;
  /** Channel count of the source before any downmix. */
  channelCount: number;
  peakDbfs: number;
  /** Share of samples at or beyond full scale (|x| >= 0.999). */
  clippingRatio: number;
  /** Loudness of the whole clip. */
  rmsDbfs: number;
  /** Loudness of the frames classified as speech. */
  speechRmsDbfs: number;
  /** 10th-percentile frame level: the room tone under the voice. */
  noiseFloorDbfs: number;
  /** speechRmsDbfs - noiseFloorDbfs, a rough signal-to-noise estimate. */
  snrDb: number;
  leadingSilenceSec: number;
  trailingSilenceSec: number;
  /** Seconds between the first and last speech frame. */
  speechDurationSec: number;
  /** Share of frames classified as speech. */
  speechRatio: number;
  dcOffset: number;
}

export interface ReferenceCheck {
  id: ReferenceCheckId;
  status: ReferenceCheckStatus;
  message: string;
  /** What the user can do about it; absent on a passing check. */
  fix?: string;
}

export interface ReferenceClipAssessment {
  target: ReferenceCloneTarget;
  status: ReferenceCheckStatus;
  checks: ReferenceCheck[];
}

export interface ReferenceDurationLimits {
  minSec: number;
  /** Below this the clip still works but clones less reliably. */
  recommendedMinSec: number;
  /** The runtime rejects longer clips outright. */
  maxSec: number;
}

/**
 * Both runtimes reject reference WAVs over 20 s before using them
 * (rust/local-tts-bridge/src/qwen3/reference.rs decode_reference_wav and
 * neutts_backend/mod.rs prepare_neutts_reference_samples). Qwen3 Base warns
 * under 3 s; NeuTTS needs some speech.
 */
export const REFERENCE_DURATION_LIMITS: Readonly<Record<ReferenceCloneTarget, ReferenceDurationLimits>> = {
  "qwen3-base": { minSec: 1, recommendedMinSec: 3, maxSec: 20 },
  neutts: { minSec: 0.5, recommendedMinSec: 3, maxSec: 20 },
  // Chatterbox Turbo uses the first 10 s (src/lib/chatterboxReference.ts) and
  // wants 5-10 s of clean speech; it needs no transcript.
  chatterbox: { minSec: 3, recommendedMinSec: 5, maxSec: 10 },
};

/** Display names for the clone runtimes. */
export const REFERENCE_TARGET_LABELS: Readonly<Record<ReferenceCloneTarget, string>> = {
  "qwen3-base": "Qwen3 Base",
  neutts: "NeuTTS",
  chatterbox: "Chatterbox Turbo",
};

/** Whether a runtime clones from audio alone, without the clip's exact transcript. */
export function referenceTargetNeedsTranscript(target: ReferenceCloneTarget): boolean {
  return target !== "chatterbox";
}

/**
 * prepareReferenceClip refuses longer clips before resampling, which costs
 * about a second per minute of audio on the calling thread. The headroom over
 * the 20 s runtime limit lets a slightly long recording still be analyzed and
 * shown with trimming guidance.
 */
export const MAX_PREPARE_REFERENCE_SEC = 30;

/** Both clone runtimes resample to 24 kHz internally; store references there. */
export const REFERENCE_TARGET_SAMPLE_RATE = 24_000;
export const MAX_REFERENCE_WAV_BYTES = MAX_REFERENCE_AUDIO_FILE_BYTES;

const FRAME_SEC = 0.02;
const CLIP_THRESHOLD = 0.999;
const SILENCE_DBFS = -120;
const SPEECH_ABSOLUTE_DBFS = -45;
const MIN_CLASS_SEPARATION_DB = 6;
const MIN_SAMPLE_RATE = 16_000;
const EDGE_SILENCE_WARN_SEC = 0.5;
const CHARS_PER_SECOND_MIN = 5;
const CHARS_PER_SECOND_MAX = 25;

function toDbfs(linear: number): number {
  return linear > 0 ? Math.max(SILENCE_DBFS, 20 * Math.log10(linear)) : SILENCE_DBFS;
}

function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return SILENCE_DBFS;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * (sorted.length - 1))));
  return sorted[index];
}

function assertSampleRate(sampleRate: number): void {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error("Reference sample rate must be a positive number.");
  }
}

interface FrameLevels {
  frameSize: number;
  speech: boolean[];
  noiseFloorDb: number;
}

/**
 * Otsu's threshold over 1 dB bins of frame levels: the split that best
 * separates quiet frames (room tone, pauses) from loud ones (speech). Returns
 * null when both classes sit within MIN_CLASS_SEPARATION_DB of each other,
 * meaning the clip is uniformly loud or uniformly quiet.
 */
function otsuThresholdDb(levelsDb: readonly number[]): number | null {
  const bins = new Array<number>(-SILENCE_DBFS + 1).fill(0);
  for (const level of levelsDb) bins[Math.round(level - SILENCE_DBFS)] += 1;
  const total = levelsDb.length;
  let sumAll = 0;
  for (let bin = 0; bin < bins.length; bin += 1) sumAll += bin * bins[bin];

  let best: { bin: number; variance: number; separation: number } | null = null;
  let weightLow = 0;
  let sumLow = 0;
  for (let bin = 0; bin < bins.length - 1; bin += 1) {
    weightLow += bins[bin];
    sumLow += bin * bins[bin];
    const weightHigh = total - weightLow;
    if (weightLow === 0 || weightHigh === 0) continue;
    const meanLow = sumLow / weightLow;
    const meanHigh = (sumAll - sumLow) / weightHigh;
    const variance = weightLow * weightHigh * (meanHigh - meanLow) ** 2;
    if (!best || variance > best.variance) best = { bin, variance, separation: meanHigh - meanLow };
  }
  if (!best || best.separation < MIN_CLASS_SEPARATION_DB) return null;
  return best.bin + 0.5 + SILENCE_DBFS;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length > 0 ? sorted[Math.floor((sorted.length - 1) / 2)] : SILENCE_DBFS;
}

/**
 * Classify 20 ms frames as speech or not. Frames must clear both an absolute
 * floor (-45 dBFS) and, when the clip has distinct quiet and loud parts, the
 * Otsu split between them. The noise floor is the median quiet frame; a clip
 * with no quiet frames at all falls back to its 10th-percentile frame, which
 * is a rough upper bound on the noise under continuous speech.
 */
function measureFrames(samples: Float32Array, sampleRate: number): FrameLevels {
  const frameSize = Math.max(1, Math.round(sampleRate * FRAME_SEC));
  const levelsDb: number[] = [];
  for (let start = 0; start < samples.length; start += frameSize) {
    const end = Math.min(samples.length, start + frameSize);
    let sum = 0;
    for (let index = start; index < end; index += 1) {
      const value = Number.isFinite(samples[index]) ? samples[index] : 0;
      sum += value * value;
    }
    levelsDb.push(toDbfs(Math.sqrt(sum / (end - start))));
  }
  const split = otsuThresholdDb(levelsDb);
  const threshold = Math.max(SPEECH_ABSOLUTE_DBFS, split ?? SPEECH_ABSOLUTE_DBFS);
  const speech = levelsDb.map((level) => level >= threshold);
  const quiet = levelsDb.filter((_, index) => !speech[index]);
  const noiseFloorDb = quiet.length > 0
    ? median(quiet)
    : percentile([...levelsDb].sort((a, b) => a - b), 0.1);
  return { frameSize, speech, noiseFloorDb };
}

/** Measure a mono clip. Pass `channelCount` when the source was downmixed. */
export function analyzeReferenceClip(
  samples: Float32Array,
  sampleRate: number,
  options: { channelCount?: number } = {},
): ReferenceClipAnalysis {
  assertSampleRate(sampleRate);
  const durationSec = samples.length / sampleRate;
  let peak = 0;
  let clipped = 0;
  let sumSquares = 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = Number.isFinite(samples[index]) ? samples[index] : 0;
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
    if (magnitude >= CLIP_THRESHOLD) clipped += 1;
    sumSquares += value * value;
    sum += value;
  }
  const count = Math.max(1, samples.length);
  const frames = measureFrames(samples, sampleRate);
  const firstSpeech = frames.speech.indexOf(true);
  const lastSpeech = frames.speech.lastIndexOf(true);
  const speechFrames = frames.speech.filter(Boolean).length;

  let speechEnergy = 0;
  let speechSamples = 0;
  if (firstSpeech >= 0) {
    for (let frame = 0; frame < frames.speech.length; frame += 1) {
      if (!frames.speech[frame]) continue;
      const start = frame * frames.frameSize;
      const end = Math.min(samples.length, start + frames.frameSize);
      for (let index = start; index < end; index += 1) {
        const value = Number.isFinite(samples[index]) ? samples[index] : 0;
        speechEnergy += value * value;
      }
      speechSamples += end - start;
    }
  }
  const speechRmsDbfs = speechSamples > 0 ? toDbfs(Math.sqrt(speechEnergy / speechSamples)) : SILENCE_DBFS;
  const frameSec = frames.frameSize / sampleRate;
  const leadingSilenceSec = firstSpeech >= 0 ? firstSpeech * frameSec : durationSec;
  const trailingSilenceSec = lastSpeech >= 0
    ? Math.max(0, durationSec - (lastSpeech + 1) * frameSec)
    : durationSec;

  return {
    durationSec: round(durationSec),
    sampleRate,
    channelCount: options.channelCount ?? 1,
    peakDbfs: round(toDbfs(peak), 1),
    clippingRatio: round(clipped / count, 6),
    rmsDbfs: round(toDbfs(Math.sqrt(sumSquares / count)), 1),
    speechRmsDbfs: round(speechRmsDbfs, 1),
    noiseFloorDbfs: round(frames.noiseFloorDb, 1),
    snrDb: round(Math.max(0, speechRmsDbfs - frames.noiseFloorDb), 1),
    leadingSilenceSec: round(leadingSilenceSec),
    trailingSilenceSec: round(trailingSilenceSec),
    speechDurationSec: round(firstSpeech >= 0 ? (lastSpeech - firstSpeech + 1) * frameSec : 0),
    speechRatio: round(frames.speech.length > 0 ? speechFrames / frames.speech.length : 0),
    dcOffset: round(sum / count, 4),
  };
}

const STATUS_RANK: Record<ReferenceCheckStatus, number> = { pass: 0, warn: 1, fail: 2 };

function worst(checks: readonly ReferenceCheck[]): ReferenceCheckStatus {
  return checks.reduce<ReferenceCheckStatus>(
    (current, check) => (STATUS_RANK[check.status] > STATUS_RANK[current] ? check.status : current),
    "pass",
  );
}

function formatSeconds(value: number): string {
  return `${round(value, 1)} s`;
}

function checkDuration(analysis: ReferenceClipAnalysis, target: ReferenceCloneTarget): ReferenceCheck {
  const limits = REFERENCE_DURATION_LIMITS[target];
  const runtime = REFERENCE_TARGET_LABELS[target];
  const duration = analysis.durationSec;
  if (analysis.speechDurationSec < limits.minSec) {
    return {
      id: "duration",
      status: "fail",
      message: `${runtime} needs at least ${formatSeconds(limits.minSec)} of speech; this clip has ${formatSeconds(analysis.speechDurationSec)}.`,
      fix: `Record or choose a clip with ${limits.recommendedMinSec}-${limits.maxSec} s of clear speech.`,
    };
  }
  if (duration > limits.maxSec) {
    return {
      id: "duration",
      status: "fail",
      message: `${runtime} rejects references longer than ${formatSeconds(limits.maxSec)}; this clip is ${formatSeconds(duration)}.`,
      fix: `Trim the clip to ${limits.maxSec} s or less, and trim the transcript to match.`,
    };
  }
  if (duration < limits.recommendedMinSec) {
    return {
      id: "duration",
      status: "warn",
      message: `Short references clone less reliably; this clip is ${formatSeconds(duration)}.`,
      fix: `Use ${limits.recommendedMinSec}-${limits.maxSec} s of speech for a more stable voice.`,
    };
  }
  return { id: "duration", status: "pass", message: `Length ${formatSeconds(duration)} is within ${limits.recommendedMinSec}-${limits.maxSec} s.` };
}

function checkClipping(analysis: ReferenceClipAnalysis): ReferenceCheck {
  const percent = round(analysis.clippingRatio * 100, 2);
  if (analysis.clippingRatio > 0.01) {
    return {
      id: "clipping",
      status: "fail",
      message: `${percent}% of samples are clipped, which distorts the cloned voice.`,
      fix: "Record again with the input gain lowered or the microphone further away.",
    };
  }
  if (analysis.clippingRatio > 0.001) {
    return {
      id: "clipping",
      status: "warn",
      message: `${percent}% of samples are clipped.`,
      fix: "Lower the input gain slightly and record again if the voice sounds harsh.",
    };
  }
  return { id: "clipping", status: "pass", message: "No audible clipping." };
}

function checkLoudness(analysis: ReferenceClipAnalysis): ReferenceCheck {
  if (analysis.speechRmsDbfs < -35) {
    return {
      id: "loudness",
      status: "warn",
      message: `Speech is quiet (${analysis.speechRmsDbfs} dBFS).`,
      fix: "Normalize the clip, or move closer to the microphone and record again.",
    };
  }
  if (analysis.speechRmsDbfs > -6) {
    return {
      id: "loudness",
      status: "warn",
      message: `Speech is very loud (${analysis.speechRmsDbfs} dBFS) and may be compressed.`,
      fix: "Lower the input gain and record again.",
    };
  }
  return { id: "loudness", status: "pass", message: `Speech level ${analysis.speechRmsDbfs} dBFS.` };
}

function checkNoise(analysis: ReferenceClipAnalysis): ReferenceCheck {
  if (analysis.snrDb < 8) {
    return {
      id: "noise",
      status: "fail",
      message: `Background noise is close to the voice level (about ${analysis.snrDb} dB SNR).`,
      fix: "Record in a quieter room; clones copy background noise.",
    };
  }
  if (analysis.snrDb < 15) {
    return {
      id: "noise",
      status: "warn",
      message: `Background noise is noticeable (about ${analysis.snrDb} dB SNR).`,
      fix: "Turn off fans or move to a quieter room for a cleaner clone.",
    };
  }
  return { id: "noise", status: "pass", message: `Background is quiet (about ${analysis.snrDb} dB SNR).` };
}

function checkEdgeSilence(analysis: ReferenceClipAnalysis): ReferenceCheck {
  const edges = Math.max(analysis.leadingSilenceSec, analysis.trailingSilenceSec);
  if (edges > EDGE_SILENCE_WARN_SEC) {
    return {
      id: "edge-silence",
      status: "warn",
      message: `The clip has ${formatSeconds(analysis.leadingSilenceSec)} of silence before and ${formatSeconds(analysis.trailingSilenceSec)} after the speech.`,
      fix: "Use auto-trim to remove the silent edges.",
    };
  }
  return { id: "edge-silence", status: "pass", message: "Speech starts and ends close to the edges." };
}

function checkSpeechRatio(analysis: ReferenceClipAnalysis): ReferenceCheck {
  if (analysis.speechRatio < 0.5) {
    return {
      id: "speech-ratio",
      status: "warn",
      message: `Only ${Math.round(analysis.speechRatio * 100)}% of the clip is speech.`,
      fix: "Choose a passage with continuous speech and few long pauses.",
    };
  }
  return { id: "speech-ratio", status: "pass", message: `${Math.round(analysis.speechRatio * 100)}% of the clip is speech.` };
}

function checkSampleRate(analysis: ReferenceClipAnalysis): ReferenceCheck {
  if (analysis.sampleRate < MIN_SAMPLE_RATE) {
    return {
      id: "sample-rate",
      status: "warn",
      message: `The clip was recorded at ${analysis.sampleRate} Hz, which loses detail.`,
      fix: "Use a recording made at 16 kHz or higher.",
    };
  }
  return { id: "sample-rate", status: "pass", message: `${analysis.sampleRate} Hz.` };
}

function checkDcOffset(analysis: ReferenceClipAnalysis): ReferenceCheck {
  if (Math.abs(analysis.dcOffset) > 0.01) {
    return {
      id: "dc-offset",
      status: "warn",
      message: "The waveform is offset from zero, which suggests a faulty input.",
      fix: "Try another microphone or audio interface.",
    };
  }
  return { id: "dc-offset", status: "pass", message: "No DC offset." };
}

function checkTranscript(analysis: ReferenceClipAnalysis, transcript: string): ReferenceCheck {
  const characters = transcript.replace(/\s+/g, "").length;
  if (characters === 0) {
    return {
      id: "transcript",
      status: "fail",
      message: "A transcript is required for cloning.",
      fix: "Type exactly what is said in the clip.",
    };
  }
  const seconds = Math.max(analysis.speechDurationSec, FRAME_SEC);
  const rate = characters / seconds;
  if (rate < CHARS_PER_SECOND_MIN || rate > CHARS_PER_SECOND_MAX) {
    return {
      id: "transcript",
      status: "warn",
      message: rate < CHARS_PER_SECOND_MIN
        ? "The transcript looks too short for this much speech."
        : "The transcript looks too long for this much speech.",
      fix: "The transcript must match the clip word for word; update it after trimming.",
    };
  }
  return { id: "transcript", status: "pass", message: "Transcript length matches the speech." };
}

/**
 * Turn an analysis into pass/warn/fail checks for one clone runtime. A
 * transcript, when given, is checked for plausible length: cloning needs it to
 * match the audio exactly.
 */
export function assessReferenceClip(
  analysis: ReferenceClipAnalysis,
  target: ReferenceCloneTarget,
  options: { transcript?: string } = {},
): ReferenceClipAssessment {
  const checks: ReferenceCheck[] = [
    checkDuration(analysis, target),
    checkClipping(analysis),
    checkLoudness(analysis),
    checkNoise(analysis),
    checkEdgeSilence(analysis),
    checkSpeechRatio(analysis),
    checkSampleRate(analysis),
    checkDcOffset(analysis),
  ];
  if (options.transcript !== undefined) checks.push(checkTranscript(analysis, options.transcript));
  return { target, status: worst(checks), checks };
}

/** Copy the samples between two times, clamped to the clip. */
export function trimClip(
  samples: Float32Array,
  sampleRate: number,
  range: { startSec?: number; endSec?: number },
): Float32Array {
  assertSampleRate(sampleRate);
  const start = Math.min(samples.length, Math.max(0, Math.round((range.startSec ?? 0) * sampleRate)));
  const endRaw = range.endSec === undefined ? samples.length : Math.round(range.endSec * sampleRate);
  const end = Math.min(samples.length, Math.max(start, endRaw));
  return samples.slice(start, end);
}

/**
 * The span to keep after cutting silent edges, padded so word onsets and
 * releases survive. Returns the whole clip when no speech is detected.
 */
export function findSpeechBounds(
  samples: Float32Array,
  sampleRate: number,
  options: { paddingSec?: number } = {},
): { startSec: number; endSec: number } {
  assertSampleRate(sampleRate);
  const durationSec = samples.length / sampleRate;
  const frames = measureFrames(samples, sampleRate);
  const first = frames.speech.indexOf(true);
  if (first < 0) return { startSec: 0, endSec: durationSec };
  const last = frames.speech.lastIndexOf(true);
  const padding = Math.max(0, options.paddingSec ?? 0.15);
  const frameSec = frames.frameSize / sampleRate;
  return {
    startSec: round(Math.max(0, first * frameSec - padding), 6),
    endSec: round(Math.min(durationSec, (last + 1) * frameSec + padding), 6),
  };
}

/** Scale the clip so its peak sits at `targetDbfs` (default -1 dBFS). */
export function normalizePeak(samples: Float32Array, targetDbfs = -1): Float32Array {
  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const magnitude = Math.abs(samples[index]);
    if (Number.isFinite(magnitude) && magnitude > peak) peak = magnitude;
  }
  if (peak === 0) return samples.slice();
  const gain = 10 ** (Math.min(0, targetDbfs) / 20) / peak;
  const output = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    output[index] = Number.isFinite(samples[index]) ? samples[index] * gain : 0;
  }
  return output;
}

export interface PrepareReferenceClipOptions {
  target?: ReferenceCloneTarget;
  transcript?: string;
  sampleRate?: number;
  /** Cut silent edges (keeping padding) before analysis and encoding. */
  autoTrim?: boolean;
  /** Explicit trim, applied before auto-trim. */
  trim?: { startSec?: number; endSec?: number };
  /** Peak-normalize to this level in dBFS; omit to keep the original gain. */
  normalizeToDbfs?: number;
}

export interface PreparedReferenceClip {
  samples: Float32Array;
  sampleRate: number;
  wav: Uint8Array;
  analysis: ReferenceClipAnalysis;
  assessment: ReferenceClipAssessment;
  /** True when trimming changed the clip, so its transcript must be checked. */
  trimmed: boolean;
}

/**
 * Decode a reference WAV, downmix to mono, optionally trim and normalize,
 * resample to the clone rate, and re-encode as 16-bit PCM. Analysis runs on
 * the final audio, but reports the source's channel count and sample rate so
 * the sample-rate and channel guidance reflects the original recording.
 */
export function prepareReferenceClip(
  wavBytes: ArrayBuffer | Uint8Array,
  options: PrepareReferenceClipOptions = {},
): PreparedReferenceClip {
  if (wavBytes.byteLength > MAX_REFERENCE_WAV_BYTES) {
    throw new Error(`Reference WAV files are limited to ${MAX_REFERENCE_WAV_BYTES.toLocaleString("en-US")} bytes.`);
  }
  const decoded = decodeWav(wavBytes);
  let samples = downmixToMono(decoded.channels);
  const originalLength = samples.length;
  if (options.trim) samples = trimClip(samples, decoded.sampleRate, options.trim);
  if (options.autoTrim) {
    samples = trimClip(samples, decoded.sampleRate, findSpeechBounds(samples, decoded.sampleRate));
  }
  const trimmed = samples.length !== originalLength;
  const trimmedSec = samples.length / decoded.sampleRate;
  if (trimmedSec > MAX_PREPARE_REFERENCE_SEC) {
    throw new Error(
      `This clip is ${formatSeconds(trimmedSec)} long. Trim it to ${REFERENCE_DURATION_LIMITS["qwen3-base"].maxSec} s or less, and its transcript to match, before using it as a reference.`,
    );
  }
  if (options.normalizeToDbfs !== undefined) samples = normalizePeak(samples, options.normalizeToDbfs);

  const sampleRate = options.sampleRate ?? REFERENCE_TARGET_SAMPLE_RATE;
  const output = resampleAudio(samples, decoded.sampleRate, sampleRate);
  const analysis = {
    ...analyzeReferenceClip(output, sampleRate, { channelCount: decoded.channels.length }),
    sampleRate: decoded.sampleRate,
  };
  const assessment = assessReferenceClip(analysis, options.target ?? "qwen3-base", { transcript: options.transcript });
  return { samples: output, sampleRate, wav: encodeWavPcm16(output, sampleRate), analysis, assessment, trimmed };
}
