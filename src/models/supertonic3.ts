import { SUPERTONIC3_LANGUAGES, SUPERTONIC3_VOICES } from "../constants";
import { chunkForSupertonicDetailed } from "../lib/chunking";
import { asRecord, parseSeed, pickAllowed } from "./settings";
import { audibleTuning } from "./signature";
import { SUPERTONIC_QUALITY_RANGE } from "./supertonic";
import type { EngineCapabilities, EngineDescriptor } from "./types";

export type Supertonic3Voice = typeof SUPERTONIC3_VOICES[number];
export type Supertonic3Language = typeof SUPERTONIC3_LANGUAGES[number];

export const SUPERTONIC3_LANGUAGE_NAMES: Readonly<Record<Supertonic3Language, string>> = {
  en: "English", ko: "Korean", ja: "Japanese", ar: "Arabic", bg: "Bulgarian", cs: "Czech",
  da: "Danish", de: "German", el: "Greek", es: "Spanish", et: "Estonian", fi: "Finnish",
  fr: "French", hi: "Hindi", hr: "Croatian", hu: "Hungarian", id: "Indonesian", it: "Italian",
  lt: "Lithuanian", lv: "Latvian", nl: "Dutch", pl: "Polish", pt: "Portuguese", ro: "Romanian",
  ru: "Russian", sk: "Slovak", sl: "Slovenian", sv: "Swedish", tr: "Turkish", uk: "Ukrainian", vi: "Vietnamese",
};

/**
 * The passage bounds supertonic3.worker.ts applies. Korean and Japanese pack
 * more speech into each character, so their passages are cut shorter.
 */
export const SUPERTONIC3_CHUNK_LIMITS = {
  minCharacters: 30,
  maxCharacters: 280,
  denseScriptMaxCharacters: 120,
  denseScriptLanguages: ["ko", "ja"],
} as const satisfies {
  minCharacters: number;
  maxCharacters: number;
  denseScriptMaxCharacters: number;
  denseScriptLanguages: readonly Supertonic3Language[];
};

export interface Supertonic3Settings {
  /** One of `SUPERTONIC3_VOICES`; `parseSettings` guarantees it. */
  voice: string;
  /** One of `SUPERTONIC3_LANGUAGES`; `parseSettings` guarantees it. */
  language: string;
  /** Unsigned 32-bit sampling seed, or null for a fresh one each time. */
  seed: number | null;
}

const SUPERTONIC3_PARAMS = "99M";

const capabilities: EngineCapabilities = {
  speed: true,
  pauses: true,
  pronunciationLexicon: true,
  quality: SUPERTONIC_QUALITY_RANGE,
  languages: SUPERTONIC3_LANGUAGES,
  voiceCloning: null,
  voiceDesign: false,
  instruct: false,
  seed: true,
  expressionTags: ["<laugh>", "<breath>", "<sigh>"],
  retake: false,
  streamingGranularity: "chunk",
};

function parseSupertonic3Settings(raw: unknown): Supertonic3Settings {
  const record = asRecord(raw);
  return {
    voice: pickAllowed(record.voice, SUPERTONIC3_VOICES, "M1"),
    language: pickAllowed(record.language, SUPERTONIC3_LANGUAGES, "en"),
    seed: parseSeed(record.seed),
  };
}

export const supertonic3Engine = {
  id: "supertonic3",
  label: "Supertonic 3",
  params: SUPERTONIC3_PARAMS,
  runtime: "renderer-worker",
  targets: ["desktop"],
  picker: "desktop",
  badge: "Electron",
  capabilities,
  defaultSettings: { voice: "M1", language: "en", seed: null },
  parseSettings: parseSupertonic3Settings,
  voices: () => SUPERTONIC3_VOICES.map((id) => ({ id, label: id })),
  voiceLabel: (settings) => settings.voice,
  detail: (settings) => `${SUPERTONIC3_PARAMS} · ${settings.language.toUpperCase()} · ${settings.voice}`,
  signatureParts: ({ settings, tuning, quality }) => ({
    // A fixed seed changes the audio; it joins the signature only when set.
    voice: settings.seed === null ? settings.voice : `${settings.voice}#seed=${settings.seed}`,
    tuning: audibleTuning(capabilities, tuning, quality, settings.language),
    legacy: { voice: `${settings.voice}:${settings.language}`, quality, tuning: tuning },
  }),
  previewChunks: (text, { settings, backend, quality }) => chunkForSupertonicDetailed(text, {
    minCharacters: SUPERTONIC3_CHUNK_LIMITS.minCharacters,
    maxCharacters: (SUPERTONIC3_CHUNK_LIMITS.denseScriptLanguages as readonly string[]).includes(settings.language)
      ? SUPERTONIC3_CHUNK_LIMITS.denseScriptMaxCharacters
      : SUPERTONIC3_CHUNK_LIMITS.maxCharacters,
    runtime: { backend, quality },
  }),
} as const satisfies EngineDescriptor<Supertonic3Settings>;
