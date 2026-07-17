import {
  CREATOR_PRESETS,
  DEFAULT_CREATOR_PRESET,
  MODELS,
  PAUSE_MAX,
  PAUSE_MIN,
  QUALITY_DEFAULT,
  QUALITY_MAX,
  QUALITY_MIN,
  SPEED_MAX,
  SPEED_MIN,
} from "../constants";
import type {
  CreatorPresetId,
  ExportAudioFormat,
  ExportSampleRate,
  ModelType,
  PronunciationRule,
} from "../types";

const LEGACY_MODEL_STORAGE_KEY = "tts-app-model";
const APP_STATE_STORAGE_KEY = "tts-app-state-v1";
const CREATOR_STATE_STORAGE_KEY = "tts-app-creator-v1";

export const DEFAULT_TEXT =
  "This text-to-speech system runs entirely in your browser, providing fast and private operation without sending any data to external servers.";

export interface PersistedAppState {
  model?: ModelType;
  text?: string;
  voicesByModel?: Partial<Record<ModelType, string>>;
  quality?: number;
}

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

export interface InitialAppState {
  model: ModelType;
  text: string;
  voicesByModel: Record<ModelType, string>;
  quality: number;
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

function isModelType(value: unknown): value is ModelType {
  return value === "kokoro" || value === "supertonic";
}

function isSupertonicVoice(value: unknown): value is (typeof MODELS.supertonic.voices)[number] {
  return typeof value === "string" && MODELS.supertonic.voices.some((voice) => voice === value);
}

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
    if (isModelType(stored)) return stored;
  } catch { /* localStorage unavailable */ }
  return null;
}

export function getInitialAppState(): InitialAppState {
  const defaults: InitialAppState = {
    model: "kokoro",
    text: DEFAULT_TEXT,
    voicesByModel: {
      kokoro: MODELS.kokoro.defaultVoice,
      supertonic: MODELS.supertonic.defaultVoice,
    },
    quality: QUALITY_DEFAULT,
  };

  const legacyModel = getLegacyModelSelection();

  try {
    const stored = localStorage.getItem(APP_STATE_STORAGE_KEY);
    if (!stored) {
      return legacyModel ? { ...defaults, model: legacyModel } : defaults;
    }

    const parsed = JSON.parse(stored) as PersistedAppState;
    const persistedKokoroVoice = parsed.voicesByModel?.kokoro;
    const persistedSupertonicVoice = parsed.voicesByModel?.supertonic;
    const hasValidSupertonicVoice = isSupertonicVoice(persistedSupertonicVoice);

    return {
      model: isModelType(parsed.model) ? parsed.model : (legacyModel ?? defaults.model),
      text: typeof parsed.text === "string" ? parsed.text : defaults.text,
      voicesByModel: {
        kokoro: typeof persistedKokoroVoice === "string" && persistedKokoroVoice.trim().length > 0
          ? persistedKokoroVoice
          : defaults.voicesByModel.kokoro,
        supertonic: hasValidSupertonicVoice
          ? persistedSupertonicVoice
          : defaults.voicesByModel.supertonic,
      },
      quality: typeof parsed.quality === "number" && Number.isFinite(parsed.quality)
        ? clampQuality(parsed.quality)
        : defaults.quality,
    };
  } catch {
    return legacyModel ? { ...defaults, model: legacyModel } : defaults;
  }
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
    localStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify(state));
    localStorage.setItem(LEGACY_MODEL_STORAGE_KEY, state.model ?? "kokoro");
  } catch { /* localStorage unavailable */ }
}

export function persistCreatorState(state: PersistedCreatorState): void {
  try {
    localStorage.setItem(CREATOR_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch { /* localStorage unavailable */ }
}
