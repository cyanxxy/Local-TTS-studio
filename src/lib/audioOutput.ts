import type { RawAudio } from "@huggingface/transformers";

interface NormalizedRawAudio {
  audio: Float32Array;
  samplingRate: number;
}

function toFloat32Array(value: unknown): Float32Array {
  if (value instanceof Float32Array) {
    validateFiniteSamples(value);
    return value;
  }
  if (Array.isArray(value)) {
    const numeric = value.map((entry) => {
      const converted = Number(entry);
      if (!Number.isFinite(converted)) {
        throw new Error("Raw audio contains non-finite values.");
      }
      return converted;
    });
    return Float32Array.from(numeric);
  }

  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) {
      throw new Error("Unsupported DataView audio format returned by the model.");
    }
    const converted = Float32Array.from(value as unknown as ArrayLike<number>);
    validateFiniteSamples(converted);
    return converted;
  }

  throw new Error("Unsupported raw audio format returned by the model.");
}

function validateFiniteSamples(audio: Float32Array): void {
  for (let index = 0; index < audio.length; index += 1) {
    if (!Number.isFinite(audio[index])) {
      throw new Error("Raw audio contains non-finite values.");
    }
  }
}

export function normalizeRawAudioOutput(output: RawAudio): NormalizedRawAudio {
  const samplingRate = Number(output.sampling_rate);
  if (!Number.isFinite(samplingRate) || samplingRate <= 0) {
    throw new Error("Model returned an invalid sampling rate.");
  }

  const rawOutput = output as RawAudio & { audio?: unknown; data?: unknown };
  const audio = toFloat32Array(rawOutput.data ?? rawOutput.audio);
  if (audio.length === 0) {
    throw new Error("Model returned empty audio data.");
  }

  return {
    audio,
    samplingRate,
  };
}
