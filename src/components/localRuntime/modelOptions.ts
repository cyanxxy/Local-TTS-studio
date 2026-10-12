import {
  getDefaultQwen3Profile,
  getQwen3Profile,
  getQwen3Profiles,
  QWEN3_DEFAULT_SPEAKER,
  QWEN3_LANGUAGES,
  QWEN3_SPEAKER_NATIVE_LANGUAGES,
  QWEN3_SPEAKERS,
} from "../../../electron/qwen3Profiles";
import { NEUTTS_MODEL_OPTIONS } from "../../models/neutts";
import { qwen3ProfileSupportsInstruct } from "../../models/qwen3";

export interface LocalRuntimeOption {
  value: string;
  label: string;
}

export const NEUTTS_OPTIONS: LocalRuntimeOption[] = NEUTTS_MODEL_OPTIONS.map(({ value, label }) => ({ value, label }));

const QWEN3_SPEAKER_OPTION_ORDER = [
  QWEN3_DEFAULT_SPEAKER,
  ...QWEN3_SPEAKERS.filter((speaker) => (
    speaker !== QWEN3_DEFAULT_SPEAKER
    && QWEN3_SPEAKER_NATIVE_LANGUAGES[speaker] === "English"
  )),
  ...QWEN3_SPEAKERS.filter((speaker) => QWEN3_SPEAKER_NATIVE_LANGUAGES[speaker] !== "English"),
];

export const QWEN3_SPEAKER_OPTIONS: LocalRuntimeOption[] = QWEN3_SPEAKER_OPTION_ORDER.map((speaker) => ({
  value: speaker,
  label: `${speaker.replace(/_/g, " ")} · ${QWEN3_SPEAKER_NATIVE_LANGUAGES[speaker]}`,
}));

export const QWEN3_LANGUAGE_OPTIONS: LocalRuntimeOption[] = QWEN3_LANGUAGES.map((language) => ({
  value: language,
  label: language,
}));

export function getDefaultQwen3Model(platform: string | undefined, arch: string | undefined): string {
  return getDefaultQwen3Profile(platform, arch).repo;
}

export function getQwen3Options(platform: string | undefined, arch: string | undefined): LocalRuntimeOption[] {
  return getQwen3Profiles(platform, arch).map((profile) => ({ value: profile.repo, label: profile.label }));
}

export function qwen3UsesVoiceClone(model: string): boolean {
  return model.includes("-Base");
}

export function qwen3UsesVoiceDesign(model: string): boolean {
  return model.includes("-VoiceDesign");
}

/**
 * Whether the model is conditioned on an `instruct` prompt. VoiceDesign needs
 * one; voice cloning has none; and upstream's 0.6B CustomVoice wrapper drops
 * it, as the bundled engine does, so the UI must not offer an ignored control.
 * Decided from the pinned profile table, never from the repository name.
 */
export function qwen3SupportsInstruct(model: string): boolean {
  const profile = getQwen3Profile(model);
  return profile ? qwen3ProfileSupportsInstruct(profile) : false;
}
