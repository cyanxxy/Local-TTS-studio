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
  language?: string;
  pauseOverridesSec?: Partial<Record<ChunkPauseKind, number>>;
  sentenceSpeedVariance?: number;
  pronunciationRules?: PronunciationRule[];
  emphasisStrength?: number;
}

/**
 * Messages sent FROM main thread TO the browser TTS workers (Kokoro,
 * Supertonic 2, Supertonic 3). The rules every worker follows
 * (src/workers/kit/runtime.ts):
 *
 * - LOADs run one at a time, in arrival order. A LOAD with `forceReload`
 *   supersedes every generation sent before it the moment it arrives; a
 *   GENERATE sent after it never runs on the outgoing model (it fails with a
 *   generate ERROR while the model is unloaded).
 * - One generation runs at a time. A GENERATE supersedes the previous
 *   generation at once (it posts nothing more) but starts inference only
 *   after the previous one's in-flight inference has returned, so ONNX
 *   sessions never run concurrently.
 * - Every AUDIO_CHUNK, GENERATION_COMPLETE, and generate ERROR echoes the
 *   GENERATE's `generationId`. A current generation ends with exactly one
 *   GENERATION_COMPLETE or generate ERROR; a superseded or aborted one ends
 *   silently.
 */
export type WorkerInMessage =
  | { type: "LOAD"; forceReload?: boolean; preferredVoice?: string; debugProfiling?: boolean }
  | {
      type: "GENERATE";
      generationId?: string;
      text: string;
      voice: string;
      language?: string;
      speed: number;
      quality: number;
      finalPauseSec?: number;
      pauseOverridesSec?: Partial<Record<ChunkPauseKind, number>>;
      sentenceSpeedVariance?: number;
      pronunciationRules?: PronunciationRule[];
      emphasisStrength?: number;
      /**
       * Optional noise seed for repeatable takes, an integer from 0 to
       * 4294967295. Honored by Supertonic 3, whose sampler starts from random
       * noise: each chunk's noise derives from this seed and the chunk's text,
       * so the same text, voice, settings, and seed reproduce the same audio
       * on the same backend. Omit it for a fresh variation. Supertonic 3
       * reports any other value as a generate ERROR; Kokoro and Supertonic 2
       * ignore the field.
       */
      seed?: number;
    }
  /**
   * Soft abort: stops a generation without closing the worker or unloading
   * the model, so the next GENERATE starts without a reload.
   *
   * It invalidates the generation with this `generationId` when that is the
   * current one (the latest GENERATE when the id is omitted), which then
   * posts nothing more: no AUDIO_CHUNK, GENERATION_COMPLETE, or ERROR. An
   * id that is not current (finished, superseded, or unknown) invalidates
   * nothing, so a stale ABORT can never stop a newer generation.
   *
   * Every ABORT is answered by exactly one ABORTED carrying the same
   * `generationId`: once the targeted generation's in-flight inference has
   * returned, or at once when no unfinished generation matches. A GENERATE
   * may be sent without waiting for ABORTED; it queues behind the aborted
   * inference either way. A GPU inference that never returns never yields
   * ABORTED, so hosts should fall back to CANCEL after a timeout.
   */
  | { type: "ABORT"; generationId?: string }
  /**
   * Hard cancel: invalidates every generation, posts CANCELLED, and closes
   * the worker. The host must create a new worker and LOAD the model again.
   */
  | { type: "CANCEL" };

/** Messages sent FROM worker TO main thread */
export type WorkerOutMessage =
  | { type: "LOAD_PROGRESS"; percent: number }
  | { type: "READY"; voices?: string[]; backend?: InferenceBackend }
  /** The worker closed after a hard CANCEL. */
  | { type: "CANCELLED" }
  /**
   * Answers an ABORT (same `generationId`): the aborted generation has
   * stopped and will post nothing more. The model stays loaded.
   */
  | { type: "ABORTED"; generationId?: string }
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
