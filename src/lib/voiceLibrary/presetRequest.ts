import type { LocalTtsQwen3Setup } from "../../electron";
import type { Qwen3Profile } from "../../../electron/qwen3Profiles";
import { ENGINES, type SurfaceEngineId, type SurfaceEngineSettings } from "../../models/registry";
import { qwen3ProfileSupportsInstruct } from "../../models/qwen3";
import type { Qwen3SynthesisSettings, SynthesisRequest } from "../../shared/engineRuntime";
import type { GenerationTuningSettings } from "../../types";
import { bytesToBase64 } from "./stagedReference";
import type { VoicePreset } from "./types";

/**
 * Turns a VoicePreset (an engine voice plus settings, or a library voice) into
 * the self-contained SynthesisRequest an EngineRuntime renders. Engines read
 * the fields they understand from the preset and keep their current setting
 * for the rest, so a preset saved on one machine renders on another.
 */

export interface LibraryVoiceAudio {
  wav: Uint8Array;
  transcript: string;
  sha256: string;
}

export interface PresetRequestContext {
  /** Creator tuning (speed, pauses, lexicon) the request is rendered with. */
  tuning: GenerationTuningSettings;
  /** What each surface engine reads right now; the fallback for anything a preset leaves out. */
  engineSettings: SurfaceEngineSettings;
  qwen3Profiles: readonly Qwen3Profile[];
  qwen3Setup: LocalTtsQwen3Setup | null;
  /** The reference clip and transcript behind a cloned or designed library voice. */
  loadVoiceAudio: (libraryVoiceId: string) => Promise<LibraryVoiceAudio | null>;
}

export interface PresetRequest {
  engineId: SurfaceEngineId;
  request: SynthesisRequest;
}

export class PresetRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PresetRequestError";
  }
}

export function isSurfaceEngine(engineId: string): engineId is SurfaceEngineId {
  const engine = (ENGINES as Record<string, { picker: string | null } | undefined>)[engineId];
  return engine !== undefined && engine.picker !== null;
}

type Qwen3Mode = Qwen3Profile["mode"];

function qwen3ModeFor(preset: VoicePreset): Qwen3Mode {
  if (preset.mode === "voiceClone") return "voiceClone";
  if (preset.mode === "voiceDesign") return "voiceDesign";
  return "customVoice";
}

const QWEN3_MODE_NAMES: Record<Qwen3Mode, string> = {
  customVoice: "CustomVoice",
  voiceClone: "Base (voice clone)",
  voiceDesign: "VoiceDesign",
};

function installed(setup: LocalTtsQwen3Setup | null, repo: string) {
  const entry = setup?.profiles.find((candidate) => candidate.repo === repo);
  return entry && entry.readiness !== "missing" ? entry : null;
}

function pickQwen3Profile(context: PresetRequestContext, mode: Qwen3Mode): { profile: Qwen3Profile; modelPath: string } {
  const live = context.engineSettings.qwen3;
  const candidates = context.qwen3Profiles.filter((profile) => profile.mode === mode);
  // Keep the profile the user already has when it fits, then any installed one.
  const ordered = [...candidates].sort((a, b) => Number(b.repo === live.profile.repo) - Number(a.repo === live.profile.repo));
  for (const profile of ordered) {
    if (profile.repo === live.profile.repo && live.modelPath.trim()) return { profile, modelPath: live.modelPath };
    const entry = installed(context.qwen3Setup, profile.repo);
    if (entry) return { profile, modelPath: entry.modelDir };
  }
  throw new PresetRequestError(
    `Install a Qwen3 ${QWEN3_MODE_NAMES[mode]} model in Qwen3 model setup to render this voice.`,
  );
}

async function qwen3Request(preset: VoicePreset, context: PresetRequestContext): Promise<Qwen3SynthesisSettings> {
  const live = context.engineSettings.qwen3;
  const mode = qwen3ModeFor(preset);
  const { profile, modelPath } = pickQwen3Profile(context, mode);
  const { settings } = preset;
  const extraTemperature = settings.extra?.temperature;
  const settingsBase: Qwen3SynthesisSettings = {
    ...live,
    profile,
    modelPath,
    language: settings.language ?? live.language,
    seed: settings.seed ?? live.seed,
    temperature: typeof extraTemperature === "number" ? extraTemperature : live.temperature,
    instruct: "",
    referenceAudioBase64: null,
    referenceAudioSignature: "",
    referenceText: "",
  };
  if (mode === "customVoice") {
    return {
      ...settingsBase,
      speaker: preset.voiceId,
      instruct: qwen3ProfileSupportsInstruct(profile) ? settings.instruction ?? "" : "",
    };
  }
  if (mode === "voiceDesign") return { ...settingsBase, instruct: settings.instruction ?? "" };
  if (!preset.libraryVoiceId) throw new PresetRequestError("This voice clone has no saved reference clip.");
  const reference = await context.loadVoiceAudio(preset.libraryVoiceId);
  if (!reference) throw new PresetRequestError("The reference clip for this voice is missing from the library.");
  return {
    ...settingsBase,
    referenceAudioBase64: bytesToBase64(reference.wav),
    referenceAudioSignature: reference.sha256,
    referenceText: reference.transcript,
  };
}

/**
 * Build the request for `text` in `preset`. Throws a PresetRequestError with a
 * user-presentable message when the engine cannot render the preset here.
 */
export async function buildPresetRequest(
  text: string,
  preset: VoicePreset,
  context: PresetRequestContext,
): Promise<PresetRequest> {
  if (!isSurfaceEngine(preset.engineId)) {
    const label = (ENGINES as Record<string, { label: string } | undefined>)[preset.engineId]?.label ?? preset.engineId;
    throw new PresetRequestError(`${label} renders on its own page, so it can't be previewed here.`);
  }
  const { settings } = preset;
  const tuning: GenerationTuningSettings = {
    ...context.tuning,
    speed: settings.speed ?? context.tuning.speed,
    ...(settings.quality !== undefined ? { quality: settings.quality } : {}),
  };
  const common = { text, tuning, ...(settings.seed !== undefined ? { seed: settings.seed } : {}) };
  const live = context.engineSettings;
  switch (preset.engineId) {
    case "kokoro":
      return { engineId: "kokoro", request: { ...common, settings: { voice: preset.voiceId } } };
    case "audio8":
      return { engineId: "audio8", request: { ...common, settings: { voice: preset.voiceId } } };
    case "supertonic":
      return {
        engineId: "supertonic",
        request: { ...common, settings: { voice: preset.voiceId, language: settings.language ?? live.supertonic.language } },
      };
    case "supertonic3":
      return {
        engineId: "supertonic3",
        request: { ...common, settings: { voice: preset.voiceId, language: settings.language ?? live.supertonic3.language } },
      };
    case "qwen3":
      return { engineId: "qwen3", request: { ...common, settings: await qwen3Request(preset, context) } };
    default:
      throw new PresetRequestError(`${preset.engineId} can't be previewed here.`);
  }
}
