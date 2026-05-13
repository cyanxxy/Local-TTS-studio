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
