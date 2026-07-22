import type { IpcMainInvokeEvent } from "electron";
import type { GenerationContinuation } from "./generateRateLimiter";
import {
  getQwen3Profile,
  qwen3ProfileSupportsRuntime,
  QWEN3_LANGUAGES,
  QWEN3_SPEAKERS,
  type Qwen3Mode,
} from "./qwen3Profiles";
import {
  MAX_LOCAL_TTS_TEXT_LENGTH,
  MAX_REFERENCE_AUDIO_BASE64_LENGTH,
  MAX_REFERENCE_CODES_BASE64_LENGTH,
  exceedsUnicodeScalarLimit,
} from "./localTtsLimits";
import { isAllowedAppUrl } from "./security";

export const BRIDGE_RESULT_PREFIX = "__RESULT__";
export const BRIDGE_PROGRESS_PREFIX = "__PROGRESS__";
export const LOCAL_MODELS = ["neutts", "qwen3"] as const;

const MAX_REFERENCE_TEXT_LENGTH = 2000;

const ALLOWED_NEUTTS_MODELS = new Set([
  "neuphonic/neutts-nano-q4-gguf",
  "neuphonic/neutts-air-q4-gguf",
  "neuphonic/neutts-air-q8-gguf",
  "neuphonic/neutts-nano-german-q4-gguf",
  "neuphonic/neutts-nano-french-q4-gguf",
  "neuphonic/neutts-nano-spanish-q4-gguf",
]);

const LEGACY_NEUTTS_MODEL_REPLACEMENTS = new Map([
  ["neuphonic/neutts-nano-q8-gguf", "neuphonic/neutts-nano-q4-gguf"],
  ["neuphonic/neutts-nano-german-q8-gguf", "neuphonic/neutts-nano-german-q4-gguf"],
  ["neuphonic/neutts-nano-french-q8-gguf", "neuphonic/neutts-nano-french-q4-gguf"],
  ["neuphonic/neutts-nano-spanish-q8-gguf", "neuphonic/neutts-nano-spanish-q4-gguf"],
]);

const ALLOWED_QWEN3_SPEAKERS = new Set<string>(QWEN3_SPEAKERS);
const ALLOWED_QWEN3_LANGUAGES = new Set<string>(QWEN3_LANGUAGES);
const ALLOWED_QWEN3_MODES = new Set<Qwen3Mode>(["customVoice", "voiceClone", "voiceDesign"]);
const QWEN3_GENERATE_FIELDS = new Set([
  "text",
  "mode",
  "modelRepo",
  "modelPath",
  "referenceAudioBase64",
  "referenceText",
  "referenceCacheKey",
  "speaker",
  "language",
  "instruct",
  "temperature",
  "topK",
  "maxNewTokens",
]);

export type LocalModel = typeof LOCAL_MODELS[number];
export type BridgeAction = "probe" | "generate";

export interface CacheRequest {
  model: LocalModel;
}

export interface CancelRequest extends CacheRequest {
  requestId: string;
}

export interface LocalCacheInfo {
  path: string;
  exists: boolean;
  sizeBytes: number;
}

export interface ValidatedLocalBridgeRequest {
  model: LocalModel;
  requestId?: string;
  payload: Record<string, unknown>;
  continuation?: GenerationContinuation;
}

export interface BridgeProbeResult {
  ready: boolean;
  message: string;
  runtime: "rust";
  package?: string;
  packageVersion?: string | null;
  warnings?: string[];
  recommendedModelRepo?: string | null;
  recommendedBaseModelRepo?: string | null;
  provider?: string;
  device?: string;
  accelerated?: boolean;
  upstreamRevision?: string;
}

export interface WarmRequest {
  model: LocalModel;
  payload: Record<string, unknown>;
  modelRepo?: string;
}

export interface BridgeWarmResult {
  warmed: boolean;
  message?: string;
  provider?: string;
  device?: string;
  accelerated?: boolean;
}

export interface BridgeGenerateResult {
  sampleRate: number;
  modelRepo: string;
  durationSec: number;
  elapsedSec: number;
  device?: string;
  warnings?: string[];
  speakerStatus?: string;
  speakers?: string[];
  audioTransport: "websocket-binary";
  audioChunkCount: number;
  phaseTimingsSec: Record<string, number>;
}

export interface BridgeProgressResult {
  phase: string;
  message: string;
  elapsedSec?: number;
}

export function assertTrustedIpcSender(
  event: IpcMainInvokeEvent,
  options: { allowDevServer?: boolean } = { allowDevServer: true },
): void {
  const senderUrl = event.senderFrame?.url ?? event.sender.getURL();
  if (!isAllowedAppUrl(senderUrl, options)) {
    throw new Error("Rejected IPC from untrusted sender.");
  }
}

export function assertLocalModel(model: string): LocalModel {
  if (LOCAL_MODELS.includes(model as LocalModel)) {
    return model as LocalModel;
  }
  throw new Error(`Unsupported local model: ${model}`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRequiredText(
  value: unknown,
  field: string,
  maxLength: number = MAX_LOCAL_TTS_TEXT_LENGTH,
): string {
  if (typeof value !== "string") throw new Error(`\`${field}\` must be a string.`);
  const text = value.trim();
  if (!text) throw new Error(`\`${field}\` is required.`);
  if (exceedsUnicodeScalarLimit(text, maxLength)) {
    throw new Error(`\`${field}\` exceeds ${maxLength} characters.`);
  }
  return text;
}

export function parseOptionalString(
  value: unknown,
  field: string,
  { maxLength = 200, pattern }: { maxLength?: number; pattern?: RegExp } = {},
): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") throw new Error(`\`${field}\` must be a string.`);
  if (value.length > maxLength) throw new Error(`\`${field}\` exceeds ${maxLength} characters.`);
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > maxLength) throw new Error(`\`${field}\` exceeds ${maxLength} characters.`);
  if (pattern && !pattern.test(text)) throw new Error(`\`${field}\` has an invalid format.`);
  return text;
}

function parseOptionalBase64(value: unknown, field: string, maxLength: number): string | undefined {
  const encoded = parseOptionalString(value, field, { maxLength });
  if (!encoded) return undefined;
  if (encoded.length % 4 !== 0) throw new Error(`\`${field}\` must be canonical padded base64.`);
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const contentLength = encoded.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    const code = encoded.charCodeAt(index);
    const allowed = (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57)
      || code === 43
      || code === 47;
    if (!allowed) throw new Error(`\`${field}\` must be canonical padded base64.`);
  }
  for (let index = contentLength; index < encoded.length; index += 1) {
    if (encoded.charCodeAt(index) !== 61) {
      throw new Error(`\`${field}\` must be canonical padded base64.`);
    }
  }
  const finalCode = encoded.charCodeAt(contentLength - 1);
  const finalSextet = finalCode >= 65 && finalCode <= 90
    ? finalCode - 65
    : finalCode >= 97 && finalCode <= 122
      ? finalCode - 97 + 26
      : finalCode >= 48 && finalCode <= 57
        ? finalCode - 48 + 52
        : finalCode === 43
          ? 62
          : 63;
  if ((padding === 1 && (finalSextet & 0b11) !== 0)
    || (padding === 2 && (finalSextet & 0b1111) !== 0)) {
    throw new Error(`\`${field}\` must be canonical padded base64.`);
  }
  return encoded;
}

export function parseOptionalNumber(
  value: unknown,
  field: string,
  { min, max }: { min: number; max: number },
): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`\`${field}\` must be a finite number.`);
  }
  if (value < min || value > max) {
    throw new Error(`\`${field}\` must be between ${min} and ${max}.`);
  }
  return value;
}

export function parseOptionalInteger(
  value: unknown,
  field: string,
  { min, max }: { min: number; max: number },
): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`\`${field}\` must be an integer.`);
  }
  if (value < min || value > max) {
    throw new Error(`\`${field}\` must be between ${min} and ${max}.`);
  }
  return value;
}

export function parseOptionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`\`${field}\` must be an array of strings.`);
  }
  return value;
}

export function parseRequestId(value: unknown, { required = false }: { required?: boolean } = {}): string | undefined {
  if (value == null) {
    if (required) throw new Error("`requestId` is required.");
    return undefined;
  }
  if (typeof value !== "string") throw new Error("`requestId` must be a string.");
  if (value.length > 120) throw new Error("`requestId` exceeds 120 characters.");
  const requestId = value.trim();
  if (!requestId) {
    if (required) throw new Error("`requestId` is required.");
    return undefined;
  }
  if (requestId.length > 120) throw new Error("`requestId` exceeds 120 characters.");
  if (!/^[A-Za-z0-9._-]+$/.test(requestId)) {
    throw new Error("`requestId` may contain only letters, numbers, dots, underscores, and dashes.");
  }
  if (requestId.includes("..")) {
    throw new Error("`requestId` may not contain consecutive dots.");
  }
  return requestId;
}

export function sanitizeGenerationContinuation(value: unknown): GenerationContinuation | undefined {
  if (value == null) return undefined;
  if (!isRecord(value)) throw new Error("`continuation` must be an object.");
  const unknownField = Object.keys(value).find((field) => (
    !["jobId", "sectionIndex", "sectionCount"].includes(field)
  ));
  if (unknownField) throw new Error(`Unknown generation continuation field: \`${unknownField}\`.`);
  const jobId = parseRequestId(value.jobId, { required: true })!;
  const sectionIndex = parseOptionalInteger(value.sectionIndex, "sectionIndex", {
    min: 0,
    max: 100_000,
  });
  const sectionCount = parseOptionalInteger(value.sectionCount, "sectionCount", {
    min: 1,
    max: 100_000,
  });
  if (sectionIndex == null || sectionCount == null) {
    throw new Error("Generation continuation requires `sectionIndex` and `sectionCount`.");
  }
  if (sectionIndex >= sectionCount) {
    throw new Error("Generation continuation `sectionIndex` must be smaller than `sectionCount`.");
  }
  return { jobId, sectionIndex, sectionCount };
}

export function sanitizeNeuttsPayload(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) throw new Error("NeuTTS payload must be an object.");

  const text = parseRequiredText(payload.text, "text");
  const referenceText = parseRequiredText(payload.referenceText, "referenceText", MAX_REFERENCE_TEXT_LENGTH);

  const referenceCodesBase64 = parseOptionalBase64(
    payload.referenceCodesBase64,
    "referenceCodesBase64",
    MAX_REFERENCE_CODES_BASE64_LENGTH,
  );
  const referenceAudioBase64 = parseOptionalBase64(
    payload.referenceAudioBase64,
    "referenceAudioBase64",
    MAX_REFERENCE_AUDIO_BASE64_LENGTH,
  );
  if (!referenceCodesBase64 && !referenceAudioBase64) {
    throw new Error("A `referenceCodesBase64` (.npy) or `referenceAudioBase64` (WAV) payload is required.");
  }
  if (referenceCodesBase64 && referenceAudioBase64) {
    throw new Error("Provide either `referenceCodesBase64` or `referenceAudioBase64`, not both.");
  }

  const modelRepo = parseOptionalString(payload.modelRepo, "modelRepo", { maxLength: 128 });
  if (modelRepo && !ALLOWED_NEUTTS_MODELS.has(modelRepo)) {
    const replacement = LEGACY_NEUTTS_MODEL_REPLACEMENTS.get(modelRepo);
    if (replacement) {
      throw new Error(
        `Legacy NeuTTS Nano Q8 model \`${modelRepo}\` is no longer supported. Select \`${replacement}\` instead.`,
      );
    }
    throw new Error("Unsupported NeuTTS model repository.");
  }

  return {
    text,
    referenceText,
    ...(referenceCodesBase64 ? { referenceCodesBase64 } : {}),
    ...(referenceAudioBase64 ? { referenceAudioBase64 } : {}),
    modelRepo,
  };
}

export function sanitizeQwen3Payload(
  payload: unknown,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Record<string, unknown> {
  if (!isRecord(payload)) throw new Error("Qwen3 payload must be an object.");
  const unknownField = Object.keys(payload).find((field) => !QWEN3_GENERATE_FIELDS.has(field));
  if (unknownField) throw new Error(`Unknown Qwen3-TTS field: \`${unknownField}\`.`);

  const mode = parseOptionalString(payload.mode, "mode", { maxLength: 32 });
  if (!mode || !ALLOWED_QWEN3_MODES.has(mode as Qwen3Mode)) {
    throw new Error("Unsupported Qwen3-TTS mode.");
  }
  const text = parseRequiredText(
    payload.text,
    "text",
    MAX_LOCAL_TTS_TEXT_LENGTH,
  );
  const modelRepo = parseOptionalString(payload.modelRepo, "modelRepo", { maxLength: 128 });
  if (!modelRepo) throw new Error("`modelRepo` is required for Qwen3-TTS.");
  const profile = getQwen3Profile(modelRepo);
  if (!profile) {
    throw new Error("Unsupported Qwen3-TTS model repository.");
  }
  if (!qwen3ProfileSupportsRuntime(profile, platform, arch)) {
    throw new Error(`Qwen3-TTS profile is unavailable on ${platform}/${arch}.`);
  }
  if (profile.mode !== mode) throw new Error("Qwen3-TTS model repository does not match the requested mode.");

  const modelPath = parseOptionalString(payload.modelPath, "modelPath", {
    maxLength: 1000,
    pattern: /^[^\0]+$/,
  });
  if (!modelPath) throw new Error("`modelPath` is required for Qwen3-TTS.");

  const speaker = parseOptionalString(payload.speaker, "speaker", { maxLength: 64 });
  if (speaker && !ALLOWED_QWEN3_SPEAKERS.has(speaker)) {
    throw new Error("Unsupported Qwen3-TTS speaker.");
  }

  const language = parseOptionalString(payload.language, "language", { maxLength: 32 });
  if (language && !ALLOWED_QWEN3_LANGUAGES.has(language)) {
    throw new Error("Unsupported Qwen3-TTS language.");
  }

  const instruct = parseOptionalString(payload.instruct, "instruct", { maxLength: 1000 });
  const referenceText = parseOptionalString(payload.referenceText, "referenceText", {
    maxLength: MAX_REFERENCE_TEXT_LENGTH,
  });
  const referenceAudioBase64 = parseOptionalBase64(
    payload.referenceAudioBase64,
    "referenceAudioBase64",
    MAX_REFERENCE_AUDIO_BASE64_LENGTH,
  );
  const referenceCacheKey = parseOptionalString(payload.referenceCacheKey, "referenceCacheKey", {
    maxLength: 120,
    pattern: /^(?!.*\.\.)[A-Za-z0-9._-]+$/,
  });

  if (mode === "voiceClone") {
    if (speaker || instruct) {
      throw new Error("Qwen3-TTS voice cloning does not accept `speaker` or `instruct`.");
    }
    const hasReferenceWav = !!referenceAudioBase64;
    const hasReferenceText = !!referenceText;
    if (hasReferenceWav !== hasReferenceText) {
      throw new Error("Qwen3-TTS voice cloning requires `referenceText` together with `referenceAudioBase64`.");
    }
    if (!hasReferenceWav && !referenceCacheKey) {
      throw new Error("Qwen3-TTS voice cloning requires a reference WAV or `referenceCacheKey`.");
    }
  } else {
    if (referenceText || referenceAudioBase64 || referenceCacheKey) {
      throw new Error("This Qwen3-TTS mode does not accept voice-clone reference fields.");
    }
    if (mode === "voiceDesign" && speaker) {
      throw new Error("Qwen3-TTS VoiceDesign does not accept a predefined speaker.");
    }
    if (mode === "voiceDesign" && !instruct) {
      throw new Error("Qwen3-TTS VoiceDesign requires a non-empty `instruct` voice description.");
    }
  }

  const temperature = parseOptionalNumber(payload.temperature, "temperature", { min: 0.2, max: 2.0 });
  const topK = parseOptionalInteger(payload.topK, "topK", { min: 0, max: 1000 });
  const maxNewTokens = parseOptionalInteger(payload.maxNewTokens, "maxNewTokens", { min: 64, max: 8192 });

  return {
    text,
    mode,
    modelRepo,
    modelPath,
    ...(referenceText ? { referenceText } : {}),
    ...(referenceAudioBase64 ? { referenceAudioBase64 } : {}),
    ...(referenceCacheKey ? { referenceCacheKey } : {}),
    speaker,
    language,
    instruct,
    temperature,
    topK,
    maxNewTokens,
  };
}

export function sanitizeGeneratePayload(
  model: LocalModel,
  payload: unknown,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Record<string, unknown> {
  return model === "neutts" ? sanitizeNeuttsPayload(payload) : sanitizeQwen3Payload(payload, platform, arch);
}

export function sanitizeWarmRequest(
  request: unknown,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): WarmRequest {
  if (!isRecord(request)) throw new Error("Invalid warm request payload.");
  const model = assertLocalModel(String(request.model));
  if (model !== "qwen3") return { model, payload: {} };
  const unknownField = Object.keys(request).find((field) => !["model", "mode", "modelPath", "modelRepo"].includes(field));
  if (unknownField) throw new Error(`Unknown Qwen3-TTS warm-up field: \`${unknownField}\`.`);
  const mode = parseOptionalString(request.mode, "mode", { maxLength: 32 });
  if (!mode || !ALLOWED_QWEN3_MODES.has(mode as Qwen3Mode)) throw new Error("Unsupported Qwen3-TTS mode.");
  const modelPath = parseOptionalString(request.modelPath, "modelPath", {
    maxLength: 1000,
    pattern: /^[^\0]+$/,
  });
  if (!modelPath) throw new Error("`modelPath` is required for Qwen3-TTS warm-up.");
  const modelRepo = parseOptionalString(request.modelRepo, "modelRepo", { maxLength: 128 });
  if (!modelRepo) throw new Error("`modelRepo` is required for Qwen3-TTS warm-up.");
  const profile = getQwen3Profile(modelRepo);
  if (!profile || profile.mode !== mode || !qwen3ProfileSupportsRuntime(profile, platform, arch)) {
    throw new Error("Unsupported Qwen3-TTS warm-up profile for this runtime.");
  }
  return {
    model,
    modelRepo,
    payload: { mode, modelPath },
  };
}

export function sanitizeCacheRequest(request: unknown): CacheRequest {
  if (!isRecord(request)) throw new Error("Invalid cache request payload.");
  return { model: assertLocalModel(String(request.model)) };
}

export function sanitizeCancelRequest(request: unknown): CancelRequest {
  if (!isRecord(request)) throw new Error("Invalid cancel request payload.");
  return {
    model: assertLocalModel(String(request.model)),
    requestId: parseRequestId(request.requestId, { required: true })!,
  };
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function parseBridgeProbeResult(result: unknown): BridgeProbeResult {
  if (!isRecord(result)) throw new Error("Invalid probe response from local bridge.");
  if (typeof result.ready !== "boolean") throw new Error("Probe response missing `ready` boolean.");
  if (typeof result.message !== "string") throw new Error("Probe response missing `message` string.");
  if (result.runtime !== "rust") throw new Error("Probe response missing Rust runtime marker.");

  const parsed: BridgeProbeResult = {
    ready: result.ready,
    message: result.message,
    runtime: "rust",
  };

  if (result.package != null) {
    if (typeof result.package !== "string") throw new Error("Probe response has invalid `package`.");
    parsed.package = result.package;
  }
  if (result.packageVersion != null && typeof result.packageVersion !== "string") {
    throw new Error("Probe response has invalid `packageVersion`.");
  }
  if (result.packageVersion != null) parsed.packageVersion = result.packageVersion;
  const warnings = parseOptionalStringArray(result.warnings, "warnings");
  if (warnings) parsed.warnings = warnings;
  if (result.recommendedModelRepo != null) {
    if (typeof result.recommendedModelRepo !== "string") {
      throw new Error("Probe response has invalid `recommendedModelRepo`.");
    }
    parsed.recommendedModelRepo = result.recommendedModelRepo;
  }
  if (result.recommendedBaseModelRepo != null) {
    if (typeof result.recommendedBaseModelRepo !== "string") {
      throw new Error("Probe response has invalid `recommendedBaseModelRepo`.");
    }
    parsed.recommendedBaseModelRepo = result.recommendedBaseModelRepo;
  }
  if (result.provider != null) {
    if (typeof result.provider !== "string") throw new Error("Probe response has invalid `provider`.");
    parsed.provider = result.provider;
  }
  if (result.device != null) {
    if (typeof result.device !== "string") throw new Error("Probe response has invalid `device`.");
    parsed.device = result.device;
  }
  if (result.accelerated != null) {
    if (typeof result.accelerated !== "boolean") {
      throw new Error("Probe response has invalid `accelerated` marker.");
    }
    parsed.accelerated = result.accelerated;
  }
  if (result.upstreamRevision != null) {
    if (typeof result.upstreamRevision !== "string") {
      throw new Error("Probe response has invalid `upstreamRevision`.");
    }
    parsed.upstreamRevision = result.upstreamRevision;
  }

  return parsed;
}

// Warm-up is best-effort: a malformed or failed envelope degrades to
// `warmed: false` with the reason instead of throwing, so a warm-up can never
// surface an error dialog the generation path would explain better.
export function parseBridgeWarmResult(decoded: unknown): BridgeWarmResult {
  if (!isRecord(decoded) || decoded.ok !== true) {
    const error = isRecord(decoded) && typeof decoded.error === "string"
      ? decoded.error
      : "Local bridge warm-up failed.";
    return { warmed: false, message: error };
  }
  if (!isRecord(decoded.result) || typeof decoded.result.warmed !== "boolean") {
    return { warmed: false, message: "Local bridge returned an invalid warm-up result." };
  }
  return {
    warmed: decoded.result.warmed,
    ...(typeof decoded.result.message === "string" ? { message: decoded.result.message } : {}),
    ...(typeof decoded.result.provider === "string" ? { provider: decoded.result.provider } : {}),
    ...(typeof decoded.result.device === "string" ? { device: decoded.result.device } : {}),
    ...(typeof decoded.result.accelerated === "boolean"
      ? { accelerated: decoded.result.accelerated }
      : {}),
  };
}

export function parseBridgeProgressResult(value: unknown): BridgeProgressResult {
  if (!isRecord(value)) throw new Error("Invalid progress response from local bridge.");
  if (typeof value.phase !== "string" || !value.phase.trim()) {
    throw new Error("Progress response missing `phase` string.");
  }
  if (typeof value.message !== "string" || !value.message.trim()) {
    throw new Error("Progress response missing `message` string.");
  }

  const parsed: BridgeProgressResult = {
    phase: value.phase,
    message: value.message,
  };

  if (value.elapsedSec != null) {
    if (typeof value.elapsedSec !== "number" || !Number.isFinite(value.elapsedSec) || value.elapsedSec < 0) {
      throw new Error("Progress response has invalid `elapsedSec`.");
    }
    parsed.elapsedSec = value.elapsedSec;
  }

  return parsed;
}

export function parseBridgeGenerateResult(result: unknown): BridgeGenerateResult {
  if (!isRecord(result)) throw new Error("Invalid generation response from local bridge.");
  if ("wavBase64" in result) {
    throw new Error("Generation response must not include `wavBase64`; local generation is WebSocket-binary only.");
  }
  if (typeof result.sampleRate !== "number" || !Number.isFinite(result.sampleRate) || result.sampleRate <= 0) {
    throw new Error("Generation response has invalid `sampleRate`.");
  }
  if (typeof result.modelRepo !== "string" || result.modelRepo.length === 0) {
    throw new Error("Generation response missing `modelRepo`.");
  }
  if (typeof result.durationSec !== "number" || !Number.isFinite(result.durationSec) || result.durationSec < 0) {
    throw new Error("Generation response has invalid `durationSec`.");
  }
  if (typeof result.elapsedSec !== "number" || !Number.isFinite(result.elapsedSec) || result.elapsedSec < 0) {
    throw new Error("Generation response has invalid `elapsedSec`.");
  }
  if (result.audioTransport !== "websocket-binary") {
    throw new Error("Generation response has invalid `audioTransport`.");
  }
  if (
    typeof result.audioChunkCount !== "number"
    || !Number.isInteger(result.audioChunkCount)
    || result.audioChunkCount <= 0
  ) {
    throw new Error("Generation response has invalid `audioChunkCount`.");
  }
  if (!isRecord(result.phaseTimingsSec)) {
    throw new Error("Generation response missing `phaseTimingsSec`.");
  }

  const phaseTimingsSec: Record<string, number> = {};
  for (const [key, value] of Object.entries(result.phaseTimingsSec)) {
    if (!key || typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error("Generation response has invalid `phaseTimingsSec`.");
    }
    phaseTimingsSec[key] = value;
  }

  const parsed: BridgeGenerateResult = {
    sampleRate: result.sampleRate,
    modelRepo: result.modelRepo,
    durationSec: result.durationSec,
    elapsedSec: result.elapsedSec,
    audioTransport: result.audioTransport,
    audioChunkCount: result.audioChunkCount,
    phaseTimingsSec,
  };

  if (result.speakerStatus != null) {
    if (typeof result.speakerStatus !== "string") throw new Error("Generation response has invalid `speakerStatus`.");
    parsed.speakerStatus = result.speakerStatus;
  }
  if (result.device != null) {
    if (typeof result.device !== "string") throw new Error("Generation response has invalid `device`.");
    parsed.device = result.device;
  }
  const warnings = parseOptionalStringArray(result.warnings, "warnings");
  if (warnings) parsed.warnings = warnings;
  if (result.speakers != null) {
    if (!isStringArray(result.speakers)) throw new Error("Generation response has invalid `speakers`.");
    parsed.speakers = result.speakers;
  }

  return parsed;
}

export function parseBridgeResult(
  stdout: string,
  stderr: string,
  action: BridgeAction,
): BridgeProbeResult | BridgeGenerateResult {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const resultLine = [...lines].reverse().find((line) => line.startsWith(BRIDGE_RESULT_PREFIX));

  if (!resultLine) {
    throw new Error(`No bridge result returned. ${stderr || stdout || "No output."}`);
  }

  let parsed: { ok: boolean; result?: unknown; error?: string; details?: string };
  try {
    const decoded = JSON.parse(resultLine.slice(BRIDGE_RESULT_PREFIX.length));
    if (!isRecord(decoded) || typeof decoded.ok !== "boolean") {
      throw new Error("Missing required `ok` field.");
    }
    parsed = {
      ok: decoded.ok,
      result: decoded.result,
      error: typeof decoded.error === "string" ? decoded.error : undefined,
      details: typeof decoded.details === "string" ? decoded.details : undefined,
    };
  } catch (err) {
    throw new Error(`Failed parsing bridge result: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!parsed.ok) {
    if (parsed.details) {
      console.error(`[local-tts:${action}] local bridge details\n${parsed.details}`);
    }
    throw new Error(parsed.error ?? "Local bridge failed.");
  }

  if (action !== "probe") {
    throw new Error("One-shot generate bridge results are not supported; generation is WebSocket-binary only.");
  }

  return parseBridgeProbeResult(parsed.result);
}

export function parseBridgeEnvelopeResult(
  decoded: unknown,
  action: BridgeAction,
): BridgeProbeResult | BridgeGenerateResult {
  if (!isRecord(decoded) || typeof decoded.ok !== "boolean") {
    throw new Error("Missing required `ok` field.");
  }
  const parsed = {
    ok: decoded.ok,
    result: decoded.result,
    error: typeof decoded.error === "string" ? decoded.error : undefined,
    details: typeof decoded.details === "string" ? decoded.details : undefined,
  };

  if (!parsed.ok) {
    if (parsed.details) {
      console.error(`[local-tts:${action}] local bridge details\n${parsed.details}`);
    }
    throw new Error(parsed.error ?? "Local bridge failed.");
  }

  return action === "probe"
    ? parseBridgeProbeResult(parsed.result)
    : parseBridgeGenerateResult(parsed.result);
}
