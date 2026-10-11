import { QWEN3_MAX_SEED } from "../../../electron/localTtsLimits";
import { MAX_REFERENCE_WAV_BYTES, REFERENCE_DURATION_LIMITS } from "../referenceAudio";
import {
  VOICE_LIBRARY_SCHEMA_VERSION,
  type StoredAudioInfo,
  type VoiceCloneTarget,
  type VoiceDesign,
  type VoicePreset,
  type VoicePresetSettings,
  type VoiceRecord,
  type VoiceSettingValue,
  type VoiceSource,
} from "./types";

/**
 * Limits mirror the bridge where one exists: transcripts match the IPC's
 * 2,000-character `referenceText` cap, instructions its 1,000-character
 * `instruct` cap, seeds its u32 range, and reference WAVs its 45,000,000-byte
 * file cap and Qwen3's 20-second reference limit.
 */
export const VOICE_LIBRARY_LIMITS = {
  maxNameLength: 80,
  maxDescriptionLength: 500,
  maxTags: 16,
  maxTagLength: 32,
  maxTranscriptLength: 2_000,
  maxInstructionLength: 1_000,
  maxLanguageLength: 32,
  maxEngineIdLength: 40,
  maxVoiceIdLength: 200,
  maxExtraSettings: 32,
  maxExtraKeyLength: 64,
  maxExtraStringLength: 1_000,
  maxSeed: QWEN3_MAX_SEED,
  maxAudioBytes: MAX_REFERENCE_WAV_BYTES,
  maxReferenceDurationSec: REFERENCE_DURATION_LIMITS["qwen3-base"].maxSec,
  maxVoices: 500,
  /** Total reference and sample audio kept by the library. */
  maxTotalAudioBytes: 1024 * 1024 * 1024,
} as const;

/** WAV header rounding can push a 20.000 s clip a few samples over. */
const DURATION_TOLERANCE_SEC = 0.005;
const ENGINE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CLONE_TARGETS: readonly VoiceCloneTarget[] = ["qwen3-base", "neutts"];
const VOICE_SOURCES: readonly VoiceSource[] = ["upload", "recording", "voiceDesign"];
const RENDER_MODES: readonly unknown[] = ["preset", "voiceClone", "voiceDesign"];

/** Thrown for input the library refuses; the message is user-presentable. */
export class VoiceLibraryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceLibraryValidationError";
  }
}

function fail(message: string): never {
  throw new VoiceLibraryValidationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function boundedText(value: unknown, label: string, maxLength: number, options: { required?: boolean; collapse?: boolean } = {}): string {
  if (value === undefined && !options.required) return "";
  if (typeof value !== "string") fail(`${label} must be text.`);
  const text = options.collapse === false ? value.trim() : collapseWhitespace(value);
  if (options.required && text.length === 0) fail(`${label} is required.`);
  if (text.length > maxLength) fail(`${label} must be at most ${maxLength} characters.`);
  return text;
}

export function normalizeVoiceName(value: unknown): string {
  return boundedText(value, "Voice name", VOICE_LIBRARY_LIMITS.maxNameLength, { required: true });
}

export function normalizeVoiceDescription(value: unknown): string {
  return boundedText(value, "Description", VOICE_LIBRARY_LIMITS.maxDescriptionLength);
}

/** Trim, drop empties and case-insensitive duplicates, keep the first spelling. */
export function normalizeVoiceTags(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("Tags must be a list.");
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of value) {
    const tag = boundedText(raw, "A tag", VOICE_LIBRARY_LIMITS.maxTagLength);
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  if (tags.length > VOICE_LIBRARY_LIMITS.maxTags) fail(`A voice can have at most ${VOICE_LIBRARY_LIMITS.maxTags} tags.`);
  return tags;
}

const VOICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

/** A caller-chosen voice id: 1-100 letters, digits, ".", "_", ":" or "-". */
export function normalizeVoiceId(value: unknown): string {
  if (typeof value !== "string" || !VOICE_ID_PATTERN.test(value)) {
    fail("Voice ids must be 1-100 letters, digits, dots, underscores, colons or dashes.");
  }
  return value;
}

export function normalizeTranscript(value: unknown): string {
  // Whitespace inside a transcript is preserved: it is sent verbatim.
  return boundedText(value, "Transcript", VOICE_LIBRARY_LIMITS.maxTranscriptLength, { required: true, collapse: false });
}

export function normalizeLanguage(value: unknown, fallback = "Auto"): string {
  if (value === undefined) return fallback;
  return boundedText(value, "Language", VOICE_LIBRARY_LIMITS.maxLanguageLength, { required: true });
}

export function normalizeSeed(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > VOICE_LIBRARY_LIMITS.maxSeed) {
    fail(`Seed must be a whole number from 0 to ${VOICE_LIBRARY_LIMITS.maxSeed}.`);
  }
  return value as number;
}

function normalizeExtraSettings(value: unknown): Record<string, VoiceSettingValue> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) fail("Extra settings must be an object.");
  const entries = Object.entries(value);
  if (entries.length > VOICE_LIBRARY_LIMITS.maxExtraSettings) fail("Too many extra settings.");
  const extra: Record<string, VoiceSettingValue> = {};
  for (const [key, raw] of entries) {
    if (key.length === 0 || key.length > VOICE_LIBRARY_LIMITS.maxExtraKeyLength || key === "__proto__") {
      fail("Extra setting names must be 1-64 characters.");
    }
    if (typeof raw === "string") {
      if (raw.length > VOICE_LIBRARY_LIMITS.maxExtraStringLength) fail(`Setting ${key} is too long.`);
    } else if (typeof raw !== "boolean" && !isFiniteNumber(raw)) {
      fail(`Setting ${key} must be text, a number or a boolean.`);
    }
    extra[key] = raw as VoiceSettingValue;
  }
  return extra;
}

export function normalizePresetSettings(value: unknown): VoicePresetSettings {
  if (value === undefined) return {};
  if (!isRecord(value)) fail("Voice settings must be an object.");
  const settings: VoicePresetSettings = {};
  if (value.speed !== undefined) {
    if (!isFiniteNumber(value.speed) || value.speed <= 0 || value.speed > 4) fail("Speed must be between 0 and 4.");
    settings.speed = value.speed;
  }
  if (value.seed !== undefined) settings.seed = normalizeSeed(value.seed);
  if (value.instruction !== undefined) {
    const instruction = boundedText(value.instruction, "Instruction", VOICE_LIBRARY_LIMITS.maxInstructionLength, { collapse: false });
    if (instruction) settings.instruction = instruction;
  }
  if (value.language !== undefined) settings.language = normalizeLanguage(value.language);
  if (value.quality !== undefined) {
    if (!isFiniteNumber(value.quality)) fail("Quality must be a number.");
    settings.quality = value.quality;
  }
  const extra = normalizeExtraSettings(value.extra);
  if (extra && Object.keys(extra).length > 0) settings.extra = extra;
  return settings;
}

export function normalizeEngineId(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > VOICE_LIBRARY_LIMITS.maxEngineIdLength
    || !ENGINE_ID_PATTERN.test(value)
  ) fail("Engine id is invalid.");
  return value;
}

export function normalizePreset(value: unknown): Pick<VoicePreset, "engineId" | "voiceId" | "settings"> {
  if (!isRecord(value)) fail("Preset must be an object.");
  const voiceId = boundedText(value.voiceId, "Voice id", VOICE_LIBRARY_LIMITS.maxVoiceIdLength, { required: true, collapse: false });
  return {
    engineId: normalizeEngineId(value.engineId),
    voiceId,
    settings: normalizePresetSettings(value.settings),
  };
}

/** Validate a full VoicePreset, including the optional library linkage. */
export function normalizeVoicePreset(value: unknown): VoicePreset {
  const base = normalizePreset(value);
  const raw = value as Record<string, unknown>;
  const preset: VoicePreset = { ...base };
  if (raw.mode !== undefined) {
    if (!RENDER_MODES.includes(raw.mode)) fail("Voice mode is invalid.");
    preset.mode = raw.mode as VoicePreset["mode"];
  }
  if (raw.libraryVoiceId !== undefined) {
    preset.libraryVoiceId = boundedText(raw.libraryVoiceId, "Library voice id", VOICE_LIBRARY_LIMITS.maxVoiceIdLength, { required: true, collapse: false });
  }
  if (raw.label !== undefined) preset.label = normalizeVoiceName(raw.label);
  return preset;
}

export function normalizeCloneTargets(value: unknown): VoiceCloneTarget[] {
  if (!Array.isArray(value)) fail("Choose at least one clone target.");
  const targets = CLONE_TARGETS.filter((target) => value.includes(target));
  if (targets.length === 0 || targets.length !== new Set(value).size) {
    fail("Clone targets must be Qwen3 Base and/or NeuTTS.");
  }
  return targets;
}

export function normalizeVoiceSource(value: unknown): VoiceSource {
  if (value === undefined) return "upload";
  if (!VOICE_SOURCES.includes(value as VoiceSource)) fail("Voice source is invalid.");
  return value as VoiceSource;
}

export function normalizeVoiceDesign(value: unknown): VoiceDesign {
  if (!isRecord(value)) fail("Voice design must be an object.");
  const design: VoiceDesign = {
    description: boundedText(value.description, "Voice description", VOICE_LIBRARY_LIMITS.maxInstructionLength, { required: true, collapse: false }),
    seed: normalizeSeed(value.seed),
    language: normalizeLanguage(value.language),
    previewText: normalizeTranscript(value.previewText),
  };
  if (value.profileRepo !== undefined) {
    design.profileRepo = boundedText(value.profileRepo, "Profile", 200, { required: true, collapse: false });
  }
  return design;
}

/** Validate stored audio metadata against the library's audio limits. */
export function normalizeStoredAudioInfo(value: unknown, options: { maxDurationSec?: number } = {}): StoredAudioInfo {
  if (!isRecord(value)) fail("Audio metadata is missing.");
  const { sampleRate, durationSec, byteLength, sha256 } = value;
  if (!Number.isInteger(sampleRate) || (sampleRate as number) <= 0) fail("Audio sample rate is invalid.");
  if (!isFiniteNumber(durationSec) || durationSec <= 0) fail("Audio duration is invalid.");
  if (!Number.isInteger(byteLength) || (byteLength as number) <= 0) fail("Audio size is invalid.");
  if ((byteLength as number) > VOICE_LIBRARY_LIMITS.maxAudioBytes) {
    fail(`Voice audio is limited to ${VOICE_LIBRARY_LIMITS.maxAudioBytes.toLocaleString("en-US")} bytes.`);
  }
  if (options.maxDurationSec !== undefined && durationSec > options.maxDurationSec + DURATION_TOLERANCE_SEC) {
    fail(`Reference clips must be ${options.maxDurationSec} seconds or shorter; trim the clip first.`);
  }
  if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) fail("Audio digest is invalid.");
  return { sampleRate: sampleRate as number, durationSec, byteLength: byteLength as number, sha256 };
}

function isTimestamp(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

/**
 * Validate a record read back from storage or an import. Returns null for
 * anything damaged, so one bad value never hides the rest of the library.
 * Records written by a newer schema are also skipped (callers must leave them
 * untouched so a later upgrade can still read them).
 */
export function parseStoredVoiceRecord(value: unknown): VoiceRecord | null {
  if (!isRecord(value) || value.schemaVersion !== VOICE_LIBRARY_SCHEMA_VERSION) return null;
  if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > VOICE_LIBRARY_LIMITS.maxVoiceIdLength) return null;
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) return null;
  try {
    const base = {
      schemaVersion: VOICE_LIBRARY_SCHEMA_VERSION,
      id: value.id,
      name: normalizeVoiceName(value.name),
      description: normalizeVoiceDescription(value.description),
      tags: normalizeVoiceTags(value.tags),
      favorite: value.favorite === true,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    } as const;
    switch (value.kind) {
      case "preset":
        return { ...base, kind: "preset", preset: normalizePreset(value.preset) };
      case "cloned": {
        const record: VoiceRecord = {
          ...base,
          kind: "cloned",
          transcript: normalizeTranscript(value.transcript),
          language: normalizeLanguage(value.language),
          targets: normalizeCloneTargets(value.targets),
          source: normalizeVoiceSource(value.source),
          reference: normalizeStoredAudioInfo(value.reference, { maxDurationSec: VOICE_LIBRARY_LIMITS.maxReferenceDurationSec }),
        };
        if (typeof value.designedFromId === "string" && value.designedFromId) record.designedFromId = value.designedFromId;
        return record;
      }
      case "designed": {
        const record: VoiceRecord = { ...base, kind: "designed", design: normalizeVoiceDesign(value.design) };
        if (value.sample !== undefined) record.sample = normalizeStoredAudioInfo(value.sample);
        return record;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** True for a stored value written by a newer build of the library schema. */
export function isNewerSchemaRecord(value: unknown): boolean {
  return isRecord(value)
    && typeof value.schemaVersion === "number"
    && value.schemaVersion > VOICE_LIBRARY_SCHEMA_VERSION;
}
