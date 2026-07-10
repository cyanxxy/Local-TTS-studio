import {
  getDefaultQwen3Profile,
  getQwen3Profiles,
  QWEN3_LANGUAGES,
  QWEN3_SPEAKERS,
} from "../../../electron/qwen3Profiles";

export interface LocalRuntimeOption {
  value: string;
  label: string;
}

export const NEUTTS_OPTIONS: LocalRuntimeOption[] = [
  { value: "neuphonic/neutts-nano-q4-gguf", label: "English · neutts-nano · Q4 GGUF" },
  { value: "neuphonic/neutts-nano-q8-gguf", label: "English · neutts-nano · Q8 GGUF" },
  { value: "neuphonic/neutts-nano-german-q4-gguf", label: "German · neutts-nano · Q4 GGUF" },
  { value: "neuphonic/neutts-nano-german-q8-gguf", label: "German · neutts-nano · Q8 GGUF" },
  { value: "neuphonic/neutts-nano-french-q4-gguf", label: "French · neutts-nano · Q4 GGUF" },
  { value: "neuphonic/neutts-nano-french-q8-gguf", label: "French · neutts-nano · Q8 GGUF" },
  { value: "neuphonic/neutts-nano-spanish-q4-gguf", label: "Spanish · neutts-nano · Q4 GGUF" },
  { value: "neuphonic/neutts-nano-spanish-q8-gguf", label: "Spanish · neutts-nano · Q8 GGUF" },
];

export const QWEN3_SPEAKER_OPTIONS: LocalRuntimeOption[] = QWEN3_SPEAKERS.map((speaker) => ({
  value: speaker,
  label: speaker.replace("_", " "),
}));

export const QWEN3_LANGUAGE_OPTIONS: LocalRuntimeOption[] = QWEN3_LANGUAGES.map((language) => ({
  value: language,
  label: language,
}));

export function getDefaultQwen3Model(platform: string | undefined): string {
  return getDefaultQwen3Profile(platform).repo;
}

export function getQwen3Options(platform: string | undefined): LocalRuntimeOption[] {
  return getQwen3Profiles(platform).map((profile) => ({ value: profile.repo, label: profile.label }));
}

export function qwen3UsesVoiceClone(model: string): boolean {
  return model.includes("-Base");
}

export function qwen3SupportsInstruct(model: string): boolean {
  return !qwen3UsesVoiceClone(model);
}
