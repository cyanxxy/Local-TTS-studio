import { concatSamples, resampleAudio } from "./pcmTransforms";
import type { VoicePreset } from "./voiceLibrary/types";

/**
 * The one engine-facing contract the dialogue renderer and the VoiceDesign
 * preview planner depend on: render `text` with a voice preset and stream
 * mono audio chunks back. Keeping it this small lets either feature be wired
 * to any runtime (a browser worker, the Rust bridge, Audio8) through a thin
 * adapter, and lets tests drive them with plain async generators.
 */
export interface SynthesizedAudioChunk {
  audio: Float32Array;
  samplingRate: number;
}

export type PresetSynthesize = (
  text: string,
  preset: VoicePreset,
  signal: AbortSignal,
) => AsyncIterable<SynthesizedAudioChunk>;

export interface CollectedAudio {
  samples: Float32Array;
  sampleRate: number;
  /** Milliseconds from the call until the first non-empty chunk arrived. */
  firstAudioMs: number | null;
}

/**
 * Drain one synthesis stream into a single buffer at the first chunk's rate,
 * resampling any later chunk an engine delivered at another rate. Abort is
 * checked between chunks so a cancelled render stops promptly even when the
 * engine ignores the signal. An empty stream is an error: every caller needs
 * audio to place on a timeline or save.
 */
export async function collectSynthesizedAudio(
  stream: AsyncIterable<SynthesizedAudioChunk>,
  signal: AbortSignal,
  now: () => number = () => performance.now(),
): Promise<CollectedAudio> {
  const startedAt = now();
  const parts: Float32Array[] = [];
  let sampleRate: number | null = null;
  let firstAudioMs: number | null = null;
  signal.throwIfAborted();
  for await (const chunk of stream) {
    signal.throwIfAborted();
    if (!Number.isFinite(chunk.samplingRate) || chunk.samplingRate <= 0) {
      throw new Error("The engine returned audio with an invalid sample rate.");
    }
    if (chunk.audio.length === 0) continue;
    if (sampleRate === null) {
      sampleRate = chunk.samplingRate;
      firstAudioMs = Math.max(0, now() - startedAt);
    }
    parts.push(resampleAudio(chunk.audio, chunk.samplingRate, sampleRate));
  }
  signal.throwIfAborted();
  if (sampleRate === null) throw new Error("The engine returned no audio.");
  return { samples: concatSamples(parts), sampleRate, firstAudioMs };
}
