import { buildQwen3RequestPlan } from "../lib/qwenChunking";
import { asRecord, clampFinite, pickAllowed } from "./settings";
import type { EngineCapabilities, EngineDescriptor } from "./types";

// The speaker, language, and sampling tables below mirror
// `electron/qwen3Profiles.ts` and `electron/localTtsLimits.ts`, which the
// registry may not import. `registry.parity.test.ts` pins every value to its source.

export const QWEN3_ENGINE_LANGUAGES = [
  "Auto",
  "Chinese",
  "English",
  "Japanese",
  "Korean",
  "German",
  "French",
  "Russian",
  "Portuguese",
  "Spanish",
  "Italian",
] as const;
export type Qwen3EngineLanguage = typeof QWEN3_ENGINE_LANGUAGES[number];

/** Preset CustomVoice speakers and the language each one was trained on. */
export const QWEN3_ENGINE_SPEAKERS = [
  { id: "Vivian", nativeLanguage: "Chinese" },
  { id: "Serena", nativeLanguage: "Chinese" },
  { id: "Uncle_Fu", nativeLanguage: "Chinese" },
  { id: "Dylan", nativeLanguage: "Chinese" },
  { id: "Eric", nativeLanguage: "Chinese" },
  { id: "Ryan", nativeLanguage: "English" },
  { id: "Aiden", nativeLanguage: "English" },
  { id: "Ono_Anna", nativeLanguage: "Japanese" },
  { id: "Sohee", nativeLanguage: "Korean" },
] as const satisfies ReadonlyArray<{ id: string; nativeLanguage: Qwen3EngineLanguage }>;
export type Qwen3EngineSpeaker = typeof QWEN3_ENGINE_SPEAKERS[number]["id"];

export const QWEN3_ENGINE_DEFAULT_SPEAKER: Qwen3EngineSpeaker = "Aiden";
export const QWEN3_ENGINE_DEFAULT_LANGUAGE: Qwen3EngineLanguage = "English";

export const QWEN3_TEMPERATURE_RANGE = { min: 0, max: 2, default: 0.9 } as const;
export const QWEN3_TOP_K_RANGE = { min: 1, max: 1_000, default: 50 } as const;
/** Per-passage codec-token limit; the bridge never exceeds 384 per passage. */
export const QWEN3_MAX_NEW_TOKENS_RANGE = { min: 64, max: 384, default: 384 } as const;
export const QWEN3_ENGINE_MAX_SEED = 0xFFFF_FFFF;
/** The IPC request validator rejects longer instructions. */
export const QWEN3_INSTRUCT_MAX_LENGTH = 1_000;

export type Qwen3EngineMode = "customVoice" | "voiceClone" | "voiceDesign";
type Qwen3InstructMode = Extract<Qwen3EngineMode, "customVoice" | "voiceDesign">;

/** The Qwen3 settings that persist across launches. Reference audio never does. */
export interface Qwen3Settings {
  /** Null keeps the platform's default profile. */
  profileRepo: string | null;
  /** One of `QWEN3_ENGINE_SPEAKERS`; `parseSettings` guarantees it. */
  speaker: string;
  /** One of `QWEN3_ENGINE_LANGUAGES`; `parseSettings` guarantees it. */
  language: string;
  /** VoiceDesign describes a whole voice and CustomVoice only styles one, so each keeps its own text. */
  instructByMode: Record<Qwen3InstructMode, string>;
  temperature: number;
  topK: number;
  maxNewTokens: number;
  /** A fixed sampling seed for repeatable output, or null for random sampling. */
  seed: number | null;
}

/** What the runtime reads at generation time; `Qwen3RuntimeSettings` satisfies it. */
export interface Qwen3LiveSettings {
  profile: {
    repo: string;
    revision: string;
    mode: Qwen3EngineMode;
    parameters: string;
    provider: string;
  };
  modelPath: string;
  speaker: string;
  language: string;
  instruct: string;
  temperature: number;
  topK: number;
  maxNewTokens: number;
  seed: number | null;
  referenceAudioSignature: string;
  referenceText: string;
}

const QWEN3_SPEAKER_IDS = QWEN3_ENGINE_SPEAKERS.map((speaker) => speaker.id);
const HUGGING_FACE_REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * Whether a profile is conditioned on `instruct`: VoiceDesign needs one, voice
 * cloning has none, and the 0.6B CustomVoice wrapper drops it, as the bundled
 * engine does.
 */
export function qwen3ProfileSupportsInstruct(profile: { mode: Qwen3EngineMode; parameters: string }): boolean {
  if (profile.mode === "voiceDesign") return true;
  if (profile.mode === "voiceClone") return false;
  return profile.parameters !== "0.6B";
}

function modeLabel(settings: Qwen3LiveSettings, speaker: string): string {
  if (settings.profile.mode === "customVoice") return speaker;
  return settings.profile.mode === "voiceDesign" ? "VoiceDesign" : "Voice clone";
}

function parseInstruct(value: unknown): string {
  return typeof value === "string" ? value.slice(0, QWEN3_INSTRUCT_MAX_LENGTH) : "";
}

function parseQwen3Settings(raw: unknown): Qwen3Settings {
  const record = asRecord(raw);
  const instructByMode = asRecord(record.instructByMode);
  const seed = record.seed;
  return {
    profileRepo: typeof record.profileRepo === "string" && HUGGING_FACE_REPO.test(record.profileRepo)
      ? record.profileRepo
      : null,
    speaker: pickAllowed(record.speaker, QWEN3_SPEAKER_IDS, QWEN3_ENGINE_DEFAULT_SPEAKER),
    language: pickAllowed(record.language, QWEN3_ENGINE_LANGUAGES, QWEN3_ENGINE_DEFAULT_LANGUAGE),
    instructByMode: {
      customVoice: parseInstruct(instructByMode.customVoice),
      voiceDesign: parseInstruct(instructByMode.voiceDesign),
    },
    temperature: clampFinite(
      record.temperature,
      QWEN3_TEMPERATURE_RANGE.min,
      QWEN3_TEMPERATURE_RANGE.max,
      QWEN3_TEMPERATURE_RANGE.default,
    ),
    topK: Math.round(clampFinite(record.topK, QWEN3_TOP_K_RANGE.min, QWEN3_TOP_K_RANGE.max, QWEN3_TOP_K_RANGE.default)),
    maxNewTokens: Math.round(clampFinite(
      record.maxNewTokens,
      QWEN3_MAX_NEW_TOKENS_RANGE.min,
      QWEN3_MAX_NEW_TOKENS_RANGE.max,
      QWEN3_MAX_NEW_TOKENS_RANGE.default,
    )),
    seed: typeof seed === "number" && Number.isFinite(seed)
      ? Math.round(clampFinite(seed, 0, QWEN3_ENGINE_MAX_SEED, 0))
      : null,
  };
}

const capabilities: EngineCapabilities = {
  // The bridge receives the script as written and paces its own units.
  speed: false,
  pauses: false,
  pronunciationLexicon: false,
  quality: null,
  languages: QWEN3_ENGINE_LANGUAGES,
  voiceCloning: { reference: "wav", maxSeconds: 20 },
  voiceDesign: true,
  instruct: true,
  seed: true,
  expressionTags: [],
  retake: false,
  streamingGranularity: "unit",
};

export const qwen3Engine = {
  id: "qwen3",
  label: "Qwen3-TTS",
  params: "0.6B / 1.7B",
  runtime: "rust-bridge",
  targets: ["desktop"],
  picker: "desktop",
  badge: "Electron",
  setupPage: {
    tabLabel: "Qwen3-TTS",
    name: "Qwen3-TTS 12Hz Native",
    releaseDate: "January 29, 2026",
    params: "0.6B / 1.7B",
    highlights: [
      "Defaults to the fastest native 0.6B CustomVoice profile for this platform.",
      "Voice cloning available via the Base profile with a reference WAV and transcript.",
      "VoiceDesign 1.7B creates a voice from a natural-language description.",
      "Runs on the resident Rust bridge — these models ship as local runtime formats, not browser ONNX.",
    ],
    links: [
      { label: "MLX CustomVoice 0.6B", href: "https://huggingface.co/mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit" },
      { label: "MLX CustomVoice 1.7B", href: "https://huggingface.co/mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-6bit" },
      { label: "MLX Base 0.6B", href: "https://huggingface.co/mlx-community/Qwen3-TTS-12Hz-0.6B-Base-6bit" },
      { label: "MLX VoiceDesign 1.7B", href: "https://huggingface.co/mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-6bit" },
      { label: "HF 0.6B", href: "https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice" },
      { label: "HF 1.7B", href: "https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice" },
      { label: "HF VoiceDesign 1.7B", href: "https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign" },
      { label: "HF Tokenizer", href: "https://huggingface.co/Qwen/Qwen3-TTS-Tokenizer-12Hz" },
      { label: "GitHub", href: "https://github.com/QwenLM/Qwen3-TTS" },
    ],
  },
  capabilities,
  defaultSettings: {
    profileRepo: null,
    speaker: QWEN3_ENGINE_DEFAULT_SPEAKER,
    language: QWEN3_ENGINE_DEFAULT_LANGUAGE,
    instructByMode: { customVoice: "", voiceDesign: "" },
    temperature: QWEN3_TEMPERATURE_RANGE.default,
    topK: QWEN3_TOP_K_RANGE.default,
    maxNewTokens: QWEN3_MAX_NEW_TOKENS_RANGE.default,
    seed: null,
  },
  parseSettings: parseQwen3Settings,
  // The default speaker first, then the other English-native speakers.
  voices: () => [...QWEN3_ENGINE_SPEAKERS]
    .sort((left, right) => speakerRank(left) - speakerRank(right))
    .map(({ id, nativeLanguage }) => ({ id, label: id.replace(/_/g, " "), detail: nativeLanguage })),
  voiceLabel: (settings: Qwen3LiveSettings) => modeLabel(settings, settings.speaker.replace(/_/g, " ")),
  detail: (settings: Qwen3LiveSettings) => (
    `${settings.profile.parameters} ${modeLabel(settings, settings.speaker)} · ${settings.profile.provider === "mlx" ? "Apple MLX" : "LibTorch"}`
  ),
  signatureParts: ({ settings }) => {
    const modelPath = settings.modelPath.trim();
    const cloning = settings.profile.mode === "voiceClone";
    // Until the model directory and any clone reference are known, a signature
    // would describe audio no one can produce; reporting none keeps the Reader
    // from discarding cached sections while Qwen3 is still being set up.
    if (!modelPath || (cloning && !settings.referenceAudioSignature)) return null;
    return {
      voice: JSON.stringify({
        repo: settings.profile.repo,
        revision: settings.profile.revision,
        modelPath,
        mode: settings.profile.mode,
        speaker: settings.profile.mode === "customVoice" ? settings.speaker : null,
        language: settings.language,
        instruct: qwen3ProfileSupportsInstruct(settings.profile) ? settings.instruct : null,
        temperature: settings.temperature,
        topK: settings.topK,
        maxNewTokens: settings.maxNewTokens,
        seed: settings.seed,
        referenceAudio: cloning ? settings.referenceAudioSignature : null,
        referenceText: cloning ? settings.referenceText.trim() : null,
      }),
      // Creator tuning never reaches the bridge.
      tuning: {},
    };
  },
  // Every mode schedules the units re-split from each exact IPC request text.
  previewChunks: (text) => buildQwen3RequestPlan(text).units,
} as const satisfies EngineDescriptor<Qwen3Settings, Qwen3LiveSettings>;

function speakerRank(speaker: typeof QWEN3_ENGINE_SPEAKERS[number]): number {
  if (speaker.id === QWEN3_ENGINE_DEFAULT_SPEAKER) return 0;
  return speaker.nativeLanguage === "English" ? 1 : 2;
}
