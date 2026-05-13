import type { RawAudio } from "@huggingface/transformers";

interface NormalizedRawAudio {
  audio: Float32Array;
  samplingRate: number;
}

function toFloat32Array(value: unknown): Float32Array {
  if (value instanceof Float32Array) return value;
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
    return Float32Array.from(value as unknown as ArrayLike<number>);
  }

  throw new Error("Unsupported raw audio format returned by the model.");
}

export function normalizeRawAudioOutput(output: RawAudio): NormalizedRawAudio {
  const samplingRate = Number(output.sampling_rate);
  if (!Number.isFinite(samplingRate) || samplingRate <= 0) {
    throw new Error("Model returned an invalid sampling rate.");
  }

  const audio = toFloat32Array((output as { audio: unknown }).audio);
  if (audio.length === 0) {
    throw new Error("Model returned empty audio data.");
  }

  return {
    audio,
    samplingRate,
  };
}
