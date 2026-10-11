import {
  MODELS,
  SUPERTONIC3_MODEL_ID,
  SUPERTONIC3_MODEL_REVISION,
  SUPERTONIC3_VOICES,
} from "../constants";
import type { BenchmarkModel } from "./inferenceSpeedOptions";

export interface BenchmarkModelInfo {
  modelId: string;
  modelRevision: string;
  /** The voice benchmarked unless READY lists voices that exclude it. */
  defaultVoice: string;
  /** GENERATE `language`, for runtimes that take one. */
  language?: string;
}

export const BENCHMARK_MODEL_INFO: Readonly<Record<BenchmarkModel, BenchmarkModelInfo>> = {
  kokoro: {
    modelId: MODELS.kokoro.id,
    modelRevision: MODELS.kokoro.revision,
    defaultVoice: MODELS.kokoro.defaultVoice,
  },
  supertonic: {
    modelId: MODELS.supertonic.id,
    modelRevision: MODELS.supertonic.revision,
    defaultVoice: MODELS.supertonic.defaultVoice,
  },
  supertonic3: {
    modelId: SUPERTONIC3_MODEL_ID,
    modelRevision: SUPERTONIC3_MODEL_REVISION,
    // The app's default Supertonic 3 voice; the worker preloads its style
    // during LOAD, so the first measured generation does not fetch one.
    defaultVoice: "M1" satisfies (typeof SUPERTONIC3_VOICES)[number],
    language: "en",
  },
};

/**
 * The voice to benchmark: the model's default when READY lists it or lists no
 * voices, otherwise the first listed voice (Kokoro's list comes from the
 * downloaded voice pack and may omit the default).
 */
export function resolveBenchmarkVoice(model: BenchmarkModel, readyVoices: readonly string[] | undefined): string {
  const { defaultVoice } = BENCHMARK_MODEL_INFO[model];
  if (!readyVoices?.length || readyVoices.includes(defaultVoice)) return defaultVoice;
  return readyVoices[0];
}
