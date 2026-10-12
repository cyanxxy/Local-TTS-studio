import type { PresetSynthesize } from "../presetSynthesis";
import type { EngineRuntimeMap, SynthesisRequest } from "../../shared/engineRuntime";
import { buildPresetRequest, type PresetRequestContext } from "./presetRequest";
import type { VoiceLibraryStore } from "./store";

export interface PresetSynthesizeDeps {
  runtimes: EngineRuntimeMap;
  context: Omit<PresetRequestContext, "loadVoiceAudio">;
  library: Pick<VoiceLibraryStore, "getVoice" | "getVoiceAudio">;
}

/** The reference clip a library voice renders from: a clone's reference, or a designed voice's sample. */
export function libraryVoiceAudioLoader(library: PresetSynthesizeDeps["library"]): PresetRequestContext["loadVoiceAudio"] {
  return async (id) => {
    const record = await library.getVoice(id);
    if (!record || record.kind === "preset") return null;
    if (record.kind === "cloned") {
      const wav = await library.getVoiceAudio(id, "reference");
      return wav ? { wav, transcript: record.transcript, sha256: record.reference.sha256 } : null;
    }
    const wav = await library.getVoiceAudio(id, "sample");
    return wav && record.sample ? { wav, transcript: record.design.previewText, sha256: record.sample.sha256 } : null;
  };
}

/**
 * The PresetSynthesize the Voice Library, VoiceDesign previews and dialogue
 * share, backed by the engines' own `synthesize()`. `getDeps` is read on every
 * call so the engine settings are always the current ones.
 */
export function createPresetSynthesize(getDeps: () => PresetSynthesizeDeps): PresetSynthesize {
  return async function* synthesizePreset(text, preset, signal) {
    signal.throwIfAborted();
    const { runtimes, context, library } = getDeps();
    const { engineId, request } = await buildPresetRequest(text, preset, {
      ...context,
      loadVoiceAudio: libraryVoiceAudioLoader(library),
    });
    signal.throwIfAborted();
    const runtime = runtimes[engineId] as { synthesize: (request: SynthesisRequest) => AsyncIterable<{ audio: Float32Array; samplingRate: number }> };
    for await (const chunk of runtime.synthesize({ ...request, signal })) {
      yield { audio: chunk.audio, samplingRate: chunk.samplingRate };
    }
  };
}
