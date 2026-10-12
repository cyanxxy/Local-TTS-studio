import type {
  EngineRuntimeMap,
  EngineSynthesisSettings,
  Qwen3SynthesisSettings,
  SynthesisChunk,
  SynthesisRequest,
} from "../shared/engineRuntime";
import type { SurfaceEngineId, SurfaceEngineSettings } from "../models/registry";
import type { GenerationTuningSettings } from "../types";
import type { PresetSynthesize, SynthesizedAudioChunk } from "./presetSynthesis";
import type { VoicePreset } from "./voiceLibrary/types";

/**
 * Turns what Studio has selected, or a voice preset, into the self-contained
 * requests `EngineRuntime.synthesize` takes. Variations, dialogue turns and
 * history all render through here, so none of them reads or changes the
 * surface's own text, voice or player.
 */

/** What every request starts from: the engines' live settings and Creator tuning. */
export interface SynthesisBase {
  settings: SurfaceEngineSettings;
  tuning: GenerationTuningSettings;
}

export interface BuildRequestOptions {
  /** Applied over the base settings; omitted renders with exactly what Studio has selected. */
  preset?: VoicePreset;
  seed?: number;
  /** Replaces the Creator speed for this request, for prosody variations. */
  speed?: number;
  signal?: AbortSignal;
}

function qwen3Settings(live: SurfaceEngineSettings["qwen3"], preset?: VoicePreset): Qwen3SynthesisSettings {
  const withReference = live as SurfaceEngineSettings["qwen3"] & { referenceAudioBase64?: string | null };
  const profile = live.profile as SurfaceEngineSettings["qwen3"]["profile"] & { label?: string };
  const extra = preset?.settings.extra ?? {};
  const number = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
  return {
    ...live,
    profile: { ...profile, label: profile.label ?? profile.repo },
    referenceAudioBase64: withReference.referenceAudioBase64 ?? null,
    ...(preset && preset.mode !== "voiceClone" && preset.voiceId ? { speaker: preset.voiceId } : {}),
    language: preset?.settings.language ?? live.language,
    instruct: preset?.settings.instruction ?? live.instruct,
    temperature: number(extra.temperature, live.temperature),
    topK: number(extra.topK, live.topK),
  };
}

/** The engine settings a request renders with: the base, with the preset's voice and language over it. */
export function settingsForPreset<Id extends SurfaceEngineId>(
  engineId: Id,
  base: SurfaceEngineSettings,
  preset?: VoicePreset,
): EngineSynthesisSettings[Id] {
  const voice = preset?.voiceId;
  const language = preset?.settings.language;
  let settings: EngineSynthesisSettings[SurfaceEngineId];
  switch (engineId) {
    case "kokoro":
      settings = { ...base.kokoro, ...(voice ? { voice } : {}) };
      break;
    case "supertonic":
      settings = { ...base.supertonic, ...(voice ? { voice } : {}), ...(language ? { language } : {}) };
      break;
    case "audio8":
      settings = { ...base.audio8, ...(voice ? { voice } : {}) };
      break;
    case "supertonic3":
      settings = { ...base.supertonic3, ...(voice ? { voice } : {}), ...(language ? { language } : {}) };
      break;
    case "qwen3":
      settings = qwen3Settings(base.qwen3, preset);
      break;
    default:
      throw new Error(`Engine ${String(engineId)} cannot render here.`);
  }
  return settings as EngineSynthesisSettings[Id];
}

/** One request for `engineId`; the seed of a preset applies unless `options.seed` overrides it. */
export function buildSynthesisRequest<Id extends SurfaceEngineId>(
  engineId: Id,
  base: SynthesisBase,
  text: string,
  options: BuildRequestOptions = {},
): SynthesisRequest<Id> {
  const { preset } = options;
  const seed = options.seed ?? preset?.settings.seed;
  const speed = options.speed ?? preset?.settings.speed ?? base.tuning.speed;
  const tuning: GenerationTuningSettings = {
    ...base.tuning,
    speed,
    quality: preset?.settings.quality ?? base.tuning.quality,
    ...(preset?.settings.language ? { language: preset.settings.language } : {}),
  };
  return {
    text,
    settings: settingsForPreset(engineId, base.settings, preset),
    tuning,
    ...(seed === undefined ? {} : { seed }),
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

/**
 * The adapter between voice presets and runtimes. `getRuntimes` and `getBase`
 * are read per call so a long render always uses the latest runtimes.
 */
export function createRuntimeSynthesize(
  getRuntimes: () => EngineRuntimeMap,
  getBase: () => SynthesisBase,
): PresetSynthesize {
  return async function* synthesizeWithPreset(text, preset, signal): AsyncGenerator<SynthesizedAudioChunk> {
    const engineId = preset.engineId as SurfaceEngineId;
    const runtime = getRuntimes()[engineId] as { synthesize: (request: SynthesisRequest<SurfaceEngineId>) => AsyncIterable<SynthesisChunk> } | undefined;
    if (!runtime) throw new Error(`The ${preset.engineId} engine is not available here.`);
    const request = buildSynthesisRequest(engineId, getBase(), text, { preset, signal });
    for await (const chunk of runtime.synthesize(request)) {
      yield { audio: chunk.audio, samplingRate: chunk.samplingRate };
    }
  };
}

/** The preset that reproduces what Studio currently has selected for `engineId`. */
export function presetFromSelection(engineId: SurfaceEngineId, base: SynthesisBase): VoicePreset {
  const settings = base.settings;
  const common = { speed: base.tuning.speed, quality: base.tuning.quality };
  switch (engineId) {
    case "qwen3": {
      const live = settings.qwen3;
      return {
        engineId,
        voiceId: live.speaker,
        mode: live.profile.mode === "voiceDesign" ? "voiceDesign" : live.profile.mode === "voiceClone" ? "voiceClone" : "preset",
        settings: {
          ...common,
          language: live.language,
          ...(live.instruct ? { instruction: live.instruct } : {}),
          ...(live.seed === null ? {} : { seed: live.seed }),
          extra: { temperature: live.temperature, topK: live.topK },
        },
      };
    }
    case "supertonic":
    case "supertonic3": {
      const live = settings[engineId];
      return { engineId, voiceId: live.voice, settings: { ...common, language: live.language } };
    }
    default:
      return { engineId, voiceId: settings[engineId].voice, settings: common };
  }
}
