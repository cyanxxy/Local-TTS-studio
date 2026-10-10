import type { GenerationTuningSettings, InferenceBackend } from "../types";
import type { TextChunk } from "../lib/chunking";
import type { AudioSignatureTuning } from "../lib/readerDocument";

/**
 * Engine descriptors are metadata plus pure functions. They must stay safe for
 * the web bundle: no imports from `electron/`, no worker modules, and no React.
 * Runtimes (workers, IPC, the Rust bridge) are wired up by hooks and the app
 * entries; a descriptor only says what an engine is and what it honours.
 */

/** The two synthesis surfaces that host an inline engine. */
export type EngineSurface = "studio" | "reader";

/**
 * How an engine's audio reaches the renderer.
 * - `browser-worker`: a module worker every build ships (Kokoro, Supertonic 2).
 * - `renderer-worker`: a renderer worker only the desktop entry injects.
 * - `native-worker`: an Electron utility process reached over IPC.
 * - `rust-bridge`: the loopback Rust WebSocket bridge.
 */
export type EngineRuntimeKind = "browser-worker" | "renderer-worker" | "native-worker" | "rust-bridge";

export type EngineTarget = "web" | "desktop";

/**
 * Which model list a surface offers the engine in: the shared browser list
 * (one browser model is resident for both surfaces) or the per-surface desktop
 * list. Engines with neither are only reachable from their setup page.
 */
export type EnginePicker = "browser" | "desktop";

/**
 * The unit audio is delivered in: one chunker passage per message, model text
 * units that may stream as several transport chunks, or one whole request.
 */
export type EngineStreamingGranularity = "chunk" | "unit" | "request";

export interface EngineQualityRange {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly default: number;
}

export interface EngineVoiceCloning {
  /** What a reference consists of besides its exact transcript. */
  readonly reference: "wav" | "wav-or-codes";
  /** The longest reference clip the engine accepts. */
  readonly maxSeconds: number;
}

export interface EngineCapabilities {
  /** Honours the Creator base speed and per-sentence speed variance. */
  readonly speed: boolean;
  /** Honours the Creator comma, sentence and paragraph pause lengths. */
  readonly pauses: boolean;
  /** Applies the Creator pronunciation lexicon and emphasis before synthesis. */
  readonly pronunciationLexicon: boolean;
  /** The step range the quality slider offers, or null when quality is fixed. */
  readonly quality: EngineQualityRange | null;
  /** Languages the engine is conditioned on, or null when the voice or model fixes it. */
  readonly languages: readonly string[] | null;
  readonly voiceCloning: EngineVoiceCloning | null;
  /** Builds a voice from a natural-language description. */
  readonly voiceDesign: boolean;
  /** Accepts a style instruction for a preset voice. */
  readonly instruct: boolean;
  /** Accepts a fixed sampling seed for repeatable output. */
  readonly seed: boolean;
  /** Inline expression tags such as `<laugh>`; empty when none are understood. */
  readonly expressionTags: readonly string[];
  /** Whether one generated segment can be regenerated in place. */
  readonly retake: boolean;
  readonly streamingGranularity: EngineStreamingGranularity;
}

export interface EngineVoice {
  readonly id: string;
  readonly label: string;
  /** Picker section, e.g. "American · Female". Ungrouped voices render as a flat grid. */
  readonly group?: string;
  /** Secondary line, e.g. "English · Female". */
  readonly detail?: string;
}

export interface EngineVoiceContext {
  /** Voice ids the loaded runtime reported; empty until it has loaded. */
  readonly runtimeVoices?: readonly string[];
}

export interface EngineSignatureContext<Live> {
  readonly settings: Live;
  readonly tuning: GenerationTuningSettings;
  readonly quality: number;
}

/**
 * The engine-specific inputs that shape generated audio. A Reader cache entry
 * is valid exactly while these (and the section text) are unchanged, so they
 * must name every input the engine reads and nothing it ignores.
 */
export interface EngineSignatureParts {
  readonly voice: string;
  readonly tuning: AudioSignatureTuning;
}

export interface EnginePreviewContext<Live> {
  readonly settings: Live;
  /** The backend the runtime resolved when it loaded, or null before then. */
  readonly backend: InferenceBackend | null;
  readonly quality: number;
}

export interface EngineLink {
  readonly label: string;
  readonly href: string;
}

/** A desktop page dedicated to setting up and exercising one engine. */
export interface EngineSetupPage {
  readonly tabLabel: string;
  readonly name: string;
  readonly releaseDate: string;
  readonly params: string;
  readonly highlights: readonly string[];
  readonly links: readonly EngineLink[];
}

/**
 * One engine. `Settings` is the serialisable per-engine state the app persists;
 * `Live` is what the engine's helpers read at runtime, which for most engines
 * is the same object. Members are declared as methods so a concrete descriptor
 * stays assignable to `AnyEngineDescriptor`.
 */
export interface EngineDescriptor<Settings = unknown, Live = Settings> {
  /** Stable id: the persisted key and the `model` part of Reader cache signatures. */
  readonly id: string;
  readonly label: string;
  /** Parameter count shown in pickers, e.g. "82M". */
  readonly params: string;
  readonly runtime: EngineRuntimeKind;
  readonly targets: readonly EngineTarget[];
  readonly picker: EnginePicker | null;
  /** Short tag rendered beside desktop picker rows, e.g. "Local". */
  readonly badge?: string;
  readonly setupPage?: EngineSetupPage;
  readonly capabilities: EngineCapabilities;
  readonly defaultSettings: Settings;
  /** Validates untrusted (stored) input, falling back field by field to defaults. */
  parseSettings(raw: unknown): Settings;
  voices(context?: EngineVoiceContext): readonly EngineVoice[];
  voiceLabel(settings: Live): string;
  /** One-line summary of the current settings for picker rows. */
  detail(settings: Live): string;
  /** Null while an input that shapes the audio is not known yet. */
  signatureParts(context: EngineSignatureContext<Live>): EngineSignatureParts | null;
  /** The passages generation will produce, with the parameters the runtime uses. */
  previewChunks(text: string, context: EnginePreviewContext<Live>): TextChunk[];
}

export type AnyEngineDescriptor = EngineDescriptor<unknown, unknown>;
