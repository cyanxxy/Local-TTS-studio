import {
  findPiperVoice,
  PIPER_DEFAULT_VOICE,
  PIPER_VOICES,
  type PiperQuality,
  type PiperVoiceEntry,
} from "../lib/piperVoices";
import { chunkPiperText } from "../lib/phonemeModels";
import { PIPER_CATALOG } from "../workers/manifests/piperVoices";
import { asRecord } from "./settings";
import { audibleTuning } from "./signature";
import type { EngineCapabilities, EngineCredit, EngineDescriptor, EngineVoice } from "./types";

export interface PiperSettings {
  /**
   * A catalog voice id, followed by `#<speaker index>` for a multi-speaker
   * voice: the string piper.worker.ts takes as GENERATE `voice`.
   * `parseSettings` guarantees it names a catalog voice and a real speaker.
   */
  voice: string;
}

const PIPER_PARAMS = "VITS";
const SPEAKER_SEPARATOR = "#";

const ACCENT_LABELS: Readonly<Record<string, string>> = {
  en_US: "American",
  en_GB: "British",
};

const QUALITY_LABELS: Readonly<Record<PiperQuality, string>> = {
  x_low: "Compact",
  low: "Light",
  medium: "Medium",
  high: "High",
};

/** The quality tiers in the order a browser lists them, best first. */
export const PIPER_QUALITY_ORDER: readonly PiperQuality[] = ["high", "medium", "low", "x_low"];

export function piperAccentLabel(voice: PiperVoiceEntry): string {
  return ACCENT_LABELS[voice.locale] ?? voice.locale;
}

export function piperQualityLabel(quality: PiperQuality): string {
  return QUALITY_LABELS[quality];
}

/** Bytes downloading a voice's graph and config takes, the first time it is used. */
export function piperVoiceDownloadBytes(voice: PiperVoiceEntry): number {
  const files: Readonly<Record<string, { readonly byteLength: number }>> = PIPER_CATALOG.files;
  return (files[voice.model]?.byteLength ?? 0) + (files[voice.config]?.byteLength ?? 0);
}

/** "en_US-libritts-high#12" → the catalog voice and the speaker index, if any. */
export function splitPiperVoice(value: string): { id: string; speaker: number | null } {
  const separator = value.indexOf(SPEAKER_SEPARATOR);
  if (separator < 0) return { id: value, speaker: null };
  const speaker = value.slice(separator + 1);
  return { id: value.slice(0, separator), speaker: /^\d{1,6}$/.test(speaker) ? Number(speaker) : null };
}

/** The GENERATE voice string for `voice`, with `speaker` when the voice has several. */
export function joinPiperVoice(voice: PiperVoiceEntry, speaker: number | null): string {
  return voice.numSpeakers > 1 && speaker !== null ? `${voice.id}${SPEAKER_SEPARATOR}${speaker}` : voice.id;
}

function piperVoiceTitle(voice: PiperVoiceEntry): string {
  return `${voice.name} · ${piperQualityLabel(voice.quality)}`;
}

function parsePiperVoice(raw: unknown): string {
  if (typeof raw !== "string") return PIPER_DEFAULT_VOICE;
  const { id, speaker } = splitPiperVoice(raw);
  const voice = findPiperVoice(id);
  if (!voice) return PIPER_DEFAULT_VOICE;
  return joinPiperVoice(voice, speaker !== null && speaker < voice.numSpeakers ? speaker : null);
}

function piperVoiceLabel(value: string): string {
  const { id, speaker } = splitPiperVoice(value);
  const voice = findPiperVoice(id);
  if (!voice) return value;
  return speaker === null ? piperVoiceTitle(voice) : `${piperVoiceTitle(voice)} · Speaker ${speaker}`;
}

function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

function voiceEntry(voice: PiperVoiceEntry): EngineVoice {
  return {
    id: voice.id,
    label: piperVoiceTitle(voice),
    group: `${piperAccentLabel(voice)} English`,
    detail: `${formatMegabytes(piperVoiceDownloadBytes(voice))} · ${voice.license.id}`,
  };
}

/** One credit per training dataset, with the catalog's own attribution line. */
function datasetCredits(): EngineCredit[] {
  const byDataset = new Map<string, PiperVoiceEntry[]>();
  for (const voice of PIPER_VOICES) {
    const key = `${voice.datasetUrl ?? voice.id}|${voice.license.id}`;
    byDataset.set(key, [...(byDataset.get(key) ?? []), voice]);
  }
  return [...byDataset.values()].map((voices) => {
    const [first] = voices;
    return {
      name: [...new Set(voices.map((voice) => voice.name))].join(", "),
      license: first.license.id,
      ...(first.license.url ? { licenseUrl: first.license.url } : {}),
      sourceUrl: first.datasetUrl ?? `https://huggingface.co/${PIPER_CATALOG.repo}`,
      note: first.attribution,
    };
  });
}

const capabilities: EngineCapabilities = {
  speed: true,
  pauses: true,
  pronunciationLexicon: true,
  quality: null,
  languages: ["en"],
  voiceCloning: null,
  voiceDesign: false,
  instruct: false,
  seed: false,
  expressionTags: [],
  retake: true,
  streamingGranularity: "chunk",
};

export const piperEngine = {
  id: "piper",
  label: "Piper",
  params: PIPER_PARAMS,
  runtime: "browser-worker",
  targets: ["web", "desktop"],
  picker: "browser",
  wasmOnly: true,
  capabilities,
  credits: [
    {
      name: "Piper voices",
      author: "rhasspy",
      license: "MIT",
      sourceUrl: `https://huggingface.co/${PIPER_CATALOG.repo}`,
      note: "Each voice is trained on a dataset with its own licence, listed below. Text is phonemized with eSpeak NG (GPL-3.0-or-later).",
    },
    ...datasetCredits(),
  ],
  defaultSettings: { voice: PIPER_DEFAULT_VOICE },
  parseSettings: (raw) => ({ voice: parsePiperVoice(asRecord(raw).voice) }),
  voices: () => PIPER_VOICES.map(voiceEntry),
  voiceLabel: (settings) => piperVoiceLabel(settings.voice),
  detail: (settings) => `${PIPER_PARAMS} · ${piperVoiceLabel(settings.voice)}`,
  signatureParts: ({ settings, tuning, quality }) => ({
    voice: settings.voice,
    tuning: audibleTuning(capabilities, tuning, quality),
    legacy: { voice: settings.voice, quality, tuning },
  }),
  // piper.worker.ts plans chunks the same way for every voice.
  previewChunks: (text) => (text.trim() ? chunkPiperText(text) : []),
} as const satisfies EngineDescriptor<PiperSettings>;
