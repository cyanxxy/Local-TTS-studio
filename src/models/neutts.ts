import { asRecord, pickAllowed } from "./settings";
import type { EngineCapabilities, EngineDescriptor } from "./types";

/** The GGUF backbones the Electron bridge accepts; each one fixes the language. */
export const NEUTTS_MODEL_OPTIONS = [
  { value: "neuphonic/neutts-nano-q4-gguf", label: "English · neutts-nano · Q4 GGUF" },
  { value: "neuphonic/neutts-air-q4-gguf", label: "English · neutts-air · Q4 GGUF · 0.7B" },
  { value: "neuphonic/neutts-air-q8-gguf", label: "English · neutts-air · Q8 GGUF · 0.7B" },
  { value: "neuphonic/neutts-nano-german-q4-gguf", label: "German · neutts-nano · Q4 GGUF" },
  { value: "neuphonic/neutts-nano-french-q4-gguf", label: "French · neutts-nano · Q4 GGUF" },
  { value: "neuphonic/neutts-nano-spanish-q4-gguf", label: "Spanish · neutts-nano · Q4 GGUF" },
] as const;
export type NeuttsModelRepo = typeof NEUTTS_MODEL_OPTIONS[number]["value"];

export interface NeuttsSettings {
  modelRepo: NeuttsModelRepo;
}

const NEUTTS_PARAMS = "Nano ~0.2B / Air ~0.7B";
const NEUTTS_MODEL_REPOS = NEUTTS_MODEL_OPTIONS.map((option) => option.value);
const NEUTTS_DEFAULT_MODEL: NeuttsModelRepo = NEUTTS_MODEL_OPTIONS[0].value;

function modelLabel(modelRepo: string): string {
  return NEUTTS_MODEL_OPTIONS.find((option) => option.value === modelRepo)?.label ?? modelRepo;
}

const capabilities: EngineCapabilities = {
  speed: false,
  pauses: false,
  pronunciationLexicon: false,
  quality: null,
  // The selected backbone fixes the language.
  languages: null,
  voiceCloning: { reference: "wav-or-codes", maxSeconds: 20 },
  voiceDesign: false,
  instruct: false,
  seed: false,
  expressionTags: [],
  retake: false,
  streamingGranularity: "request",
};

export const neuttsEngine = {
  id: "neutts",
  label: "NeuTTS Nano",
  params: NEUTTS_PARAMS,
  runtime: "rust-bridge",
  targets: ["desktop"],
  // Reachable only from its setup page: every voice is cloned from a reference.
  picker: null,
  setupPage: {
    tabLabel: "NeuTTS Nano",
    name: "NeuTTS Nano / Air (Neuphonic)",
    releaseDate: "February 12, 2026",
    params: NEUTTS_PARAMS,
    highlights: [
      "CPU-friendly speech with instant voice cloning from short references.",
      "Nano variants for English, German, French, and Spanish.",
      "Air Q4 and Q8 add richer English prosody and higher naturalness.",
      "Runs on the Rust bridge with GGUF models and .npy reference codes.",
    ],
    links: [
      { label: "HF Model", href: "https://huggingface.co/neuphonic/neutts-nano" },
      { label: "HF Collection", href: "https://huggingface.co/collections/neuphonic/neutts-nano-multilingual-collection" },
      { label: "HF Air Q4", href: "https://huggingface.co/neuphonic/neutts-air-q4-gguf" },
      { label: "HF Air Q8", href: "https://huggingface.co/neuphonic/neutts-air-q8-gguf" },
      { label: "GitHub", href: "https://github.com/neuphonic/neutts" },
    ],
  },
  capabilities,
  defaultSettings: { modelRepo: NEUTTS_DEFAULT_MODEL },
  parseSettings: (raw: unknown): NeuttsSettings => ({
    modelRepo: pickAllowed(asRecord(raw).modelRepo, NEUTTS_MODEL_REPOS, NEUTTS_DEFAULT_MODEL),
  }),
  voices: () => [],
  voiceLabel: (settings) => modelLabel(settings.modelRepo),
  detail: (settings) => modelLabel(settings.modelRepo),
  // NeuTTS runs only on its setup page, which keeps no section cache.
  signatureParts: () => null,
  // The bridge synthesises the whole text in one request.
  previewChunks: (text) => (text.trim()
    ? [{ text, start: 0, end: text.length, pauseAfterSec: 0, pauseKind: "none" }]
    : []),
} as const satisfies EngineDescriptor<NeuttsSettings>;
