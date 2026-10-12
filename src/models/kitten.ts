import { KITTEN_ASSETS } from "../workers/manifests/kitten";
import { chunkKittenText } from "../lib/phonemeModels";
import { KITTEN_DEFAULT_VOICE, KITTEN_VOICES } from "../lib/kittenVoices";
import { asRecord, pickAllowed } from "./settings";
import { audibleTuning } from "./signature";
import type { EngineCapabilities, EngineDescriptor } from "./types";

export interface KittenSettings {
  /** One of the `KITTEN_VOICES` ids; `parseSettings` guarantees it. */
  voice: string;
}

const KITTEN_PARAMS = "15M";
const KITTEN_VOICE_IDS = KITTEN_VOICES.map((voice) => voice.id);

/** Bytes a cold load downloads: the graph, the voice tables and the config. */
export const KITTEN_DOWNLOAD_BYTES = Object.values(KITTEN_ASSETS.files)
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

function kittenVoiceLabel(id: string): string {
  return KITTEN_VOICES.find((voice) => voice.id === id)?.id ?? id;
}

export const kittenEngine = {
  id: "kitten",
  label: "Kitten TTS",
  params: KITTEN_PARAMS,
  runtime: "browser-worker",
  targets: ["desktop"],
  picker: "browser",
  badge: "Fast",
  capabilities,
  credits: [{
    name: "Kitten TTS Nano 0.8",
    author: "KittenML",
    license: "Apache-2.0",
    licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
    sourceUrl: `https://huggingface.co/${KITTEN_ASSETS.repo}`,
    note: "Text is phonemized with eSpeak NG (GPL-3.0-or-later).",
  }],
  defaultSettings: { voice: KITTEN_DEFAULT_VOICE },
  parseSettings: (raw) => ({ voice: pickAllowed(asRecord(raw).voice, KITTEN_VOICE_IDS, KITTEN_DEFAULT_VOICE) }),
  voices: () => KITTEN_VOICES.map((voice) => ({
    id: voice.id,
    label: voice.id,
    detail: `English · ${voice.gender === "female" ? "Female" : "Male"}`,
  })),
  voiceLabel: (settings) => kittenVoiceLabel(settings.voice),
  detail: (settings) => `${KITTEN_PARAMS} · ${kittenVoiceLabel(settings.voice)}`,
  signatureParts: ({ settings, tuning, quality }) => ({
    voice: settings.voice,
    tuning: audibleTuning(capabilities, tuning, quality),
    legacy: { voice: settings.voice, quality, tuning },
  }),
  // kitten.worker.ts plans chunks for the backend it resolved at load.
  previewChunks: (text, { backend }) => (text.trim() ? chunkKittenText(text, backend) : []),
} as const satisfies EngineDescriptor<KittenSettings>;
