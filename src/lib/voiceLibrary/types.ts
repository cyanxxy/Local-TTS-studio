import type { ReferenceCloneTarget } from "../referenceAudio";

/**
 * The Voice Library is one persisted catalog of user voices across engines:
 * saved presets (an engine voice plus its settings), cloned voices (a
 * reference WAV with its exact transcript) and designed voices (a Qwen3
 * VoiceDesign description with the seed and sample the user picked).
 */

export const VOICE_LIBRARY_SCHEMA_VERSION = 1;

export type VoiceKind = "preset" | "cloned" | "designed";
export type VoiceCloneTarget = ReferenceCloneTarget;
export type VoiceSource = "upload" | "recording" | "voiceDesign";
export type VoiceSettingValue = string | number | boolean;
export type VoiceRenderMode = "preset" | "voiceClone" | "voiceDesign";

/**
 * Engine-neutral settings. Each engine reads the fields it understands and
 * ignores the rest; `extra` carries engine-specific knobs such as Qwen3
 * temperature or top-k without widening this type for every engine.
 */
export interface VoicePresetSettings {
  speed?: number;
  seed?: number;
  /** Qwen3 CustomVoice instruction or VoiceDesign description. */
  instruction?: string;
  language?: string;
  quality?: number;
  extra?: Record<string, VoiceSettingValue>;
}

/**
 * Everything a synthesizer needs to pick a voice. Library voices that carry
 * audio (cloned voices) are referenced by `libraryVoiceId`, so presets stay
 * small, serializable and safe to persist inside scripts and history entries;
 * the adapter loads the reference WAV from the library when it renders.
 */
export interface VoicePreset {
  /** Engine registry id, for example "kokoro", "supertonic3" or "qwen3". */
  engineId: string;
  /** Engine voice id (Kokoro voice, Qwen3 speaker) or a library-derived id. */
  voiceId: string;
  mode?: VoiceRenderMode;
  settings: VoicePresetSettings;
  libraryVoiceId?: string;
  /** Display name, for pickers and captions. */
  label?: string;
}

/** Describes audio bytes stored alongside a voice. */
export interface StoredAudioInfo {
  sampleRate: number;
  durationSec: number;
  byteLength: number;
  /** Lower-case hex SHA-256 of the WAV bytes. */
  sha256: string;
}

interface VoiceRecordBase {
  schemaVersion: typeof VOICE_LIBRARY_SCHEMA_VERSION;
  id: string;
  name: string;
  description: string;
  tags: string[];
  favorite: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface PresetVoiceRecord extends VoiceRecordBase {
  kind: "preset";
  preset: Pick<VoicePreset, "engineId" | "voiceId" | "settings">;
}

export interface ClonedVoiceRecord extends VoiceRecordBase {
  kind: "cloned";
  /** Exactly what is said in the reference clip. */
  transcript: string;
  language: string;
  /** The clone runtimes this reference was checked for. */
  targets: VoiceCloneTarget[];
  source: VoiceSource;
  reference: StoredAudioInfo;
  /** The designed voice this clone was made from, if any. */
  designedFromId?: string;
}

export interface VoiceDesign {
  description: string;
  seed: number;
  language: string;
  /** The text the chosen sample says; it doubles as a clone transcript. */
  previewText: string;
  /** The Qwen3 VoiceDesign profile that rendered the sample. */
  profileRepo?: string;
}

export interface DesignedVoiceRecord extends VoiceRecordBase {
  kind: "designed";
  design: VoiceDesign;
  /** The rendered sample, which can later seed a Qwen3 Base clone. */
  sample?: StoredAudioInfo;
}

export type VoiceRecord = PresetVoiceRecord | ClonedVoiceRecord | DesignedVoiceRecord;

interface NewVoiceBase {
  /** Caller-chosen id, for linking voices saved together; generated when absent. */
  id?: string;
  name: string;
  description?: string;
  tags?: readonly string[];
  favorite?: boolean;
}

export interface NewPresetVoice extends NewVoiceBase {
  kind: "preset";
  preset: Pick<VoicePreset, "engineId" | "voiceId" | "settings">;
}

export interface NewClonedVoice extends NewVoiceBase {
  kind: "cloned";
  transcript: string;
  language?: string;
  targets: readonly VoiceCloneTarget[];
  source?: VoiceSource;
  referenceWav: Uint8Array;
  designedFromId?: string;
}

export interface NewDesignedVoice extends NewVoiceBase {
  kind: "designed";
  design: VoiceDesign;
  sampleWav?: Uint8Array;
}

export type NewVoice = NewPresetVoice | NewClonedVoice | NewDesignedVoice;

/**
 * Editable fields. Kind-specific fields are ignored on other kinds; audio is
 * immutable, so a new reference means a new voice.
 */
export interface VoicePatch {
  name?: string;
  description?: string;
  tags?: readonly string[];
  favorite?: boolean;
  preset?: Pick<VoicePreset, "engineId" | "voiceId" | "settings">;
  transcript?: string;
  language?: string;
  targets?: readonly VoiceCloneTarget[];
}

export type VoiceAudioRole = "reference" | "sample";
