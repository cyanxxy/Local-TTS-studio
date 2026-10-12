import type { GenerationTuningSettings } from "../types";
import type { AudioSignatureTuning } from "../lib/readerDocument";
import type { EngineCapabilities } from "./types";

/**
 * Narrows the Creator tuning to the fields an engine with `capabilities`
 * actually reads. `language` must be the engine's own language setting: the
 * shared tuning carries the Supertonic 2 language for every engine, so taking
 * it from there would let one engine's picker invalidate another's audio.
 */
export function audibleTuning(
  capabilities: EngineCapabilities,
  tuning: GenerationTuningSettings,
  quality: number,
  language?: string,
): AudioSignatureTuning {
  return {
    ...(capabilities.speed
      ? { speed: tuning.speed, sentenceSpeedVariance: tuning.sentenceSpeedVariance }
      : {}),
    ...(capabilities.pauses ? { pauseOverridesSec: tuning.pauseOverridesSec } : {}),
    ...(capabilities.pronunciationLexicon
      ? { pronunciationRules: tuning.pronunciationRules, emphasisStrength: tuning.emphasisStrength }
      : {}),
    ...(capabilities.quality ? { quality } : {}),
    ...(capabilities.languages && language !== undefined ? { language } : {}),
  };
}
