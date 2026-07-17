import type { CreatorPresetId, ExportAudioFormat, ExportSampleRate } from "./types";

export const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const KOKORO_MODEL_REVISION = "1939ad2a8e416c0acfeecc08a694d14ef25f2231";
export const SUPERTONIC_MODEL_ID = "onnx-community/Supertonic-TTS-2-ONNX";
export const SUPERTONIC_MODEL_REVISION = "68d4d9420d0e0e51d14656e1ec5c9b091490b49e";

export const MODELS = {
  kokoro: {
    id: KOKORO_MODEL_ID,
    revision: KOKORO_MODEL_REVISION,
    label: "Kokoro",
    defaultVoice: "af_heart",
  },
  supertonic: {
    id: SUPERTONIC_MODEL_ID,
    revision: SUPERTONIC_MODEL_REVISION,
    label: "Supertonic",
    defaultVoice: "Female",
    voices: [
      "Female", "Female 2", "Female 3", "Female 4", "Female 5",
      "Male", "Male 2", "Male 3", "Male 4", "Male 5",
    ],
  },
} as const;

export const KOKORO_FALLBACK_VOICES = [
  "af_heart", "af_alloy", "af_aoede", "af_bella", "af_jessica",
  "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
  "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck", "am_santa",
  "bf_alice", "bf_emma", "bf_isabella", "bf_lily", "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
] as const;

// Keep synthesis speed in a voice-stable range.
export const SPEED_MIN = 0.85;
export const SPEED_MAX = 1.15;
export const SPEED_STEP = 0.01;
export const SPEED_DEFAULT = 1.0;

export const QUALITY_MIN = 1;
export const QUALITY_MAX = 20;
export const QUALITY_STEP = 1;
export const QUALITY_DEFAULT = 5;

export const MIN_TEXT_LENGTH = 10;
export const SUPERTONIC_MIN_CHUNK_LENGTH = 100;
export const MAX_CHUNK_LENGTH = 1000;

// Kokoro merges adjacent sentences into a single inference unit up to these
// per-backend character budgets. Shared by the worker and the reader preview so
// the section boundaries shown in the editor match what generation produces.
export const KOKORO_WEBGPU_MAX_INFERENCE_CHARS = 520;
export const KOKORO_WASM_MAX_INFERENCE_CHARS = 280;
export const SUPERTONIC_INTER_CHUNK_SILENCE_SEC = 0.5;
export const AUDIO_PLAYER_MAX_BUFFER_SECONDS = 15 * 60;


export const PAUSE_MIN = 0;
export const PAUSE_MAX = 1.2;
export const PAUSE_STEP = 0.02;
export const DEFAULT_PAUSE_OVERRIDES = {
  none: 0,
  comma: 0.14,
  sentence: 0.24,
  paragraph: 0.44,
} as const;

export const DEFAULT_TARGET_LUFS = -14;
export const DEFAULT_TRUE_PEAK_DB = -1;
export const DEFAULT_EXPORT_BITRATE_KBPS = 320;
export const DEFAULT_EXPORT_FORMAT: ExportAudioFormat = "wav-pcm24";
export const DEFAULT_EXPORT_SAMPLE_RATE: ExportSampleRate = 48000;
export const DEFAULT_CREATOR_PRESET: Exclude<CreatorPresetId, "custom"> = "youtube-shorts";

export interface CreatorPresetSettings {
  speed: number;
  pauseCommaSec: number;
  pauseSentenceSec: number;
  pauseParagraphSec: number;
  exportFormat: ExportAudioFormat;
  exportSampleRate: ExportSampleRate;
  exportBitrateKbps: number;
  masteringEnabled: boolean;
}

export interface CreatorPresetDefinition extends CreatorPresetSettings {
  id: CreatorPresetId;
  label: string;
  description: string;
}

export const CREATOR_PRESETS: Record<Exclude<CreatorPresetId, "custom">, CreatorPresetDefinition> = {
  "tiktok-voiceover": {
    id: "tiktok-voiceover",
    label: "TikTok Voiceover",
    description: "Punchy short-form narration with tighter pauses and mastered upload loudness.",
    speed: 1.04,
    pauseCommaSec: 0.1,
    pauseSentenceSec: 0.18,
    pauseParagraphSec: 0.28,
    exportFormat: "mp3",
    exportSampleRate: 48000,
    exportBitrateKbps: 192,
    masteringEnabled: true,
  },
  "youtube-shorts": {
    id: "youtube-shorts",
    label: "YouTube Shorts",
    description: "Crisp short-form voiceover tuned for quick pacing and editing.",
    speed: 1.02,
    pauseCommaSec: 0.11,
    pauseSentenceSec: 0.2,
    pauseParagraphSec: 0.32,
    exportFormat: "wav-pcm24",
    exportSampleRate: 48000,
    exportBitrateKbps: 320,
    masteringEnabled: true,
  },
  "youtube-long": {
    id: "youtube-long",
    label: "YouTube Long-form",
    description: "Steadier narration with slightly longer pauses for chapter-style content.",
    speed: 0.98,
    pauseCommaSec: 0.14,
    pauseSentenceSec: 0.24,
    pauseParagraphSec: 0.44,
    exportFormat: "wav-pcm24",
    exportSampleRate: 48000,
    exportBitrateKbps: 320,
    masteringEnabled: true,
  },
} as const;
