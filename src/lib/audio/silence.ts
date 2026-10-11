/**
 * Edge-silence detection for synthesized speech. TTS output is digitally
 * clean, so a fixed RMS threshold over short frames finds where the voice
 * starts and stops reliably without adaptive noise estimation.
 */

export interface SpeechBoundsOptions {
  /** Frames quieter than this RMS level (dBFS) count as silence. */
  thresholdDb?: number;
  frameMs?: number;
}

export interface SpeechBounds {
  /** First sample of the first voiced frame. */
  start: number;
  /** One past the last sample of the last voiced frame. */
  end: number;
}

export const DEFAULT_SILENCE_THRESHOLD_DB = -50;
const DEFAULT_FRAME_MS = 10;

function frameIsVoiced(audio: Float32Array, start: number, end: number, thresholdEnergy: number): boolean {
  let sum = 0;
  for (let index = start; index < end; index += 1) sum += audio[index] * audio[index];
  return sum / (end - start) > thresholdEnergy;
}

/**
 * Finds the voiced span of `audio[from..to)`, or null when it is all silence.
 * Frame edges are aligned to `from`, and the result is clamped to the range.
 */
export function findSpeechBounds(
  audio: Float32Array,
  sampleRate: number,
  options: SpeechBoundsOptions = {},
  from: number = 0,
  to: number = audio.length,
): SpeechBounds | null {
  const start = Math.max(0, Math.min(audio.length, Math.floor(from)));
  const end = Math.max(start, Math.min(audio.length, Math.floor(to)));
  if (end === start || !(sampleRate > 0)) return null;

  const frame = Math.max(1, Math.round((sampleRate * (options.frameMs ?? DEFAULT_FRAME_MS)) / 1000));
  const thresholdEnergy = 10 ** ((options.thresholdDb ?? DEFAULT_SILENCE_THRESHOLD_DB) / 10);

  let first = -1;
  for (let frameStart = start; frameStart < end; frameStart += frame) {
    if (frameIsVoiced(audio, frameStart, Math.min(end, frameStart + frame), thresholdEnergy)) {
      first = frameStart;
      break;
    }
  }
  if (first < 0) return null;

  // Walk back from the last frame on the same grid as the forward scan.
  const lastFrameStart = start + Math.floor((end - 1 - start) / frame) * frame;
  for (let frameStart = lastFrameStart; frameStart > first; frameStart -= frame) {
    const frameEnd = Math.min(end, frameStart + frame);
    if (frameIsVoiced(audio, frameStart, frameEnd, thresholdEnergy)) {
      return { start: first, end: frameEnd };
    }
  }
  return { start: first, end: Math.min(end, first + frame) };
}
