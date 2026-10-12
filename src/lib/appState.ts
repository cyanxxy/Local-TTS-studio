import {
  CREATOR_PRESETS,
  DEFAULT_CREATOR_PRESET,
  PAUSE_MAX,
  PAUSE_MIN,
  QUALITY_DEFAULT,
  QUALITY_MAX,
  QUALITY_MIN,
  SPEED_MAX,
  SPEED_MIN,
} from "../constants";
import { asRecord } from "../models/settings";
import {
  ENGINE_IDS,
  isBrowserEngineId,
  isDesktopInlineEngineId,
  parseEngineSettings,
  type DesktopInlineEngineId,
  type EngineId,
  type EngineSettings,
} from "../models/registry";
import type { EngineSurface } from "../models/types";
import type {
  CreatorPresetId,
  ExportAudioFormat,
  ExportSampleRate,
  ModelType,
  PronunciationRule,
} from "../types";

const LEGACY_MODEL_STORAGE_KEY = "tts-app-model";
/** The v1 app state, which also held the Kokoro, Supertonic 2 and Audio8 voices. Read only to migrate. */
const LEGACY_APP_STATE_STORAGE_KEY = "tts-app-state-v1";
const APP_STATE_STORAGE_KEY = "tts-app-state-v2";
const APP_STATE_VERSION = 2;
const ENGINE_SETTINGS_STORAGE_KEY = "tts-engine-settings-v1";
const CREATOR_STATE_STORAGE_KEY = "tts-app-creator-v1";

export const DEFAULT_TEXT =
  "This text-to-speech system runs entirely in your browser, providing fast and private operation without sending any data to external servers.";

/** The desktop engine each surface selected in place of the browser model, or null for the browser model. */
export type SurfaceDesktopModels = Record<EngineSurface, DesktopInlineEngineId | null>;

export interface PersistedAppState {
  model?: ModelType;
  text?: string;
  quality?: number;
  desktopModels?: Partial<SurfaceDesktopModels>;
}

export interface InitialAppState {
  model: ModelType;
  text: string;
  quality: number;
  desktopModels: SurfaceDesktopModels;
}

/** Every registered engine's persisted settings, keyed by engine. */
export type PersistedEngineSettings = { [Id in EngineId]: EngineSettings<Id> };

export interface PersistedCreatorState {
  preset?: CreatorPresetId;
  speed?: number;
  pauseCommaSec?: number;
  pauseSentenceSec?: number;
  pauseParagraphSec?: number;
  pronunciationLexicon?: string;
  exportFormat?: ExportAudioFormat;
  exportSampleRate?: ExportSampleRate;
  exportBitrateKbps?: number;
  masteringEnabled?: boolean;
}

export interface CreatorState {
  preset: CreatorPresetId;
  speed: number;
  pauseCommaSec: number;
  pauseSentenceSec: number;
  pauseParagraphSec: number;
  pronunciationLexicon: string;
  exportFormat: ExportAudioFormat;
  exportSampleRate: ExportSampleRate;
  exportBitrateKbps: number;
  masteringEnabled: boolean;
}

export interface PronunciationLexiconIssue {
  line: number;
  value: string;
}

export interface PronunciationLexiconDiagnostics {
  rules: PronunciationRule[];
  issues: PronunciationLexiconIssue[];
}

const EXPORT_BITRATE_OPTIONS = [128, 192, 256, 320] as const;

function clampQuality(quality: number): number {
  return Math.max(QUALITY_MIN, Math.min(QUALITY_MAX, Math.round(quality)));
}

function isCreatorPresetId(value: unknown): value is CreatorPresetId {
  return value === "custom"
    || value === "tiktok-voiceover"
    || value === "youtube-shorts"
    || value === "youtube-long";
}

function isExportAudioFormat(value: unknown): value is ExportAudioFormat {
  return value === "wav-f32"
    || value === "wav-pcm24"
    || value === "wav-pcm16"
    || value === "mp3";
}

function isExportSampleRate(value: unknown): value is ExportSampleRate {
  return value === "source" || value === 44100 || value === 48000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeExportBitrate(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;

  return EXPORT_BITRATE_OPTIONS.reduce((closest, option) => (
    Math.abs(option - value) < Math.abs(closest - value) ? option : closest
  ));
}

function getLegacyModelSelection(): ModelType | null {
  try {
    const stored = localStorage.getItem(LEGACY_MODEL_STORAGE_KEY);
    if (isBrowserEngineId(stored)) return stored;
  } catch { /* localStorage unavailable */ }
  return null;
}

/** The stored JSON object under `key`, or an empty object when it is missing, malformed or unreadable. */
function readStoredRecord(key: string): Record<string, unknown> {
  try {
    const stored = localStorage.getItem(key);
    return stored ? asRecord(JSON.parse(stored)) : {};
  } catch {
    return {};
  }
}

function parseDesktopModel(value: unknown): DesktopInlineEngineId | null {
  return isDesktopInlineEngineId(value) ? value : null;
}

export function getInitialAppState(): InitialAppState {
  const current = readStoredRecord(APP_STATE_STORAGE_KEY);
  // Before v2 is first written, the v1 shape supplies the fields both share.
  const stored = Object.keys(current).length > 0 ? current : readStoredRecord(LEGACY_APP_STATE_STORAGE_KEY);
  const desktopModels = asRecord(stored.desktopModels);

  return {
    model: isBrowserEngineId(stored.model) ? stored.model : (getLegacyModelSelection() ?? "kokoro"),
    text: typeof stored.text === "string" ? stored.text : DEFAULT_TEXT,
    quality: typeof stored.quality === "number" && Number.isFinite(stored.quality)
      ? clampQuality(stored.quality)
      : QUALITY_DEFAULT,
    desktopModels: {
      studio: parseDesktopModel(desktopModels.studio),
      reader: parseDesktopModel(desktopModels.reader),
    },
  };
}

/**
 * The settings v1 kept for an engine, in that engine's settings shape, or
 * undefined when v1 had none. v1 stored only the Kokoro, Supertonic 2 and
 * Audio8 voices.
 */
function legacyEngineSettings(id: EngineId, legacy: Record<string, unknown>): unknown {
  const voicesByModel = asRecord(legacy.voicesByModel);
  if (id === "kokoro" || id === "supertonic") {
    return id in voicesByModel ? { voice: voicesByModel[id] } : undefined;
  }
  if (id === "audio8") return "audio8Voice" in legacy ? { voice: legacy.audio8Voice } : undefined;
  return undefined;
}

/**
 * Every engine's settings, validated by its descriptor. An engine with no
 * stored entry yet falls back to what v1 kept for it, then to its defaults.
 */
export function getInitialEngineSettings(): PersistedEngineSettings {
  const stored = readStoredRecord(ENGINE_SETTINGS_STORAGE_KEY);
  const legacy = readStoredRecord(LEGACY_APP_STATE_STORAGE_KEY);
  const entries = ENGINE_IDS.map((id) => [
    id,
    parseEngineSettings(id, id in stored ? stored[id] : legacyEngineSettings(id, legacy)),
  ] as const);
  return Object.fromEntries(entries) as PersistedEngineSettings;
}

export function getCreatorPresetDefaults(preset: CreatorPresetId): CreatorState {
  let resolvedPreset: Exclude<CreatorPresetId, "custom">;
  if (preset === "custom") {
    resolvedPreset = DEFAULT_CREATOR_PRESET;
  } else {
    resolvedPreset = preset as Exclude<CreatorPresetId, "custom">;
  }
  const selected = CREATOR_PRESETS[resolvedPreset];
  return {
    preset,
    speed: selected.speed,
    pauseCommaSec: selected.pauseCommaSec,
    pauseSentenceSec: selected.pauseSentenceSec,
    pauseParagraphSec: selected.pauseParagraphSec,
    pronunciationLexicon: "",
    exportFormat: selected.exportFormat,
    exportSampleRate: selected.exportSampleRate,
    exportBitrateKbps: selected.exportBitrateKbps,
    masteringEnabled: selected.masteringEnabled,
  };
}

export function getInitialCreatorState(): CreatorState {
  const defaults = getCreatorPresetDefaults(DEFAULT_CREATOR_PRESET);

  try {
    const stored = localStorage.getItem(CREATOR_STATE_STORAGE_KEY);
    if (!stored) return defaults;

    const parsed = JSON.parse(stored) as PersistedCreatorState;
    const preset = isCreatorPresetId(parsed.preset) ? parsed.preset : defaults.preset;
    const presetDefaults = getCreatorPresetDefaults(preset);

    return {
      preset,
      speed: typeof parsed.speed === "number" && Number.isFinite(parsed.speed)
        ? clamp(parsed.speed, SPEED_MIN, SPEED_MAX)
        : presetDefaults.speed,
      pauseCommaSec: typeof parsed.pauseCommaSec === "number" && Number.isFinite(parsed.pauseCommaSec)
        ? clamp(parsed.pauseCommaSec, PAUSE_MIN, PAUSE_MAX)
        : presetDefaults.pauseCommaSec,
      pauseSentenceSec: typeof parsed.pauseSentenceSec === "number" && Number.isFinite(parsed.pauseSentenceSec)
        ? clamp(parsed.pauseSentenceSec, PAUSE_MIN, PAUSE_MAX)
        : presetDefaults.pauseSentenceSec,
      pauseParagraphSec: typeof parsed.pauseParagraphSec === "number" && Number.isFinite(parsed.pauseParagraphSec)
        ? clamp(parsed.pauseParagraphSec, PAUSE_MIN, PAUSE_MAX)
        : presetDefaults.pauseParagraphSec,
      pronunciationLexicon: typeof parsed.pronunciationLexicon === "string"
        ? parsed.pronunciationLexicon
        : presetDefaults.pronunciationLexicon,
      exportFormat: isExportAudioFormat(parsed.exportFormat)
        ? parsed.exportFormat
        : presetDefaults.exportFormat,
      exportSampleRate: isExportSampleRate(parsed.exportSampleRate)
        ? parsed.exportSampleRate
        : presetDefaults.exportSampleRate,
      exportBitrateKbps: normalizeExportBitrate(
        parsed.exportBitrateKbps,
        presetDefaults.exportBitrateKbps,
      ),
      masteringEnabled: typeof parsed.masteringEnabled === "boolean"
        ? parsed.masteringEnabled
        : presetDefaults.masteringEnabled,
    };
  } catch {
    return defaults;
  }
}

export function parsePronunciationRules(lexicon: string): PronunciationRule[] {
  return analyzePronunciationLexicon(lexicon).rules;
}

export function analyzePronunciationLexicon(lexicon: string): PronunciationLexiconDiagnostics {
  const rules: PronunciationRule[] = [];
  const issues: PronunciationLexiconIssue[] = [];

  lexicon.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) return;

    const match = line.match(/^(.+?)(?:=>|->|=)(.+)$/);
    const from = match?.[1]?.trim() ?? "";
    const to = match?.[2]?.trim() ?? "";
    if (!from || !to) {
      issues.push({ line: index + 1, value: line });
      return;
    }

    rules.push({ from, to });
  });

  return { rules, issues };
}

export function persistAppState(state: PersistedAppState): void {
  try {
    localStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify({ version: APP_STATE_VERSION, ...state }));
    localStorage.setItem(LEGACY_MODEL_STORAGE_KEY, state.model ?? "kokoro");
  } catch { /* localStorage unavailable */ }
}

/**
 * Stores the given engines' settings and keeps every other engine's entry.
 * Studio and the Qwen3 runtime each own different engines and write
 * independently, so neither may overwrite the other's.
 */
export function persistEngineSettings(settings: Partial<PersistedEngineSettings>): void {
  try {
    const stored = readStoredRecord(ENGINE_SETTINGS_STORAGE_KEY);
    localStorage.setItem(ENGINE_SETTINGS_STORAGE_KEY, JSON.stringify({ ...stored, ...settings }));
  } catch { /* localStorage unavailable */ }
}

export function persistCreatorState(state: PersistedCreatorState): void {
  try {
    localStorage.setItem(CREATOR_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch { /* localStorage unavailable */ }
}
