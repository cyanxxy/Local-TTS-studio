import { useMemo } from "react";
import type { Qwen3RuntimeSettings } from "../contexts/Qwen3RuntimeContext";

/**
 * The Qwen3 settings fields of `runtime` (the `useQwen3Runtime()` value) as
 * one object that changes identity only when one of them does. The provider
 * value also changes with a model download's progress, a setup refresh or an
 * error, so anything that memoises on the settings, or hands them to an
 * engine, takes this instead of the whole value.
 */
export function useQwen3LiveSettings(runtime: Qwen3RuntimeSettings): Qwen3RuntimeSettings {
  const {
    profile,
    modelPath,
    readiness,
    speaker,
    language,
    instruct,
    temperature,
    topK,
    maxNewTokens,
    seed,
    referenceAudioName,
    referenceAudioBase64,
    referenceAudioSignature,
    referenceAudioDurationSec,
    referenceText,
  } = runtime;
  return useMemo(() => ({
    profile,
    modelPath,
    readiness,
    speaker,
    language,
    instruct,
    temperature,
    topK,
    maxNewTokens,
    seed,
    referenceAudioName,
    referenceAudioBase64,
    referenceAudioSignature,
    referenceAudioDurationSec,
    referenceText,
  }), [
    instruct,
    language,
    maxNewTokens,
    modelPath,
    profile,
    readiness,
    referenceAudioBase64,
    referenceAudioDurationSec,
    referenceAudioName,
    referenceAudioSignature,
    referenceText,
    seed,
    speaker,
    temperature,
    topK,
  ]);
}
