import { useCallback, useEffect, useRef } from "react";
import { useQwen3Runtime } from "../contexts/Qwen3RuntimeContext";
import type { PresetSynthesize } from "../lib/presetSynthesis";
import type { CatalogVoice } from "../lib/voiceLibrary/catalog";
import { presetRenderKey } from "../lib/voiceLibrary/presetRequest";
import { createPresetSynthesize, type PresetSynthesizeDeps } from "../lib/voiceLibrary/presetSynthesize";
import { getVoiceLibraryStore } from "../lib/voiceLibrary/store";
import { useSynthesisSession } from "../shared/synthesisSessionContext";

export interface PresetVoiceEngine {
  synthesize: PresetSynthesize;
  /** The cache key for everything beyond the preset that shapes a voice's audio. */
  renderKey: (voice: CatalogVoice) => Promise<string>;
}

/**
 * The shared PresetSynthesize bound to the live session: it renders through
 * the engines' own `synthesize()` with their current settings. Both functions
 * never change identity, so effects and memoized children that take them do
 * not re-run when a setting changes.
 */
export function usePresetVoiceEngine(): PresetVoiceEngine {
  const { engines, creator } = useSynthesisSession();
  const qwen3 = useQwen3Runtime();
  const depsRef = useRef<PresetSynthesizeDeps | null>(null);
  const synthesize = useCallback<PresetSynthesize>((text, preset, signal) => createPresetSynthesize(() => {
    if (!depsRef.current) throw new Error("The voice engines are not ready yet.");
    return depsRef.current;
  })(text, preset, signal), []);
  const renderKey = useCallback(async (voice: CatalogVoice) => {
    const deps = depsRef.current;
    if (!deps) throw new Error("The voice engines are not ready yet.");
    const record = voice.record;
    const reference = record?.kind === "cloned"
      ? { sha256: record.reference.sha256, transcript: record.transcript }
      : record?.kind === "designed" && record.sample
        ? { sha256: record.sample.sha256, transcript: record.design.previewText }
        : undefined;
    return presetRenderKey(voice.preset, { ...deps.context, loadVoiceAudio: async () => null }, reference);
  }, []);

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

  return { synthesize, renderKey };
}

export function usePresetSynthesize(): PresetSynthesize {
  return usePresetVoiceEngine().synthesize;
}
