import { PARADEE_ASSETS } from "../workers/manifests/paradee";
import { chunkParadeeText } from "../lib/phonemeModels";
import { asRecord, pickAllowed } from "./settings";
import { audibleTuning } from "./signature";
import type { EngineCapabilities, EngineDescriptor } from "./types";

export interface ParadeeSettings {
  /** Paradee distils one voice; `parseSettings` guarantees it. */
  voice: string;
}

const PARADEE_PARAMS = "8M";
/** The one voice paradee.worker.ts reports (the af_heart distillation). */
export const PARADEE_VOICE_ID = "heart";
const PARADEE_VOICE_IDS = [PARADEE_VOICE_ID] as const;

/** Bytes a cold load downloads: the graph and the config. */
export const PARADEE_DOWNLOAD_BYTES = Object.values(PARADEE_ASSETS.files)
  .reduce((total, file) => total + file.byteLength, 0);

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

function paradeeVoiceLabel(id: string): string {
  return id === PARADEE_VOICE_ID ? "Heart" : id;
}

export const paradeeEngine = {
  id: "paradee",
  label: "Paradee",
  params: PARADEE_PARAMS,
  runtime: "browser-worker",
  targets: ["web", "desktop"],
  picker: "browser",
  wasmOnly: true,
  capabilities,
  credits: [{
    name: "Paradee-8M v1.0",
    author: "Sahil Mahendrakar",
    license: "Apache-2.0",
    licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
    sourceUrl: `https://huggingface.co/${PARADEE_ASSETS.repo}`,
    note: "Distilled from Kokoro-82M's af_heart voice. Text is phonemized with eSpeak NG (GPL-3.0-or-later).",
  }],
  defaultSettings: { voice: PARADEE_VOICE_ID },
  parseSettings: (raw) => ({ voice: pickAllowed(asRecord(raw).voice, PARADEE_VOICE_IDS, PARADEE_VOICE_ID) }),
  voices: () => [{ id: PARADEE_VOICE_ID, label: "Heart", detail: "English · Female" }],
  voiceLabel: (settings) => paradeeVoiceLabel(settings.voice),
  detail: (settings) => `${PARADEE_PARAMS} · ${paradeeVoiceLabel(settings.voice)}`,
  signatureParts: ({ settings, tuning, quality }) => ({
    voice: settings.voice,
    tuning: audibleTuning(capabilities, tuning, quality),
    legacy: { voice: settings.voice, quality, tuning },
  }),
  // paradee.worker.ts plans chunks the same way on every backend.
  previewChunks: (text) => (text.trim() ? chunkParadeeText(text) : []),
} as const satisfies EngineDescriptor<ParadeeSettings>;
