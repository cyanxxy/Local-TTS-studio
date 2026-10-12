import { CHATTERBOX_DEFAULT_REFERENCE_ID } from "../lib/chatterboxProtocol";
import { CHATTERBOX_TAG_TOKENS } from "../lib/chatterboxTags";
import { chunkChatterboxText } from "../lib/phonemeModels";
import { CHATTERBOX_TURBO_ASSETS } from "../workers/manifests/chatterbox";
import { CHATTERBOX_DEFAULT_VOICE_ASSETS } from "../workers/manifests/chatterboxDefaultVoice";
import { asRecord, clampFinite } from "./settings";
import { audibleTuning } from "./signature";
import type { EngineCapabilities, EngineDescriptor } from "./types";

export interface ChatterboxSettings {
  /**
   * The reference voice: `CHATTERBOX_DEFAULT_REFERENCE_ID`, or `<digest>~<name>`
   * for a clip the user loaded (see src/lib/chatterboxClips.ts). The clip itself
   * is not persisted, so an id without a clip falls back to the default voice.
   */
  voice: string;
  /** 0 is greedy decoding; higher is more varied. */
  temperature: number;
  /** Unsigned 32-bit sampling seed, or null for a fresh one each time. */
  seed: number | null;
}

const CHATTERBOX_PARAMS = "350M";
export const CHATTERBOX_TEMPERATURE_RANGE = { min: 0, max: 2, step: 0.05, default: 0.8 } as const;
export const CHATTERBOX_MAX_SEED = 0xffff_ffff;
const MAX_VOICE_LENGTH = 200;
const CLIP_NAME_SEPARATOR = "~";

/** Bytes a cold load downloads: every pinned graph and the built-in voice clip. */
export const CHATTERBOX_DOWNLOAD_BYTES = [CHATTERBOX_TURBO_ASSETS, CHATTERBOX_DEFAULT_VOICE_ASSETS]
  .flatMap((manifest) => Object.values(manifest.files))
  .reduce((total, file) => total + file.byteLength, 0);

/** The `voice` for a loaded clip: its content digest plus the name to show. */
export function chatterboxClipVoice(digest: string, name: string): string {
  const label = name.replace(/\.[^.]+$/, "").trim().slice(0, 60) || "Cloned voice";
  return `${digest}${CLIP_NAME_SEPARATOR}${label}`;
}

export function isChatterboxClipVoice(voice: string): boolean {
  return voice !== CHATTERBOX_DEFAULT_REFERENCE_ID;
}

function chatterboxVoiceLabel(voice: string): string {
  if (!isChatterboxClipVoice(voice)) return "Default voice";
  const separator = voice.indexOf(CLIP_NAME_SEPARATOR);
  return separator < 0 ? "Cloned voice" : voice.slice(separator + 1);
}

const capabilities: EngineCapabilities = {
  // The worker has no speed input.
  speed: false,
  pauses: true,
  pronunciationLexicon: true,
  quality: null,
  languages: ["en"],
  voiceCloning: { reference: "wav", maxSeconds: 10 },
  voiceDesign: false,
  instruct: false,
  seed: true,
  expressionTags: CHATTERBOX_TAG_TOKENS,
  retake: true,
  streamingGranularity: "chunk",
};

function parseChatterboxSettings(raw: unknown): ChatterboxSettings {
  const { voice, temperature, seed } = asRecord(raw);
  return {
    voice: typeof voice === "string" && voice.length > 0 && voice.length <= MAX_VOICE_LENGTH
      ? voice
      : CHATTERBOX_DEFAULT_REFERENCE_ID,
    temperature: clampFinite(
      temperature,
      CHATTERBOX_TEMPERATURE_RANGE.min,
      CHATTERBOX_TEMPERATURE_RANGE.max,
      CHATTERBOX_TEMPERATURE_RANGE.default,
    ),
    seed: typeof seed === "number" && Number.isInteger(seed) && seed >= 0 && seed <= CHATTERBOX_MAX_SEED ? seed : null,
  };
}

export const chatterboxEngine = {
  id: "chatterbox",
  label: "Chatterbox Turbo",
  params: CHATTERBOX_PARAMS,
  runtime: "browser-worker",
  // WebGPU only, which the Electron build can count on far more than a web visitor.
  targets: ["desktop"],
  picker: "browser",
  requiresWebGPU: true,
  capabilities,
  credits: [{
    name: "Chatterbox Turbo",
    author: "Resemble AI",
    license: "MIT",
    sourceUrl: `https://huggingface.co/${CHATTERBOX_TURBO_ASSETS.repo}`,
    note: "ONNX export run through Transformers.js. Voice clips you load are processed on this device and never uploaded.",
  }],
  defaultSettings: { voice: CHATTERBOX_DEFAULT_REFERENCE_ID, temperature: CHATTERBOX_TEMPERATURE_RANGE.default, seed: null },
  parseSettings: parseChatterboxSettings,
  voices: () => [{ id: CHATTERBOX_DEFAULT_REFERENCE_ID, label: "Default voice", detail: "Built-in sample" }],
  voiceLabel: (settings) => chatterboxVoiceLabel(settings.voice),
  detail: (settings) => `${CHATTERBOX_PARAMS} · ${chatterboxVoiceLabel(settings.voice)}`,
  signatureParts: ({ settings, tuning, quality }) => {
    const voice = JSON.stringify({ reference: settings.voice, temperature: settings.temperature, seed: settings.seed });
    return {
      voice,
      tuning: audibleTuning(capabilities, tuning, quality),
      legacy: { voice, quality, tuning },
    };
  },
  // chatterbox.worker.ts plans its passages the same way on every GPU.
  previewChunks: (text) => (text.trim() ? chunkChatterboxText(text) : []),
  workerFields: (settings) => ({
    referenceId: settings.voice,
    temperature: settings.temperature,
    ...(settings.seed === null ? {} : { seed: settings.seed }),
  }),
} as const satisfies EngineDescriptor<ChatterboxSettings>;
