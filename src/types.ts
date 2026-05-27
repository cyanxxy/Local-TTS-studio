/** Supported TTS model identifiers */
export type ModelType = "kokoro" | "supertonic";
export type InferenceBackend = "webgpu" | "wasm";
export type ChunkPauseKind = "none" | "comma" | "sentence" | "paragraph";
export type ExportAudioFormat = "wav-f32" | "wav-pcm24" | "wav-pcm16" | "mp3";
export type ExportSampleRate = "source" | 44100 | 48000;
export type CaptionExportFormat = "srt" | "vtt" | "json";
export type CreatorPresetId = "custom" | "tiktok-voiceover" | "youtube-shorts" | "youtube-long";
export type WorkerErrorScope = "load" | "generate";

export interface PronunciationRule {
  from: string;
  to: string;
}

export interface MasteringOptions {
  enabled: boolean;
  targetLufs: number;
  truePeakDb: number;
}

export interface AudioExportOptions {
  format: ExportAudioFormat;
  sampleRate: ExportSampleRate;
  bitrateKbps: number;
  mastering: MasteringOptions;
}

export interface GenerationTuningSettings {
  speed: number;
  quality: number;
  pauseOverridesSec?: Partial<Record<ChunkPauseKind, number>>;
  sentenceSpeedVariance?: number;
  pronunciationRules?: PronunciationRule[];
  emphasisStrength?: number;
}

/** Messages sent FROM main thread TO worker */
export type WorkerInMessage =
  | { type: "LOAD"; forceReload?: boolean; preferredVoice?: string; debugProfiling?: boolean }
  | {
      type: "GENERATE";
      generationId?: string;
      text: string;
      voice: string;
      speed: number;
      quality: number;
      finalPauseSec?: number;
      pauseOverridesSec?: Partial<Record<ChunkPauseKind, number>>;
      sentenceSpeedVariance?: number;
      pronunciationRules?: PronunciationRule[];
      emphasisStrength?: number;
    }
  | { type: "CANCEL" };

/** Messages sent FROM worker TO main thread */
export type WorkerOutMessage =
  | { type: "LOAD_PROGRESS"; percent: number }
  | { type: "READY"; voices?: string[]; backend?: InferenceBackend }
  | {
      type: "AUDIO_CHUNK";
      generationId?: string;
      audio: Float32Array;
      samplingRate: number;
      text: string;
      index: number;
      total: number;
      textStart?: number;
      textEnd?: number;
      pauseAfterSec?: number;
      pauseKind?: ChunkPauseKind;
    }
  | { type: "GENERATION_COMPLETE"; generationId?: string }
  | { type: "ERROR"; message: string; scope?: WorkerErrorScope; generationId?: string };

/** Per-model state tracked by the app */
export interface ModelState {
  ready: boolean;
  loading: boolean;
  downloadProgress: number;
  error: string | null;
  backend: InferenceBackend | null;
}

/** Audio chunk stored for playback and download */
export interface AudioChunk {
  audio: Float32Array;
  samplingRate: number;
  text: string;
  index: number;
  total: number;
  textStart?: number;
  textEnd?: number;
  pauseAfterSec?: number;
  pauseKind?: ChunkPauseKind;
}

/** Playback state for the audio player */
export interface PlaybackState {
  isPlaying: boolean;
  currentTime: number;
  totalDuration: number;
}

/** Stats displayed during/after generation */
export interface GenerationStats {
  firstLatency: number | null;
  processingTime: number;
  charsPerSec: number;
  rtf: number;
  totalDuration: number;
  currentDuration: number;
}
