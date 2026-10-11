import {
  MODELS,
  QUALITY_DEFAULT,
  QUALITY_MAX,
  QUALITY_MIN,
  QUALITY_STEP,
} from "../constants";
import { chunkForSupertonicDetailed } from "../lib/chunking";
import { asRecord, pickAllowed } from "./settings";
import { audibleTuning } from "./signature";
import type { EngineCapabilities, EngineDescriptor, EngineQualityRange } from "./types";

/** Language tags supertonic.worker.ts accepts; anything else is rejected there. */
export const SUPERTONIC_LANGUAGES = ["en", "ko", "es", "pt", "fr"] as const;
export type SupertonicLanguage = typeof SUPERTONIC_LANGUAGES[number];
export type SupertonicVoice = typeof MODELS.supertonic.voices[number];

export const SUPERTONIC_LANGUAGE_NAMES: Readonly<Record<SupertonicLanguage, string>> = {
  en: "English",
  ko: "Korean",
  es: "Spanish",
  pt: "Portuguese",
  fr: "French",
};

export interface SupertonicSettings {
  /** One of `MODELS.supertonic.voices`; `parseSettings` guarantees it. */
  voice: string;
  /** One of `SUPERTONIC_LANGUAGES`; `parseSettings` guarantees it. */
  language: string;
}

const SUPERTONIC_PARAMS = "300M";
const SUPERTONIC_DEFAULT_LANGUAGE: SupertonicLanguage = "en";

/** Denoising steps, shared by both Supertonic generations. */
export const SUPERTONIC_QUALITY_RANGE: EngineQualityRange = {
  min: QUALITY_MIN,
  max: QUALITY_MAX,
  step: QUALITY_STEP,
  default: QUALITY_DEFAULT,
};

const capabilities: EngineCapabilities = {
  speed: true,
  pauses: true,
  pronunciationLexicon: true,
  quality: SUPERTONIC_QUALITY_RANGE,
  languages: SUPERTONIC_LANGUAGES,
  voiceCloning: null,
  voiceDesign: false,
  instruct: false,
  seed: false,
  expressionTags: [],
  retake: true,
  streamingGranularity: "chunk",
};

function parseSupertonicSettings(raw: unknown): SupertonicSettings {
  const record = asRecord(raw);
  return {
    voice: pickAllowed(record.voice, MODELS.supertonic.voices, MODELS.supertonic.defaultVoice),
    language: pickAllowed(record.language, SUPERTONIC_LANGUAGES, SUPERTONIC_DEFAULT_LANGUAGE),
  };
}

export const supertonicEngine = {
  id: "supertonic",
  label: MODELS.supertonic.label,
  params: SUPERTONIC_PARAMS,
  runtime: "browser-worker",
  // Electron replaces the legacy Supertonic 2 browser runtime with Supertonic 3.
  targets: ["web"],
  picker: "browser",
  capabilities,
  defaultSettings: {
    voice: MODELS.supertonic.defaultVoice,
    language: SUPERTONIC_DEFAULT_LANGUAGE,
  },
  parseSettings: parseSupertonicSettings,
  voices: () => MODELS.supertonic.voices.map((id) => ({ id, label: id })),
  voiceLabel: (settings) => settings.voice,
  detail: (settings) => `${SUPERTONIC_PARAMS} · ${settings.language.toUpperCase()} · ${settings.voice}`,
  signatureParts: ({ settings, tuning, quality }) => ({
    voice: settings.voice,
    tuning: audibleTuning(capabilities, tuning, quality, settings.language),
  }),
  // supertonic.worker.ts chunks with its resolved backend and the request quality.
  previewChunks: (text, { backend, quality }) => chunkForSupertonicDetailed(text, {
    runtime: { backend, quality },
  }),
} as const satisfies EngineDescriptor<SupertonicSettings>;
