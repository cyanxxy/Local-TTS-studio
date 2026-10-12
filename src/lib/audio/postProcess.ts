/**
 * Export post-processing for synthesized chunks, streamed chunk by chunk:
 *
 * - trims the model's own edge silence from each chunk's speech, keeping a
 *   short margin, so only the configured pause separates sentences;
 * - re-appends each chunk's exact trailing pause (`pauseAfterSec`);
 * - ramps the edges of speech that does not start or end in silence, so
 *   joins between independently generated chunks do not click;
 * - adds head and tail padding (room tone) and file-level fades.
 *
 * `timings` reports where each chunk's speech lands in the output, so
 * captions and chapters can follow the post-processed timeline.
 */
import { DEFAULT_SILENCE_THRESHOLD_DB, findSpeechBounds } from "./silence";

export interface PostProcessingOptions {
  trimSilence?: boolean;
  /** Frames quieter than this count as silence when trimming. */
  thresholdDb?: number;
  /** Silence kept before and after trimmed speech. */
  keepMs?: number;
  headSec?: number;
  tailSec?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
  /** Edge ramp for speech that does not start or end in silence; 0 disables it. */
  declickMs?: number;
}

export interface PostProcessChunk {
  audio: Float32Array;
  /** Silence at the end of `audio` that the engine appended as the pause after this chunk. */
  pauseAfterSec?: number;
}

export interface PostProcessTiming {
  /** Where the chunk's output (speech plus pause) starts and ends, in seconds. */
  startSec: number;
  endSec: number;
  /** The speech part, without the trailing pause. */
  speechStartSec: number;
  speechEndSec: number;
}

const DEFAULT_KEEP_MS = 40;
const DEFAULT_DECLICK_MS = 3;
/** Edges quieter than this are already silent and need no ramp. */
const DECLICK_THRESHOLD = 10 ** (-60 / 20);
const MAX_PADDING_SEC = 30;
const MAX_FADE_MS = 30_000;

function bounded(value: number | undefined, fallback: number, max: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.min(max, Math.max(0, value)) : fallback;
}

/** Raised-cosine gain for position `t` in [0, 1] of a fade-in. */
function fadeInGain(t: number): number {
  return 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, t)));
}

function edgePeak(audio: Float32Array, start: number, end: number): number {
  let peak = 0;
  for (let index = start; index < end; index += 1) peak = Math.max(peak, Math.abs(audio[index]));
  return peak;
}

/** Ramps `ramp` samples at each edge of `speech` (in place) unless that edge is already silent. */
function declick(speech: Float32Array, ramp: number): void {
  const length = Math.min(ramp, Math.floor(speech.length / 2));
  if (length === 0) return;
  if (edgePeak(speech, 0, length) > DECLICK_THRESHOLD) {
    for (let index = 0; index < length; index += 1) speech[index] *= fadeInGain((index + 0.5) / length);
  }
  if (edgePeak(speech, speech.length - length, speech.length) > DECLICK_THRESHOLD) {
    for (let index = 0; index < length; index += 1) speech[speech.length - 1 - index] *= fadeInGain((index + 0.5) / length);
  }
}

export class ChunkPostProcessor {
  readonly sampleRate: number;
  readonly timings: PostProcessTiming[] = [];
  private readonly options: Required<Omit<PostProcessingOptions, "headSec" | "tailSec" | "fadeInMs" | "fadeOutMs">>;
  private readonly headSamples: number;
  private readonly tailSamples: number;
  private readonly fadeInSamples: number;
  private readonly fadeOutSamples: number;
  /** Output not yet emitted because the final fade-out may still reach it. */
  private held = new Float32Array(0);
  /** Absolute output position of `held[0]` (everything before it was returned). */
  private heldStart = 0;
  /** Output position where the most recent speech ended. */
  private lastSpeechEnd = 0;
  private started = false;
  private finished = false;

  constructor(sampleRate: number, options: PostProcessingOptions = {}) {
    if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
      throw new RangeError(`Sample rate must be a positive integer; got ${sampleRate}.`);
    }
    this.sampleRate = sampleRate;
    this.options = {
      trimSilence: options.trimSilence ?? false,
      thresholdDb: options.thresholdDb ?? DEFAULT_SILENCE_THRESHOLD_DB,
      keepMs: bounded(options.keepMs, DEFAULT_KEEP_MS, 1000),
      declickMs: bounded(options.declickMs, DEFAULT_DECLICK_MS, 50),
    };
    const samples = (seconds: number) => Math.round(seconds * sampleRate);
    this.headSamples = samples(bounded(options.headSec, 0, MAX_PADDING_SEC));
    this.tailSamples = samples(bounded(options.tailSec, 0, MAX_PADDING_SEC));
    this.fadeInSamples = samples(bounded(options.fadeInMs, 0, MAX_FADE_MS) / 1000);
    this.fadeOutSamples = samples(bounded(options.fadeOutMs, 0, MAX_FADE_MS) / 1000);
  }

  /** Processes the next chunk and returns the output that is final so far. */
  process(chunk: PostProcessChunk): Float32Array {
    if (this.finished) throw new Error("ChunkPostProcessor cannot accept more input after flush().");
    const { audio } = chunk;
    const pause = Math.min(audio.length, Math.round(bounded(chunk.pauseAfterSec, 0, Number.MAX_VALUE) * this.sampleRate));
    const speechLength = audio.length - pause;

    let start = 0;
    let end = speechLength;
    if (this.options.trimSilence) {
      const bounds = findSpeechBounds(audio, this.sampleRate, { thresholdDb: this.options.thresholdDb }, 0, speechLength);
      const keep = Math.round((this.options.keepMs / 1000) * this.sampleRate);
      start = bounds ? Math.max(0, bounds.start - keep) : 0;
      end = bounds ? Math.min(speechLength, bounds.end + keep) : 0;
    }
    const speech = audio.slice(start, end);
    declick(speech, Math.round((this.options.declickMs / 1000) * this.sampleRate));

    const head = this.started ? 0 : this.headSamples;
    this.started = true;
    const output = new Float32Array(head + speech.length + pause);
    output.set(speech, head);

    const chunkStart = this.heldStart + this.held.length + head;
    const speechEnd = chunkStart + speech.length;
    this.applyFadeIn(output, chunkStart - head);
    this.timings.push({
      startSec: chunkStart / this.sampleRate,
      endSec: (speechEnd + pause) / this.sampleRate,
      speechStartSec: chunkStart / this.sampleRate,
      speechEndSec: speechEnd / this.sampleRate,
    });
    if (speech.length > 0) this.lastSpeechEnd = speechEnd;
    return this.hold(output);
  }

  /** Applies the final fade-out, appends the tail padding and returns the rest of the output. */
  flush(): Float32Array {
    if (this.finished) throw new Error("ChunkPostProcessor was already flushed.");
    this.finished = true;
    const fadeStart = Math.max(this.heldStart, this.lastSpeechEnd - this.fadeOutSamples);
    for (let position = fadeStart; position < this.lastSpeechEnd; position += 1) {
      const remaining = this.lastSpeechEnd - position;
      this.held[position - this.heldStart] *= fadeInGain((remaining - 0.5) / this.fadeOutSamples);
    }
    const output = new Float32Array(this.held.length + this.tailSamples);
    output.set(this.held);
    this.heldStart += this.held.length;
    this.held = new Float32Array(0);
    return output;
  }

  /** Content fade-in, counted from the first sample after the head padding. */
  private applyFadeIn(output: Float32Array, outputStart: number): void {
    const contentStart = this.headSamples;
    for (let index = 0; index < output.length; index += 1) {
      const position = outputStart + index - contentStart;
      if (position >= this.fadeInSamples) break;
      if (position >= 0) output[index] *= fadeInGain((position + 0.5) / this.fadeInSamples);
    }
  }

  /** Keeps back what the final fade-out could still touch and returns the rest. */
  private hold(output: Float32Array): Float32Array {
    const combined = new Float32Array(this.held.length + output.length);
    combined.set(this.held);
    combined.set(output, this.held.length);
    const releaseEnd = Math.max(this.heldStart, this.lastSpeechEnd - this.fadeOutSamples);
    const releaseCount = Math.min(combined.length, releaseEnd - this.heldStart);
    this.held = combined.slice(releaseCount);
    this.heldStart += releaseCount;
    return combined.subarray(0, releaseCount);
  }
}

/** Post-processes whole chunks at once. */
export function postProcessChunks(
  chunks: readonly PostProcessChunk[],
  sampleRate: number,
  options: PostProcessingOptions = {},
): { audio: Float32Array; timings: PostProcessTiming[] } {
  const processor = new ChunkPostProcessor(sampleRate, options);
  const parts = chunks.map((chunk) => processor.process(chunk));
  parts.push(processor.flush());
  const audio = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    audio.set(part, offset);
    offset += part.length;
  }
  return { audio, timings: processor.timings };
}
