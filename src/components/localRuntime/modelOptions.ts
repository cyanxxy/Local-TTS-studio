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

export const QWEN3_OPTIONS: LocalRuntimeOption[] = [
  { value: "auto", label: "Auto · fastest for this device" },
  { value: "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice", label: "CustomVoice · 0.6B · 12Hz" },
  { value: "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice", label: "CustomVoice · 1.7B · 12Hz" },
];

// Both CustomVoice sizes honor natural-language style instructions — the
// official model cards demonstrate `instruct` on the 0.6B and 1.7B alike — and
// the "auto" alias resolves to the 0.6B CustomVoice. Every Qwen3 option this
// page exposes is therefore instruct-capable.
export const QWEN3_INSTRUCT_CAPABLE_MODELS = new Set<string>([
  "auto",
  "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
  "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
]);

export function qwen3SupportsInstruct(model: string): boolean {
  return QWEN3_INSTRUCT_CAPABLE_MODELS.has(model);
}

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
  { value: "Spanish", label: "Spanish" },
];

// All speakers expose the full language list (the model accepts any supported
// language per speaker); kept as a function so the page can stay agnostic to
// whether per-speaker filtering is introduced later.
export function getQwen3LanguageOptionsForSpeaker(speaker: string): LocalRuntimeOption[] {
  void speaker;
  return QWEN3_LANGUAGE_OPTIONS;
}

export const QWEN3_DEVICE_OPTIONS: LocalRuntimeOption[] = [
  { value: "auto", label: "Auto" },
  { value: "cpu", label: "CPU" },
];

export function getQwen3DeviceOptions(platform: string | undefined): LocalRuntimeOption[] {
  void platform;
  return QWEN3_DEVICE_OPTIONS;
}

export const QWEN3_DTYPE_OPTIONS: LocalRuntimeOption[] = [
  { value: "auto", label: "Auto" },
  { value: "float32", label: "float32" },
];

export const QWEN3_ATTENTION_OPTIONS: LocalRuntimeOption[] = [
  { value: "auto", label: "Auto" },
  { value: "eager", label: "Eager" },
];
