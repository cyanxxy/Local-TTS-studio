import { KOKORO_FALLBACK_VOICES, MODELS } from "../constants";

export function resolveKokoroVoice(
  requestedVoice: string,
  availableVoices: readonly string[],
): string | null {
  if (availableVoices.length === 0) return null;
  if (availableVoices.includes(requestedVoice)) return requestedVoice;
  if (availableVoices.includes(MODELS.kokoro.defaultVoice)) return MODELS.kokoro.defaultVoice;
  return availableVoices[0] ?? null;
}

export function getKokoroFallbackVoices(): string[] {
  return [...KOKORO_FALLBACK_VOICES];
}
