import type { IpcMainInvokeEvent } from "electron";
import { isAllowedAppUrl } from "./security";

export const BRIDGE_RESULT_PREFIX = "__RESULT__";
export const BRIDGE_PROGRESS_PREFIX = "__PROGRESS__";
export const LOCAL_MODELS = ["neutts", "qwen3"] as const;

const MAX_TEXT_LENGTH = 6000;
const MAX_REFERENCE_TEXT_LENGTH = 2000;
const MAX_REFERENCE_CODES_BASE64_LENGTH = 25_000_000;
const MAX_REFERENCE_AUDIO_BASE64_LENGTH = 60_000_000;

const ALLOWED_NEUTTS_MODELS = new Set([
  "neuphonic/neutts-nano-q4-gguf",
  "neuphonic/neutts-nano-q8-gguf",
  "neuphonic/neutts-nano-german-q4-gguf",
  "neuphonic/neutts-nano-german-q8-gguf",
  "neuphonic/neutts-nano-french-q4-gguf",
  "neuphonic/neutts-nano-french-q8-gguf",
  "neuphonic/neutts-nano-spanish-q4-gguf",
  "neuphonic/neutts-nano-spanish-q8-gguf",
]);

const ALLOWED_QWEN3_MODELS = new Set([
  "auto",
  "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
  "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
  "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit",
  "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-6bit",
  "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-6bit",
  "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-6bit",
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
  "Spanish",
]);

const ALLOWED_QWEN3_DTYPES = new Set(["auto", "float32", "bfloat16"]);
const ALLOWED_QWEN3_ATTENTION = new Set(["auto", "eager"]);
const ALLOWED_QWEN3_DEVICES = new Set(["auto", "cpu", "metal"]);
const ALLOWED_QWEN3_MODES = new Set(["customVoice", "voiceClone"]);

function isQwen3BaseModel(modelRepo: string | undefined): boolean {
  return !!modelRepo && modelRepo.includes("-Base-");
}

function isQwen3MlxCustomVoiceModel(modelRepo: string | undefined): boolean {
  return !!modelRepo && modelRepo.startsWith("mlx-community/") && modelRepo.includes("-CustomVoice-");
}

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
}

export interface BridgeProbeMlxEngines {
  apiServer: boolean;
  tts: boolean;
  worker: boolean;
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
  recommendedDeviceMap?: string | null;
  recommendedDtype?: string | null;
  recommendedAttention?: string | null;
  /** Engine binaries the Rust bridge itself resolved (Qwen3 only). */
  mlxEngines?: BridgeProbeMlxEngines;
}

export interface WarmRequest {
  model: LocalModel;
  payload: Record<string, unknown>;
}

export interface BridgeWarmResult {
  warmed: boolean;
  message?: string;
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

  const referenceCodesBase64 = parseOptionalString(payload.referenceCodesBase64, "referenceCodesBase64", {
    maxLength: MAX_REFERENCE_CODES_BASE64_LENGTH,
  });
  const referenceAudioBase64 = parseOptionalString(payload.referenceAudioBase64, "referenceAudioBase64", {
    maxLength: MAX_REFERENCE_AUDIO_BASE64_LENGTH,
  });
  if (!referenceCodesBase64 && !referenceAudioBase64) {
    throw new Error("A `referenceCodesBase64` (.npy) or `referenceAudioBase64` (WAV) payload is required.");
  }

  const modelRepo = parseOptionalString(payload.modelRepo, "modelRepo", { maxLength: 128 });
  if (modelRepo && !ALLOWED_NEUTTS_MODELS.has(modelRepo)) {
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

export function sanitizeQwen3Payload(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) throw new Error("Qwen3 payload must be an object.");

  const text = parseRequiredText(payload.text, "text");
  const mode = parseOptionalString(payload.mode, "mode", { maxLength: 32 }) ?? "customVoice";
  if (!ALLOWED_QWEN3_MODES.has(mode)) {
    throw new Error("Unsupported Qwen3-TTS mode.");
  }
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
  const baseModelPath = parseOptionalString(payload.baseModelPath, "baseModelPath", {
    maxLength: 1000,
    pattern: /^[^\0]+$/,
  });
  const referenceText = parseOptionalString(payload.referenceText, "referenceText", {
    maxLength: MAX_REFERENCE_TEXT_LENGTH,
  });
  const referenceAudioName = parseOptionalString(payload.referenceAudioName, "referenceAudioName", {
    maxLength: 255,
    pattern: /^[^/\\\0]+\.wav$/i,
  });
  const referenceAudioBase64 = parseOptionalString(payload.referenceAudioBase64, "referenceAudioBase64", {
    maxLength: MAX_REFERENCE_AUDIO_BASE64_LENGTH,
  });

  if (mode === "voiceClone") {
    if (!isQwen3BaseModel(modelRepo)) {
      throw new Error("Qwen3-TTS voice cloning requires a Base model repository.");
    }
    if (!baseModelPath) throw new Error("`baseModelPath` is required for Qwen3-TTS voice cloning.");
    if (!referenceText) throw new Error("`referenceText` is required for Qwen3-TTS voice cloning.");
    if (!referenceAudioName || !referenceAudioBase64) {
      throw new Error("A WAV `referenceAudioBase64` payload is required for Qwen3-TTS voice cloning.");
    }
  } else {
    if (isQwen3BaseModel(modelRepo)) {
      throw new Error("Qwen3-TTS Base models require voiceClone mode.");
    }
    if (isQwen3MlxCustomVoiceModel(modelRepo) && !baseModelPath) {
      throw new Error("`baseModelPath` is required for Qwen3-TTS MLX CustomVoice.");
    }
  }

  const deviceMap = parseOptionalString(payload.deviceMap, "deviceMap", {
    maxLength: 32,
    pattern: /^(auto|cpu|metal)$/i,
  })?.toLowerCase();
  if (deviceMap && !ALLOWED_QWEN3_DEVICES.has(deviceMap)) {
    throw new Error("Unsupported Qwen3-TTS device map.");
  }

  const dtype = parseOptionalString(payload.dtype, "dtype", { maxLength: 16 })?.toLowerCase();
  if (dtype && !ALLOWED_QWEN3_DTYPES.has(dtype)) {
    throw new Error("Unsupported Qwen3-TTS dtype.");
  }

  const attnImplementation = parseOptionalString(payload.attnImplementation, "attnImplementation", { maxLength: 32 });
  if (attnImplementation && !ALLOWED_QWEN3_ATTENTION.has(attnImplementation)) {
    throw new Error("Unsupported Qwen3-TTS attention implementation.");
  }

  const temperature = parseOptionalNumber(payload.temperature, "temperature", { min: 0.2, max: 2.0 });
  const topK = parseOptionalInteger(payload.topK, "topK", { min: 0, max: 1000 });
  const topP = parseOptionalNumber(payload.topP, "topP", { min: 0.5, max: 1.0 });
  const maxNewTokens = parseOptionalInteger(payload.maxNewTokens, "maxNewTokens", { min: 64, max: 8192 });

  return {
    text,
    ...(payload.mode != null ? { mode } : {}),
    modelRepo,
    ...(baseModelPath ? { baseModelPath } : {}),
    ...(referenceText ? { referenceText } : {}),
    ...(referenceAudioName ? { referenceAudioName } : {}),
    ...(referenceAudioBase64 ? { referenceAudioBase64 } : {}),
    speaker,
    language,
    instruct,
    deviceMap,
    dtype,
    attnImplementation,
    temperature,
    topK,
    topP,
    maxNewTokens,
  };
}

export function sanitizeGeneratePayload(model: LocalModel, payload: unknown): Record<string, unknown> {
  return model === "neutts" ? sanitizeNeuttsPayload(payload) : sanitizeQwen3Payload(payload);
}

export function sanitizeWarmRequest(request: unknown): WarmRequest {
  if (!isRecord(request)) throw new Error("Invalid warm request payload.");
  const model = assertLocalModel(String(request.model));
  const baseModelPath = parseOptionalString(request.baseModelPath, "baseModelPath", {
    maxLength: 1000,
    pattern: /^[^\0]+$/,
  });
  return {
    model,
    payload: baseModelPath ? { baseModelPath } : {},
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
  if (result.mlxEngines != null) {
    if (
      !isRecord(result.mlxEngines)
      || typeof result.mlxEngines.apiServer !== "boolean"
      || typeof result.mlxEngines.tts !== "boolean"
      || typeof result.mlxEngines.worker !== "boolean"
    ) {
      throw new Error("Probe response has invalid `mlxEngines`.");
    }
    parsed.mlxEngines = {
      apiServer: result.mlxEngines.apiServer,
      tts: result.mlxEngines.tts,
      worker: result.mlxEngines.worker,
    };
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
