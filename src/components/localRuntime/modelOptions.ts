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

export const KANI_LANGUAGE_TAG_OPTIONS: LocalRuntimeOption[] = [
  { value: "en_us", label: "English · US" },
  { value: "en_nyork", label: "English · New York" },
  { value: "en_oakl", label: "English · Oakland" },
  { value: "en_glasg", label: "English · Glasgow" },
  { value: "en_bost", label: "English · Boston" },
  { value: "en_scou", label: "English · Liverpool" },
];

export const DEFAULT_KANI_LANGUAGE_TAG = KANI_LANGUAGE_TAG_OPTIONS[0].value;

export const QWEN3_OPTIONS: LocalRuntimeOption[] = [
  { value: "auto", label: "Auto · fastest for this device" },
  { value: "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice", label: "CustomVoice · 0.6B · 12Hz" },
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
  void speaker;
  return QWEN3_LANGUAGE_OPTIONS;
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
  { value: "float16", label: "float16 (advanced)" },
  { value: "float32", label: "float32" },
];

export const QWEN3_ATTENTION_OPTIONS: LocalRuntimeOption[] = [
  { value: "auto", label: "Auto" },
  { value: "flash_attention_2", label: "FlashAttention 2" },
  { value: "sdpa", label: "SDPA" },
  { value: "eager", label: "Eager" },
];
