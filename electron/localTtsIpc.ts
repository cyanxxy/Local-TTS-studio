import type { IpcMainInvokeEvent } from "electron";
import { isAllowedAppUrl } from "./security";

export const BRIDGE_RESULT_PREFIX = "__RESULT__";
export const BRIDGE_PROGRESS_PREFIX = "__PROGRESS__";
export const LOCAL_MODELS = ["neutts", "kani", "qwen3"] as const;

const MAX_GENERATED_AUDIO_BASE64_LENGTH = 100_000_000;
const MAX_TEXT_LENGTH = 6000;
const MAX_REFERENCE_TEXT_LENGTH = 2000;
const MAX_REFERENCE_AUDIO_BASE64_LENGTH = 25_000_000;

const ALLOWED_NEUTTS_MODELS = new Set([
  "neuphonic/neutts-nano",
  "neuphonic/neutts-nano-german",
  "neuphonic/neutts-nano-french",
  "neuphonic/neutts-nano-spanish",
]);

const ALLOWED_KANI_MODELS = new Set([
  "nineninesix/kani-tts-2-en",
]);

const DEFAULT_KANI_LANGUAGE_TAG = "en_us";
const ALLOWED_KANI_LANGUAGE_TAGS = new Set([
  "en_us",
  "en_nyork",
  "en_oakl",
  "en_glasg",
  "en_bost",
  "en_scou",
]);

const ALLOWED_QWEN3_MODELS = new Set([
  "auto",
  // This page is intentionally scoped to the CustomVoice release because its
  // speaker and language controls map to that repository's built-in voices.
  "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
  "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
]);

const ALLOWED_QWEN3_SPEAKERS = new Set([
  "Vivian",
  "Serena",
  "Uncle_Fu",
  "Dylan",
  "Eric",
  "Ryan",
  "Aiden",
  "Ono_Anna",
  "Sohee",
]);

const ALLOWED_QWEN3_LANGUAGES = new Set([
  "Auto",
  "Chinese",
  "English",
  "Japanese",
  "Korean",
  "German",
  "French",
  "Russian",
  "Portuguese",
  "Spanish",
  "Italian",
]);

const ALLOWED_QWEN3_DTYPES = new Set([
  "auto",
  "bfloat16",
  "float16",
  "float32",
]);

const ALLOWED_QWEN3_ATTENTION = new Set([
  "auto",
  "flash_attention_2",
  "sdpa",
  "eager",
]);

const ALLOWED_NEUTTS_CODECS = new Set([
  "neuphonic/neucodec",
  "neuphonic/distill-neucodec",
  "neuphonic/neucodec-onnx-decoder",
  "neuphonic/neucodec-onnx-decoder-int8",
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

export interface PythonResolution {
  pythonBinary: string;
  resolvedFrom: string;
}

export interface ValidatedLocalBridgeRequest {
  model: LocalModel;
  requestId?: string;
  pythonResolution: PythonResolution;
  payload: Record<string, unknown>;
}

export interface BridgeProbeResult {
  ready: boolean;
  message: string;
  pythonVersion: string;
  pythonBinary: string;
  resolvedFrom: string;
  package?: string;
  packageVersion?: string | null;
  requiresPython?: string;
  compatibilityMode?: "legacy_0_1_x" | "current_1_2_x_or_newer" | null;
  warnings?: string[];
  espeakVersion?: string | null;
  espeakSource?: string | null;
  espeakPath?: string | null;
  transformersVersion?: string | null;
  torchVersion?: string | null;
  recommendedModelRepo?: string | null;
  recommendedDeviceMap?: string | null;
  recommendedDtype?: string | null;
  recommendedAttention?: string | null;
}

export interface BridgeGenerateResult {
  wavBase64: string;
  sampleRate: number;
  modelRepo: string;
  durationSec: number;
  elapsedSec: number;
  speakerStatus?: string;
  speakers?: string[];
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

export function parseRequiredText(value: unknown, field: string, maxLength: number = MAX_TEXT_LENGTH): string {
  if (typeof value !== "string") throw new Error(`\`${field}\` must be a string.`);
  const text = value.trim();
  if (!text) throw new Error(`\`${field}\` is required.`);
  if (text.length > maxLength) throw new Error(`\`${field}\` exceeds ${maxLength} characters.`);
  return text;
}

export function parseOptionalString(
  value: unknown,
  field: string,
  { maxLength = 200, pattern }: { maxLength?: number; pattern?: RegExp } = {},
): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") throw new Error(`\`${field}\` must be a string.`);
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > maxLength) throw new Error(`\`${field}\` exceeds ${maxLength} characters.`);
  if (pattern && !pattern.test(text)) throw new Error(`\`${field}\` has an invalid format.`);
  return text;
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

export function sanitizeNeuttsPayload(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) throw new Error("NeuTTS payload must be an object.");

  const text = parseRequiredText(payload.text, "text");
  const referenceText = parseRequiredText(payload.referenceText, "referenceText", MAX_REFERENCE_TEXT_LENGTH);

  if (typeof payload.referenceAudioBase64 !== "string" || payload.referenceAudioBase64.trim().length === 0) {
    throw new Error("`referenceAudioBase64` is required.");
  }
  const referenceAudioBase64 = payload.referenceAudioBase64.trim();
  if (referenceAudioBase64.length > MAX_REFERENCE_AUDIO_BASE64_LENGTH) {
    throw new Error("`referenceAudioBase64` is too large.");
  }

  const modelRepo = parseOptionalString(payload.modelRepo, "modelRepo", { maxLength: 128 });
  if (modelRepo && !ALLOWED_NEUTTS_MODELS.has(modelRepo)) {
    throw new Error("Unsupported NeuTTS model repository.");
  }

  const codecRepo = parseOptionalString(payload.codecRepo, "codecRepo", { maxLength: 128 });
  if (codecRepo && !ALLOWED_NEUTTS_CODECS.has(codecRepo)) {
    throw new Error("Unsupported NeuTTS codec repository.");
  }

  const backboneDevice = parseOptionalString(payload.backboneDevice, "backboneDevice", {
    pattern: /^(cpu|gpu)$/i,
  })?.toLowerCase();
  const codecDevice = parseOptionalString(payload.codecDevice, "codecDevice", {
    pattern: /^(cpu|gpu)$/i,
  })?.toLowerCase();

  return {
    text,
    referenceText,
    referenceAudioBase64,
    modelRepo,
    codecRepo,
    backboneDevice,
    codecDevice,
  };
}

export function sanitizeKaniPayload(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) throw new Error("Kani payload must be an object.");

  const text = parseRequiredText(payload.text, "text");
  const modelRepo = parseOptionalString(payload.modelRepo, "modelRepo", { maxLength: 128 });
  if (modelRepo && !ALLOWED_KANI_MODELS.has(modelRepo)) {
    throw new Error("Unsupported Kani model repository.");
  }

  const languageTag = parseOptionalString(payload.languageTag, "languageTag", {
    maxLength: 32,
    pattern: /^[a-zA-Z0-9_-]+$/,
  })?.toLowerCase() ?? DEFAULT_KANI_LANGUAGE_TAG;
  if (!ALLOWED_KANI_LANGUAGE_TAGS.has(languageTag)) {
    throw new Error("Unsupported Kani language tag.");
  }

  const temperature = parseOptionalNumber(payload.temperature, "temperature", { min: 0.2, max: 2.0 });
  const topP = parseOptionalNumber(payload.topP, "topP", { min: 0.5, max: 1.0 });
  const repetitionPenalty = parseOptionalNumber(payload.repetitionPenalty, "repetitionPenalty", { min: 1.0, max: 2.0 });
  const maxNewTokens = parseOptionalInteger(payload.maxNewTokens, "maxNewTokens", { min: 64, max: 4096 });

  return {
    text,
    modelRepo,
    languageTag,
    temperature,
    topP,
    repetitionPenalty,
    maxNewTokens,
  };
}

export function sanitizeQwen3Payload(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) throw new Error("Qwen3 payload must be an object.");

  const text = parseRequiredText(payload.text, "text");
  const modelRepo = parseOptionalString(payload.modelRepo, "modelRepo", { maxLength: 128 });
  if (modelRepo && !ALLOWED_QWEN3_MODELS.has(modelRepo)) {
    throw new Error("Unsupported Qwen3-TTS model repository.");
  }

  const speaker = parseOptionalString(payload.speaker, "speaker", { maxLength: 64 });
  if (speaker && !ALLOWED_QWEN3_SPEAKERS.has(speaker)) {
    throw new Error("Unsupported Qwen3-TTS speaker.");
  }

  const language = parseOptionalString(payload.language, "language", { maxLength: 32 });
  if (language && !ALLOWED_QWEN3_LANGUAGES.has(language)) {
    throw new Error("Unsupported Qwen3-TTS language.");
  }

  const instruct = parseOptionalString(payload.instruct, "instruct", { maxLength: 1000 });

  const deviceMap = parseOptionalString(payload.deviceMap, "deviceMap", {
    maxLength: 32,
    pattern: /^(auto|cpu|mps|cuda(?::\d+)?)$/i,
  })?.toLowerCase();

  const dtype = parseOptionalString(payload.dtype, "dtype", { maxLength: 16 })?.toLowerCase();
  if (dtype && !ALLOWED_QWEN3_DTYPES.has(dtype)) {
    throw new Error("Unsupported Qwen3-TTS dtype.");
  }

  const attnImplementation = parseOptionalString(payload.attnImplementation, "attnImplementation", { maxLength: 32 });
  if (attnImplementation && !ALLOWED_QWEN3_ATTENTION.has(attnImplementation)) {
    throw new Error("Unsupported Qwen3-TTS attention implementation.");
  }

  const temperature = parseOptionalNumber(payload.temperature, "temperature", { min: 0.2, max: 2.0 });
  const topP = parseOptionalNumber(payload.topP, "topP", { min: 0.5, max: 1.0 });
  const maxNewTokens = parseOptionalInteger(payload.maxNewTokens, "maxNewTokens", { min: 64, max: 8192 });

  return {
    text,
    modelRepo,
    speaker,
    language,
    instruct,
    deviceMap,
    dtype,
    attnImplementation,
    temperature,
    topP,
    maxNewTokens,
  };
}

export function sanitizeGeneratePayload(model: LocalModel, payload: unknown): Record<string, unknown> {
  if (model === "neutts") return sanitizeNeuttsPayload(payload);
  if (model === "qwen3") return sanitizeQwen3Payload(payload);
  return sanitizeKaniPayload(payload);
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

export function parseBridgeProbeResult(
  result: unknown,
  pythonResolution: PythonResolution,
): BridgeProbeResult {
  if (!isRecord(result)) throw new Error("Invalid probe response from Python bridge.");
  if (typeof result.ready !== "boolean") throw new Error("Probe response missing `ready` boolean.");
  if (typeof result.message !== "string") throw new Error("Probe response missing `message` string.");
  if (typeof result.pythonVersion !== "string") throw new Error("Probe response missing `pythonVersion` string.");

  const parsed: BridgeProbeResult = {
    ready: result.ready,
    message: result.message,
    pythonVersion: result.pythonVersion,
    pythonBinary: pythonResolution.pythonBinary,
    resolvedFrom: pythonResolution.resolvedFrom,
  };

  if (result.package != null) {
    if (typeof result.package !== "string") throw new Error("Probe response has invalid `package`.");
    parsed.package = result.package;
  }
  if (result.packageVersion != null && typeof result.packageVersion !== "string") {
    throw new Error("Probe response has invalid `packageVersion`.");
  }
  if (result.packageVersion != null) parsed.packageVersion = result.packageVersion;
  if (result.requiresPython != null) {
    if (typeof result.requiresPython !== "string") throw new Error("Probe response has invalid `requiresPython`.");
    parsed.requiresPython = result.requiresPython;
  }
  if (result.compatibilityMode != null) {
    if (result.compatibilityMode !== "legacy_0_1_x" && result.compatibilityMode !== "current_1_2_x_or_newer") {
      throw new Error("Probe response has invalid `compatibilityMode`.");
    }
    parsed.compatibilityMode = result.compatibilityMode;
  }
  const warnings = parseOptionalStringArray(result.warnings, "warnings");
  if (warnings) parsed.warnings = warnings;
  if (result.espeakVersion != null) {
    if (typeof result.espeakVersion !== "string") throw new Error("Probe response has invalid `espeakVersion`.");
    parsed.espeakVersion = result.espeakVersion;
  }
  if (result.espeakSource != null) {
    if (typeof result.espeakSource !== "string") throw new Error("Probe response has invalid `espeakSource`.");
    parsed.espeakSource = result.espeakSource;
  }
  if (result.espeakPath != null) {
    if (typeof result.espeakPath !== "string") throw new Error("Probe response has invalid `espeakPath`.");
    parsed.espeakPath = result.espeakPath;
  }
  if (result.transformersVersion != null) {
    if (typeof result.transformersVersion !== "string") throw new Error("Probe response has invalid `transformersVersion`.");
    parsed.transformersVersion = result.transformersVersion;
  }
  if (result.torchVersion != null) {
    if (typeof result.torchVersion !== "string") throw new Error("Probe response has invalid `torchVersion`.");
    parsed.torchVersion = result.torchVersion;
  }
  if (result.recommendedModelRepo != null) {
    if (typeof result.recommendedModelRepo !== "string") {
      throw new Error("Probe response has invalid `recommendedModelRepo`.");
    }
    parsed.recommendedModelRepo = result.recommendedModelRepo;
  }
  if (result.recommendedDeviceMap != null) {
    if (typeof result.recommendedDeviceMap !== "string") {
      throw new Error("Probe response has invalid `recommendedDeviceMap`.");
    }
    parsed.recommendedDeviceMap = result.recommendedDeviceMap;
  }
  if (result.recommendedDtype != null) {
    if (typeof result.recommendedDtype !== "string") throw new Error("Probe response has invalid `recommendedDtype`.");
    parsed.recommendedDtype = result.recommendedDtype;
  }
  if (result.recommendedAttention != null) {
    if (typeof result.recommendedAttention !== "string") {
      throw new Error("Probe response has invalid `recommendedAttention`.");
    }
    parsed.recommendedAttention = result.recommendedAttention;
  }

  return parsed;
}

export function parseBridgeProgressResult(value: unknown): BridgeProgressResult {
  if (!isRecord(value)) throw new Error("Invalid progress response from Python bridge.");
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
  if (!isRecord(result)) throw new Error("Invalid generation response from Python bridge.");
  if (typeof result.wavBase64 !== "string" || result.wavBase64.length === 0) {
    throw new Error("Generation response missing `wavBase64`.");
  }
  if (result.wavBase64.length > MAX_GENERATED_AUDIO_BASE64_LENGTH) {
    throw new Error("Generation response audio exceeds maximum allowed size.");
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

  const parsed: BridgeGenerateResult = {
    wavBase64: result.wavBase64,
    sampleRate: result.sampleRate,
    modelRepo: result.modelRepo,
    durationSec: result.durationSec,
    elapsedSec: result.elapsedSec,
  };

  if (result.speakerStatus != null) {
    if (typeof result.speakerStatus !== "string") throw new Error("Generation response has invalid `speakerStatus`.");
    parsed.speakerStatus = result.speakerStatus;
  }
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
  pythonResolution: PythonResolution,
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
      console.error(`[local-tts:${action}] Python bridge details\n${parsed.details}`);
    }
    throw new Error(parsed.error ?? "Python bridge failed.");
  }

  return action === "probe"
    ? parseBridgeProbeResult(parsed.result, pythonResolution)
    : parseBridgeGenerateResult(parsed.result);
}

// Some Python dependencies print unconditional setup noise to stderr at import
// time (e.g. the `sox` package warns when the SoX CLI is absent, even though it
// is unused). On a hard crash that noise must not be mistaken for the real error.
const PYTHON_STDERR_NOISE_PATTERNS: RegExp[] = [
  /sox: command not found/i,
  /SoX could not be found/i,
  /sox\.sourceforge\.net/i,
  /have SoX/i,
  /double-check your/i,
  /^path variables\.?$/i,
  /flash[-_]attn/i,
];

function isNoisyPythonStderrLine(line: string): boolean {
  if (line.startsWith("Traceback")) return true;
  if (line.startsWith("File ")) return true;
  if (line.startsWith("During handling of the above exception")) return true;
  // Decoration-only lines such as "********" or "- - -" carry no information.
  if (/^[^A-Za-z0-9]+$/.test(line)) return true;
  return PYTHON_STDERR_NOISE_PATTERNS.some((pattern) => pattern.test(line));
}

export function extractUserFacingPythonProcessError(stderr: string, code: number | null): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const message = lines.find((line) => !isNoisyPythonStderrLine(line)) ?? lines.at(-1);
  return message ?? `Python process exited with code ${code ?? "unknown"}.`;
}
