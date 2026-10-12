/**
 * Message contract for src/workers/chatterbox.worker.ts.
 *
 * It mirrors the shared WorkerInMessage/WorkerOutMessage shapes (LOAD,
 * GENERATE, CANCEL, LOAD_PROGRESS, AUDIO_CHUNK, GENERATION_COMPLETE, ERROR,
 * CANCELLED) and adds reference-voice messages. Voices are cloned from a clip
 * without a transcript, so GENERATE names a reference instead of a voice.
 */
import type {
  ChunkPauseKind,
  InferenceBackend,
  PronunciationRule,
  WorkerErrorScope,
  WorkerOutMessage,
} from "../types";
import type { ChatterboxSampling } from "./chatterboxRuntime";
import type { ChatterboxTagToken } from "./chatterboxTags";
import type { ChatterboxDtype } from "./chatterboxAssets";

/** Built-in reference voice, always available without SET_REFERENCE. */
export const CHATTERBOX_DEFAULT_REFERENCE_ID = "chatterbox-default";
export const CHATTERBOX_MAX_REFERENCE_ID_LENGTH = 200;

export type ChatterboxWorkerInMessage =
  | { type: "LOAD"; forceReload?: boolean }
  | {
      /** Clip is transferred; any sample rate from 8 to 192 kHz, 3-600 s long. */
      type: "SET_REFERENCE";
      referenceId: string;
      audio: Float32Array;
      samplingRate: number;
    }
  | { type: "DELETE_REFERENCE"; referenceId: string }
  | ({
      type: "GENERATE";
      generationId?: string;
      text: string;
      /** Defaults to CHATTERBOX_DEFAULT_REFERENCE_ID. */
      referenceId?: string;
      finalPauseSec?: number;
      pauseOverridesSec?: Partial<Record<ChunkPauseKind, number>>;
      pronunciationRules?: PronunciationRule[];
      emphasisStrength?: number;
    } & Partial<ChatterboxSampling>)
  | { type: "CANCEL" };

export type ChatterboxErrorScope = WorkerErrorScope | "reference";

export interface ChatterboxControls {
  temperature: true;
  topK: true;
  topP: true;
  repetitionPenalty: true;
  seed: true;
  /** Turbo's embed graph takes no exaggeration input, and upstream ignores CFG for Turbo. */
  exaggeration: false;
  cfg: false;
}

export const CHATTERBOX_CONTROLS: ChatterboxControls = {
  temperature: true,
  topK: true,
  topP: true,
  repetitionPenalty: true,
  seed: true,
  exaggeration: false,
  cfg: false,
};

export type ChatterboxWorkerOutMessage =
  | Exclude<WorkerOutMessage, { type: "READY" } | { type: "ERROR" }>
  | {
      type: "READY";
      backend: InferenceBackend;
      dtype: ChatterboxDtype;
      voices: string[];
      defaultReferenceId: string;
      tags: readonly ChatterboxTagToken[];
      controls: ChatterboxControls;
    }
  | { type: "REFERENCE_READY"; referenceId: string; digest: string; durationSec: number }
  | {
      /** Bracketed directions Chatterbox cannot perform; they were not spoken. */
      type: "UNSUPPORTED_TAGS";
      generationId?: string;
      tags: string[];
    }
  | {
      type: "ERROR";
      message: string;
      scope?: ChatterboxErrorScope;
      generationId?: string;
      referenceId?: string;
    };
