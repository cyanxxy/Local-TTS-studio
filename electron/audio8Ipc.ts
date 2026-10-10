/**
 * Validation for the `audio8:*` IPC payloads.
 *
 * The main process checks every request here before it reaches the worker,
 * and the worker re-checks the sampling overrides with the same function, so
 * both boundaries accept and reject exactly the same values with the same
 * wording. The worker thread imports this module too, which is why it depends
 * on nothing but the model table and the shared text limits.
 */

import {
  AUDIO8_MAX_SEED,
  AUDIO8_MAX_TEMPERATURE,
  AUDIO8_MAX_TEXT_CHARACTERS,
  AUDIO8_MIN_TEMPERATURE,
  isAudio8VoiceId,
  type Audio8VoiceId,
} from "./audio8Model";
import { exceedsUnicodeScalarLimit } from "./localTtsLimits";

/** Overrides for one take. Each absent field keeps the reference default. */
export interface Audio8SamplingOptions {
  /** mulberry32 seed, a uint32. */
  seed?: number;
  /** Nucleus temperature of the semantic and acoustic draws. */
  temperature?: number;
}

export interface Audio8GenerateRequest {
  requestId: string;
  /** Forwarded untrimmed; only its trimmed emptiness is checked. */
  text: string;
  voice: Audio8VoiceId;
  /** Present only when the caller set at least one override. */
  sampling?: Audio8SamplingOptions;
}

/**
 * Looser than the bridge's `parseRequestId` (no trimming, no `..` rule):
 * Audio8 ids only ever key the worker's in-flight map and never reach a path.
 */
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAudio8RequestId(request: unknown): string {
  if (!isRecord(request) || typeof request.requestId !== "string" || !REQUEST_ID_PATTERN.test(request.requestId)) {
    throw new TypeError("Invalid Audio8 request id.");
  }
  return request.requestId;
}

/**
 * `undefined` and `null` mean "use the default", matching how the bridge
 * treats Qwen's optional numbers. Anything else must be exactly in range: a
 * seed outside uint32 would be silently wrapped by mulberry32, and a
 * non-finite or zero temperature turns every weight into NaN.
 */
export function parseAudio8SamplingOptions(request: Readonly<Record<string, unknown>>): Audio8SamplingOptions | undefined {
  const { seed, temperature } = request;
  const sampling: Audio8SamplingOptions = {};
  if (seed != null) {
    if (typeof seed !== "number" || !Number.isInteger(seed) || seed < 0 || seed > AUDIO8_MAX_SEED) {
      throw new TypeError(`Audio8 seed must be an integer from 0 to ${AUDIO8_MAX_SEED}.`);
    }
    sampling.seed = seed;
  }
  if (temperature != null) {
    if (
      typeof temperature !== "number"
      || !Number.isFinite(temperature)
      || temperature < AUDIO8_MIN_TEMPERATURE
      || temperature > AUDIO8_MAX_TEMPERATURE
    ) {
      throw new TypeError(
        `Audio8 temperature must be a number from ${AUDIO8_MIN_TEMPERATURE} to ${AUDIO8_MAX_TEMPERATURE}.`,
      );
    }
    sampling.temperature = temperature;
  }
  return sampling.seed === undefined && sampling.temperature === undefined ? undefined : sampling;
}

/**
 * Fields are checked in a fixed order (request id, text, voice, sampling) so
 * a payload with several problems always reports the same one first.
 */
export function parseAudio8GenerateRequest(request: unknown): Audio8GenerateRequest {
  const requestId = parseAudio8RequestId(request);
  const payload = request as Record<string, unknown>;
  const { text, voice } = payload;
  if (typeof text !== "string" || text.trim().length === 0 || exceedsUnicodeScalarLimit(text, AUDIO8_MAX_TEXT_CHARACTERS)) {
    throw new TypeError("Invalid Audio8 synthesis text.");
  }
  // Rejected rather than substituted with the default voice: every other enum
  // on this boundary throws, and quietly rendering the whole request in a
  // voice the caller did not ask for is a wrong answer with nothing to show it.
  if (!isAudio8VoiceId(voice)) throw new TypeError("Unsupported Audio8 voice.");
  const sampling = parseAudio8SamplingOptions(payload);
  return { requestId, text, voice, ...(sampling ? { sampling } : {}) };
}
