import { useCallback, useEffect, useRef } from "react";
import { useQwen3Runtime } from "../contexts/Qwen3RuntimeContext";
import type { PresetSynthesize } from "../lib/presetSynthesis";
import { createPresetSynthesize, type PresetSynthesizeDeps } from "../lib/voiceLibrary/presetSynthesize";
import { getVoiceLibraryStore } from "../lib/voiceLibrary/store";
import { useSynthesisSession } from "../shared/synthesisSessionContext";

/**
 * The shared PresetSynthesize bound to the live session: it renders through
 * the engines' own `synthesize()` with their current settings. The returned
 * function never changes identity, so effects and memoized children that take
 * it do not re-run when a setting changes.
 */
export function usePresetSynthesize(): PresetSynthesize {
  const { engines, creator } = useSynthesisSession();
  const qwen3 = useQwen3Runtime();
  const depsRef = useRef<PresetSynthesizeDeps | null>(null);
  const synthesize = useCallback<PresetSynthesize>((text, preset, signal) => createPresetSynthesize(() => {
    if (!depsRef.current) throw new Error("The voice engines are not ready yet.");
    return depsRef.current;
  })(text, preset, signal), []);

  useEffect(() => {
    depsRef.current = {
      runtimes: engines.runtimes,
      library: getVoiceLibraryStore(),
      context: {
        tuning: creator.generationSettings,
        engineSettings: engines.surfaceEngineSettings,
        qwen3Profiles: qwen3.profiles,
        qwen3Setup: qwen3.setup,
      },
    };
  });

  return synthesize;
}
