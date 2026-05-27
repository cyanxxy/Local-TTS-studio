export interface LocalRuntimeOption {
  value: string;
  label: string;
}

export const NEUTTS_OPTIONS: LocalRuntimeOption[] = [
  { value: "neuphonic/neutts-nano", label: "English · neutts-nano" },
  { value: "neuphonic/neutts-nano-german", label: "German · neutts-nano-german" },
  { value: "neuphonic/neutts-nano-french", label: "French · neutts-nano-french" },
  { value: "neuphonic/neutts-nano-spanish", label: "Spanish · neutts-nano-spanish" },
];

export const KANI_OPTIONS: LocalRuntimeOption[] = [
  { value: "nineninesix/kani-tts-2-en", label: "English · kani-tts-2-en" },
];

export const QWEN3_OPTIONS: LocalRuntimeOption[] = [
  { value: "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice", label: "CustomVoice · 1.7B · 12Hz" },
];

export const QWEN3_SPEAKER_OPTIONS: LocalRuntimeOption[] = [
  { value: "Ryan", label: "Ryan · English · dynamic male" },
  { value: "Aiden", label: "Aiden · English · sunny American male" },
  { value: "Vivian", label: "Vivian · Chinese · bright female" },
  { value: "Serena", label: "Serena · Chinese · warm female" },
  { value: "Uncle_Fu", label: "Uncle Fu · Chinese · low male" },
  { value: "Dylan", label: "Dylan · Beijing dialect male" },
  { value: "Eric", label: "Eric · Sichuan dialect male" },
  { value: "Ono_Anna", label: "Ono Anna · Japanese female" },
  { value: "Sohee", label: "Sohee · Korean female" },
];

export const QWEN3_LANGUAGE_OPTIONS: LocalRuntimeOption[] = [
  { value: "Auto", label: "Auto" },
  { value: "English", label: "English" },
  { value: "Chinese", label: "Chinese" },
  { value: "Japanese", label: "Japanese" },
  { value: "Korean", label: "Korean" },
  { value: "German", label: "German" },
  { value: "French", label: "French" },
  { value: "Russian", label: "Russian" },
  { value: "Portuguese", label: "Portuguese" },
  { value: "Spanish", label: "Spanish" },
  { value: "Italian", label: "Italian" },
];

export const QWEN3_SPEAKER_PRIMARY_LANGUAGE: Record<string, string> = {
  Ryan: "English",
  Aiden: "English",
  Vivian: "Chinese",
  Serena: "Chinese",
  Uncle_Fu: "Chinese",
  Dylan: "Chinese",
  Eric: "Chinese",
  Ono_Anna: "Japanese",
  Sohee: "Korean",
};

export function getQwen3LanguageOptionsForSpeaker(speaker: string): LocalRuntimeOption[] {
  const primaryLanguage = QWEN3_SPEAKER_PRIMARY_LANGUAGE[speaker];
  if (!primaryLanguage) return QWEN3_LANGUAGE_OPTIONS;
  return QWEN3_LANGUAGE_OPTIONS.filter((option) => (
    option.value === "Auto" || option.value === primaryLanguage
  ));
}

export const QWEN3_DEVICE_OPTIONS: LocalRuntimeOption[] = [
  { value: "auto", label: "Auto" },
  { value: "cuda:0", label: "CUDA 0" },
  { value: "cpu", label: "CPU" },
  { value: "mps", label: "Apple MPS" },
];

export const QWEN3_DTYPE_OPTIONS: LocalRuntimeOption[] = [
  { value: "auto", label: "Auto" },
  { value: "bfloat16", label: "bfloat16" },
  { value: "float16", label: "float16" },
  { value: "float32", label: "float32" },
];

export const QWEN3_ATTENTION_OPTIONS: LocalRuntimeOption[] = [
  { value: "auto", label: "Auto" },
  { value: "flash_attention_2", label: "FlashAttention 2" },
  { value: "sdpa", label: "SDPA" },
  { value: "eager", label: "Eager" },
];
