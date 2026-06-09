export interface LocalRuntimeOption {
  value: string;
  label: string;
}

export const QWEN3_CUSTOMVOICE_AUTO_MODEL = "auto";
export const QWEN3_MLX_CUSTOMVOICE_06B_MODEL = "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit";
export const QWEN3_MLX_CUSTOMVOICE_17B_MODEL = "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-6bit";
export const QWEN3_MLX_BASE_06B_MODEL = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-6bit";
export const QWEN3_MLX_BASE_17B_MODEL = "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-6bit";

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
  { value: QWEN3_MLX_CUSTOMVOICE_06B_MODEL, label: "Apple MLX first · CustomVoice · 0.6B · 6-bit" },
  { value: QWEN3_MLX_CUSTOMVOICE_17B_MODEL, label: "Apple MLX first · CustomVoice · 1.7B · 6-bit" },
  { value: QWEN3_MLX_BASE_06B_MODEL, label: "Apple MLX advanced · Base voice clone · 0.6B · 6-bit" },
  { value: QWEN3_MLX_BASE_17B_MODEL, label: "Apple MLX advanced · Base voice clone · 1.7B · 6-bit" },
  { value: QWEN3_CUSTOMVOICE_AUTO_MODEL, label: "Candle fallback · CustomVoice · Auto · 0.6B" },
  { value: "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice", label: "Candle fallback · CustomVoice · 0.6B · 12Hz" },
  { value: "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice", label: "Candle fallback · CustomVoice · 1.7B · 12Hz" },
];

export const QWEN3_DEFAULT_MAX_NEW_TOKENS = 1536;

// Both CustomVoice sizes honor natural-language style instructions — the
// official model cards demonstrate `instruct` on the 0.6B and 1.7B alike — and
// the "auto" alias resolves to the 0.6B CustomVoice. Every Qwen3 option this
// page exposes is therefore instruct-capable.
export const QWEN3_INSTRUCT_CAPABLE_MODELS = new Set<string>([
  "auto",
  "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
  "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
  QWEN3_MLX_CUSTOMVOICE_06B_MODEL,
  QWEN3_MLX_CUSTOMVOICE_17B_MODEL,
]);

export function qwen3SupportsInstruct(model: string): boolean {
  return QWEN3_INSTRUCT_CAPABLE_MODELS.has(model);
}

export function qwen3UsesVoiceClone(model: string): boolean {
  return model.includes("-Base-");
}

export function qwen3UsesMlxCustomVoice(model: string): boolean {
  return model.startsWith("mlx-community/") && model.includes("-CustomVoice-");
}

export function qwen3UsesMlx(model: string): boolean {
  return qwen3UsesMlxCustomVoice(model) || qwen3UsesVoiceClone(model);
}

export function getDefaultQwen3Model(platform: string | undefined): string {
  return platform === "darwin" ? QWEN3_MLX_CUSTOMVOICE_06B_MODEL : QWEN3_CUSTOMVOICE_AUTO_MODEL;
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
  { value: "auto", label: "Auto · Metal then CPU" },
  { value: "cpu", label: "CPU" },
];

export const QWEN3_MAC_DEVICE_OPTIONS: LocalRuntimeOption[] = [
  { value: "auto", label: "Auto · Apple Metal" },
  { value: "metal", label: "Apple Metal" },
  { value: "cpu", label: "CPU" },
];

export function getQwen3DeviceOptions(platform: string | undefined): LocalRuntimeOption[] {
  return platform === "darwin" ? QWEN3_MAC_DEVICE_OPTIONS : QWEN3_DEVICE_OPTIONS;
}

export const QWEN3_DTYPE_OPTIONS: LocalRuntimeOption[] = [
  { value: "auto", label: "Auto" },
  { value: "float32", label: "float32" },
  { value: "bfloat16", label: "bfloat16 (Metal)" },
];

export const QWEN3_ATTENTION_OPTIONS: LocalRuntimeOption[] = [
  { value: "eager", label: "Eager" },
];
