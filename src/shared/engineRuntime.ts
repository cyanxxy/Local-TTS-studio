import type { ChunkPauseKind, GenerationStats, GenerationTuningSettings, ModelState } from "../types";
import type { Audio8Settings } from "../models/audio8";
import type { KokoroSettings } from "../models/kokoro";
import type { Qwen3LiveSettings } from "../models/qwen3";
import type { SurfaceEngineId } from "../models/registry";
import type { SupertonicSettings } from "../models/supertonic";
import type { Supertonic3Settings } from "../models/supertonic3";

/** The fields every surface reads off whichever runtime is currently driving it. */
export interface SurfaceRuntime {
  modelState: ModelState;
  canGenerate: boolean;
  isGenerating: boolean;
  generationProgress: number;
  stats: GenerationStats;
  error: string | null;
  handleGenerate: () => void;
  handleStop: () => void;
  retryLoad: () => void;
}

/** What the Qwen3 transport reads for one request, reference clip included. */
export interface Qwen3SynthesisSettings extends Qwen3LiveSettings {
  profile: Qwen3LiveSettings["profile"] & { label: string };
  /** The voice-clone reference clip; required by `voiceClone` profiles. */
  referenceAudioBase64: string | null;
}

/** The voice and engine settings one synthesize request is rendered with, per engine. */
export interface EngineSynthesisSettings {
  kokoro: KokoroSettings;
  supertonic: SupertonicSettings;
  audio8: Audio8Settings;
  supertonic3: Supertonic3Settings;
  qwen3: Qwen3SynthesisSettings;
}

/**
 * One self-contained request: everything that shapes the audio travels with it,
 * so rendering it never reads (or changes) what a surface has selected.
 */
export interface SynthesisRequest<Id extends SurfaceEngineId = SurfaceEngineId> {
  text: string;
  settings: EngineSynthesisSettings[Id];
  /** Creator tuning. Each engine applies the parts its capabilities list. */
  tuning: GenerationTuningSettings;
  /** Overrides the settings' seed on engines that accept one. */
  seed?: number;
  signal?: AbortSignal;
}

/** One passage of synthesized audio, in the shape the shared player schedules. */
export interface SynthesisChunk {
  audio: Float32Array;
  samplingRate: number;
  /** The passage this audio speaks. */
  text: string;
  /** 1-based position of the passage among `total`. */
  index: number;
  /** Passages in the request, or 0 while the engine does not know yet. */
  total: number;
  /** The passage's character range in the request text. */
  textStart?: number;
  textEnd?: number;
  /** Silence already appended to `audio` after the passage. */
  pauseAfterSec?: number;
  pauseKind?: ChunkPauseKind;
}

/**
 * Every engine a surface can select, behind one contract.
 *
 * The surface fields drive Studio and the Reader, which render into the shared
 * player. `synthesize` is independent of both: it renders any request to an
 * audio stream without touching the player or the surface's text and voice.
 *
 * An engine produces one generation at a time. Synthesize requests queue in
 * the order they are made and wait while the surface generation runs, and the
 * surface cannot generate while a request runs (`canGenerate` is false).
 * Aborting a request's signal removes it from the queue, or stops it when it
 * is running; either way its iteration rejects with the signal's reason. A
 * failure rejects only that request's iteration.
 */
export interface EngineRuntime<Id extends SurfaceEngineId = SurfaceEngineId> extends SurfaceRuntime {
  readonly id: Id;
  /** Stops a running surface generation. Unforced: idle engines are left alone. */
  cancelActiveGeneration: () => void;
  /** Clears the audio this engine's surface generation put in the shared player. */
  resetGeneratedAudio: () => void;
  synthesize: (request: SynthesisRequest<Id>) => AsyncIterable<SynthesisChunk>;
}

/** The runtime for each engine Studio and the Reader can select. */
export type EngineRuntimeMap = { readonly [Id in SurfaceEngineId]: EngineRuntime<Id> };
