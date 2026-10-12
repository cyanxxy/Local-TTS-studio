import { AUDIO8_DEFAULT_VOICE, AUDIO8_VOICES } from "../constants";
import { chunkWithConstraintsDetailed, type TextChunk } from "../lib/chunking";
import { asRecord, pickAllowed } from "./settings";
import { audibleTuning } from "./signature";
import type { EngineCapabilities, EngineDescriptor } from "./types";

export type Audio8VoiceId = typeof AUDIO8_VOICES[number]["id"];

export interface Audio8Settings {
  /** One of the `AUDIO8_VOICES` ids; `parseSettings` guarantees it. */
  voice: string;
}

// Audio8 re-prefills the voice-reference prompt before every chunk emits its
// first token, so small chunks pay that fixed cost over and over; large ones
// delay the first audible sample. 180 characters is the compromise. Kokoro
// derives its budget from the backend (`KOKORO_*_MAX_INFERENCE_CHARS`) and
// Qwen3 mirrors the Rust unit size (`QWEN3_UNIT_MAX_CHARS`); Audio8 has no
// equivalent upstream constraint to mirror, so the number is tuned here.
// `getAdaptiveChunkLimits` clamps the floor up to 40 regardless; 30 is kept
// verbatim because it is what sets the derived 105-character target.
const AUDIO8_MIN_CHUNK_CHARACTERS = 30;
const AUDIO8_MAX_CHUNK_CHARACTERS = 180;
const AUDIO8_PARAMS = "0.6B";
const AUDIO8_VOICE_IDS = AUDIO8_VOICES.map((voice) => voice.id);

/**
 * The renderer-side passages Audio8 synthesises one IPC request at a time.
 * The runtime and the Reader preview both call this, so they cannot drift.
 */
export function chunkAudio8Text(text: string): TextChunk[] {
  return chunkWithConstraintsDetailed(text, {
    minCharacters: AUDIO8_MIN_CHUNK_CHARACTERS,
    maxCharacters: AUDIO8_MAX_CHUNK_CHARACTERS,
  });
}

function audio8VoiceName(voice: string): string {
  return AUDIO8_VOICES.find((item) => item.id === voice)?.name ?? voice;
}

const capabilities: EngineCapabilities = {
  // Audio8 speaks at its model-native rate; the seeded sampler is fixed.
  speed: false,
  pauses: true,
  pronunciationLexicon: true,
  quality: null,
  languages: null,
  voiceCloning: null,
  voiceDesign: false,
  instruct: false,
  seed: false,
  expressionTags: [],
  retake: false,
  streamingGranularity: "chunk",
};

export const audio8Engine = {
  id: "audio8",
  label: "Audio8 TTS",
  params: AUDIO8_PARAMS,
  runtime: "native-worker",
  targets: ["desktop"],
  picker: "desktop",
  badge: "Local",
  capabilities,
  defaultSettings: { voice: AUDIO8_DEFAULT_VOICE },
  parseSettings: (raw: unknown): Audio8Settings => ({
    voice: pickAllowed(asRecord(raw).voice, AUDIO8_VOICE_IDS, AUDIO8_DEFAULT_VOICE),
  }),
  voices: () => AUDIO8_VOICES.map(({ id, name, detail }) => ({ id, label: name, detail })),
  voiceLabel: (settings) => audio8VoiceName(settings.voice),
  detail: (settings) => `${AUDIO8_PARAMS} · ONNX INT4 · ${audio8VoiceName(settings.voice)}`,
  signatureParts: ({ settings, tuning, quality }) => ({
    voice: settings.voice,
    tuning: audibleTuning(capabilities, tuning, quality),
    legacy: { voice: settings.voice, quality, tuning: { ...tuning, speed: 1 } },
  }),
  previewChunks: (text) => chunkAudio8Text(text),
} as const satisfies EngineDescriptor<Audio8Settings>;
