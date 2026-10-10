import { MODELS } from "../constants";
import { chunkForKokoroDetailed } from "../lib/chunking";
import { asRecord } from "./settings";
import { audibleTuning } from "./signature";
import type { EngineCapabilities, EngineDescriptor } from "./types";

export interface KokoroSettings {
  voice: string;
}

const KOKORO_PARAMS = "82M";

const KOKORO_VOICE_GROUPS: Readonly<Record<string, string>> = {
  af: "American · Female",
  am: "American · Male",
  bf: "British · Female",
  bm: "British · Male",
};

/** "af_heart" → "Heart" */
export function formatKokoroVoiceName(id: string): string {
  const separator = id.indexOf("_");
  if (separator === -1) return id;
  const name = id.slice(separator + 1).replace(/_/g, " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** The accent section a Kokoro voice id belongs to, from its two-letter prefix. */
export function kokoroVoiceGroup(id: string): string {
  return KOKORO_VOICE_GROUPS[id.slice(0, 2)] ?? "Other";
}

const capabilities: EngineCapabilities = {
  speed: true,
  pauses: true,
  pronunciationLexicon: true,
  quality: null,
  languages: null,
  voiceCloning: null,
  voiceDesign: false,
  instruct: false,
  seed: false,
  expressionTags: [],
  retake: true,
  streamingGranularity: "chunk",
};

function parseKokoroSettings(raw: unknown): KokoroSettings {
  const { voice } = asRecord(raw);
  // The loaded model reports its own voices, so any non-empty id is kept and
  // `resolveKokoroVoice` maps one the model lacks onto a voice it has.
  return {
    voice: typeof voice === "string" && voice.trim().length > 0 ? voice : MODELS.kokoro.defaultVoice,
  };
}

export const kokoroEngine = {
  id: "kokoro",
  label: MODELS.kokoro.label,
  params: KOKORO_PARAMS,
  runtime: "browser-worker",
  targets: ["web", "desktop"],
  picker: "browser",
  capabilities,
  defaultSettings: { voice: MODELS.kokoro.defaultVoice },
  parseSettings: parseKokoroSettings,
  voices: ({ runtimeVoices = [] } = {}) => runtimeVoices.map((id) => ({
    id,
    label: formatKokoroVoiceName(id),
    group: kokoroVoiceGroup(id),
  })),
  voiceLabel: (settings) => formatKokoroVoiceName(settings.voice),
  detail: (settings) => `${KOKORO_PARAMS} · ${formatKokoroVoiceName(settings.voice)}`,
  signatureParts: ({ settings, tuning, quality }) => ({
    voice: settings.voice,
    tuning: audibleTuning(capabilities, tuning, quality),
  }),
  // kokoro.worker.ts generates exactly these units for its resolved backend.
  previewChunks: (text, { backend }) => (text.trim() ? chunkForKokoroDetailed(text, { backend }) : []),
} as const satisfies EngineDescriptor<KokoroSettings>;
