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
  ExportSampleRate,
  ModelType,
  PronunciationRule,
} from "../types";
import { LOUDNESS_PRESETS, type ExportFormat } from "./exportAudio";
import {
  MAX_DICTIONARIES_PER_FILE,
  MAX_DICTIONARY_RULES,
  dictionaryFromLegacyRules,
  validatePronunciationDictionary,
  type PronunciationDictionary,
} from "./pronunciation/dictionary";

const LEGACY_MODEL_STORAGE_KEY = "tts-app-model";
/** The v1 app state, which also held the Kokoro, Supertonic 2 and Audio8 voices. Read only to migrate. */
const LEGACY_APP_STATE_STORAGE_KEY = "tts-app-state-v1";
const APP_STATE_STORAGE_KEY = "tts-app-state-v2";
const APP_STATE_VERSION = 2;
const ENGINE_SETTINGS_STORAGE_KEY = "tts-engine-settings-v1";
/** The v1 creator state, which kept the lexicon as text. Read only to migrate. */
const LEGACY_CREATOR_STATE_STORAGE_KEY = "tts-app-creator-v1";
const CREATOR_STATE_STORAGE_KEY = "tts-app-creator-v2";
const CREATOR_STATE_VERSION = 2;
/** The id of the dictionary the v1 lexicon becomes. */
export const QUICK_RULES_DICTIONARY_ID = "quick-rules";

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

/** How caption files cut the script into cues. */
export type CaptionStyle = "readable" | "short" | "passage";

/** How the export trims, pads and fades the generated audio. All off leaves it as generated. */
export interface ExportPostState {
  trimSilence: boolean;
  headSec: number;
  tailSec: number;
  fadeInMs: number;
  fadeOutMs: number;
}

export interface CreatorState {
  preset: CreatorPresetId;
  speed: number;
  pauseCommaSec: number;
  pauseSentenceSec: number;
  pauseParagraphSec: number;
  dictionaries: PronunciationDictionary[];
  /** Read numbers, dates and symbols as words before synthesis (English). */
  normalizeSpeech: boolean;
  /** Clean citations, URLs, emoji and Markdown out of the script before synthesis. */
  cleanupOnSpeak: boolean;
  exportFormat: ExportFormat;
  exportSampleRate: ExportSampleRate;
  exportBitrateKbps: number;
  masteringEnabled: boolean;
  /** One of `LOUDNESS_PRESETS`. */
  loudnessPresetId: string;
  exportPost: ExportPostState;
  captionStyle: CaptionStyle;
  /**
   * Set when this session moved a version 1 lexicon into a dictionary and had
   * to leave some rules behind. Not stored.
   */
  migrationNotice?: string;
}

/** What is stored: every field optional, so a missing or invalid one falls back to the preset. */
export type PersistedCreatorState = Partial<Omit<CreatorState, "exportPost">> & {
  exportPost?: Partial<ExportPostState>;
};

export interface PronunciationLexiconIssue {
  line: number;
  value: string;
}

export interface PronunciationLexiconDiagnostics {
  rules: PronunciationRule[];
  issues: PronunciationLexiconIssue[];
}

/** MP3 bitrates the encoder accepts (64 kbps floor); below 32 kHz it stops at 160. */
export const EXPORT_BITRATE_OPTIONS = [64, 96, 128, 160, 192, 256, 320] as const;
/** The longest written and spoken forms a dictionary rule accepts. */
const MAX_LEGACY_FROM_LENGTH = 200;
const MAX_LEGACY_TO_LENGTH = 500;
export const DEFAULT_LOUDNESS_PRESET_ID = "streaming";
export const MAX_EXPORT_PADDING_SEC = 10;
export const MAX_EXPORT_FADE_MS = 5000;

function clampQuality(quality: number): number {
  return Math.max(QUALITY_MIN, Math.min(QUALITY_MAX, Math.round(quality)));
}

function isCreatorPresetId(value: unknown): value is CreatorPresetId {
  return value === "custom"
    || value === "tiktok-voiceover"
    || value === "youtube-shorts"
    || value === "youtube-long";
}

function isExportFormat(value: unknown): value is ExportFormat {
  return value === "wav-f32"
    || value === "wav-pcm24"
    || value === "wav-pcm16"
    || value === "mp3"
    || value === "flac-16"
    || value === "flac-24";
}

function isCaptionStyle(value: unknown): value is CaptionStyle {
  return value === "readable" || value === "short" || value === "passage";
}

function isLoudnessPresetId(value: unknown): value is string {
  return LOUDNESS_PRESETS.some((preset) => preset.id === value);
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

export const DEFAULT_EXPORT_POST: Readonly<ExportPostState> = Object.freeze({
  trimSilence: false,
  headSec: 0,
  tailSec: 0,
  fadeInMs: 0,
  fadeOutMs: 0,
});

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
    dictionaries: [],
    normalizeSpeech: false,
    cleanupOnSpeak: false,
    exportFormat: selected.exportFormat,
    exportSampleRate: selected.exportSampleRate,
    exportBitrateKbps: selected.exportBitrateKbps,
    masteringEnabled: selected.masteringEnabled,
    loudnessPresetId: DEFAULT_LOUDNESS_PRESET_ID,
    exportPost: { ...DEFAULT_EXPORT_POST },
    captionStyle: "readable",
  };
}

function finiteNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

/** The dictionaries that validate; one bad entry never drops the others. */
function parseDictionaries(value: unknown, fallback: PronunciationDictionary[]): PronunciationDictionary[] {
  if (!Array.isArray(value)) return fallback;
  const dictionaries: PronunciationDictionary[] = [];
  for (const entry of value.slice(0, MAX_DICTIONARIES_PER_FILE)) {
    try {
      dictionaries.push(validatePronunciationDictionary(entry));
    } catch { /* an invalid stored dictionary is skipped */ }
  }
  return dictionaries;
}

function parseExportPost(value: unknown): ExportPostState {
  const stored = asRecord(value);
  return {
    trimSilence: typeof stored.trimSilence === "boolean" ? stored.trimSilence : DEFAULT_EXPORT_POST.trimSilence,
    headSec: finiteNumber(stored.headSec, 0, MAX_EXPORT_PADDING_SEC, DEFAULT_EXPORT_POST.headSec),
    tailSec: finiteNumber(stored.tailSec, 0, MAX_EXPORT_PADDING_SEC, DEFAULT_EXPORT_POST.tailSec),
    fadeInMs: finiteNumber(stored.fadeInMs, 0, MAX_EXPORT_FADE_MS, DEFAULT_EXPORT_POST.fadeInMs),
    fadeOutMs: finiteNumber(stored.fadeOutMs, 0, MAX_EXPORT_FADE_MS, DEFAULT_EXPORT_POST.fadeOutMs),
  };
}

/**
 * Reads a stored creator record. `legacy` marks the v1 shape, whose lexicon
 * was text: it becomes one dictionary of alias rules.
 */
function parseCreatorState(stored: Record<string, unknown>, legacy: boolean): CreatorState {
  const preset = isCreatorPresetId(stored.preset) ? stored.preset : getCreatorPresetDefaults(DEFAULT_CREATOR_PRESET).preset;
  const defaults = getCreatorPresetDefaults(preset);
  let dictionaries = defaults.dictionaries;
  let migrationNotice: string | undefined;
  if (legacy) {
    const rules = typeof stored.pronunciationLexicon === "string"
      ? parsePronunciationRules(stored.pronunciationLexicon)
      : [];
    const migrated = migrateLegacyRules(rules);
    if (migrated.dictionary) dictionaries = [migrated.dictionary];
    if (migrated.skipped > 0) {
      migrationNotice = `${migrated.skipped} of your ${rules.length} saved pronunciation ${rules.length === 1 ? "rule was" : "rules were"} too long or too many for a dictionary and ${migrated.skipped === 1 ? "was" : "were"} left out. They are still stored unchanged.`;
    }
  } else {
    dictionaries = parseDictionaries(stored.dictionaries, dictionaries);
  }

  return {
    preset,
    speed: finiteNumber(stored.speed, SPEED_MIN, SPEED_MAX, defaults.speed),
    pauseCommaSec: finiteNumber(stored.pauseCommaSec, PAUSE_MIN, PAUSE_MAX, defaults.pauseCommaSec),
    pauseSentenceSec: finiteNumber(stored.pauseSentenceSec, PAUSE_MIN, PAUSE_MAX, defaults.pauseSentenceSec),
    pauseParagraphSec: finiteNumber(stored.pauseParagraphSec, PAUSE_MIN, PAUSE_MAX, defaults.pauseParagraphSec),
    dictionaries,
    normalizeSpeech: typeof stored.normalizeSpeech === "boolean" ? stored.normalizeSpeech : defaults.normalizeSpeech,
    cleanupOnSpeak: typeof stored.cleanupOnSpeak === "boolean" ? stored.cleanupOnSpeak : defaults.cleanupOnSpeak,
    exportFormat: isExportFormat(stored.exportFormat) ? stored.exportFormat : defaults.exportFormat,
    exportSampleRate: isExportSampleRate(stored.exportSampleRate) ? stored.exportSampleRate : defaults.exportSampleRate,
    exportBitrateKbps: normalizeExportBitrate(stored.exportBitrateKbps, defaults.exportBitrateKbps),
    masteringEnabled: typeof stored.masteringEnabled === "boolean" ? stored.masteringEnabled : defaults.masteringEnabled,
    loudnessPresetId: isLoudnessPresetId(stored.loudnessPresetId) ? stored.loudnessPresetId : defaults.loudnessPresetId,
    exportPost: parseExportPost(stored.exportPost),
    captionStyle: isCaptionStyle(stored.captionStyle) ? stored.captionStyle : defaults.captionStyle,
    ...(migrationNotice === undefined ? {} : { migrationNotice }),
  };
}

/**
 * Moves version 1 rules into a dictionary without ever throwing: rules longer
 * than a dictionary allows, rules past its size limit and rules it rejects
 * stay behind (version 1 storage is never modified).
 */
function migrateLegacyRules(rules: readonly PronunciationRule[]): { dictionary: PronunciationDictionary | null; skipped: number } {
  const fitting = rules
    .filter((rule) => rule.from.length <= MAX_LEGACY_FROM_LENGTH && rule.to.length <= MAX_LEGACY_TO_LENGTH)
    .slice(0, MAX_DICTIONARY_RULES);
  const build = (candidates: readonly PronunciationRule[]) => (
    candidates.length === 0 ? null : dictionaryFromLegacyRules(candidates, { id: QUICK_RULES_DICTIONARY_ID })
  );
  try {
    const dictionary = build(fitting);
    return { dictionary, skipped: rules.length - fitting.length };
  } catch {
    // Something in the lexicon is not valid in a dictionary; keep the rules that are.
    const accepted = fitting.filter((rule) => {
      try {
        dictionaryFromLegacyRules([rule]);
        return true;
      } catch {
        return false;
      }
    });
    try {
      return { dictionary: build(accepted), skipped: rules.length - accepted.length };
    } catch {
      return { dictionary: null, skipped: rules.length };
    }
  }
}

/**
 * The saved creator state. Before v2 is first written, the v1 record supplies
 * what it had and its text lexicon becomes a dictionary; v1 is left in place so
 * a downgrade still finds it.
 */
export function getInitialCreatorState(): CreatorState {
  const current = readStoredRecord(CREATOR_STATE_STORAGE_KEY);
  if (Object.keys(current).length > 0) return parseCreatorState(current, false);
  const legacy = readStoredRecord(LEGACY_CREATOR_STATE_STORAGE_KEY);
  return parseCreatorState(legacy, true);
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
    localStorage.setItem(CREATOR_STATE_STORAGE_KEY, JSON.stringify({ version: CREATOR_STATE_VERSION, ...state }));
  } catch { /* localStorage unavailable */ }
}
