import type { VoicePreset } from "./types";

/**
 * Deterministic JSON: object keys are sorted so two equal presets always
 * serialize, and therefore hash, the same way.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

/** 64-bit FNV-1a over UTF-16 code units, as 16 hex digits. Not cryptographic. */
export function fnv1a64Hex(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * Cache key for a rendered preview: the same engine, voice, settings and text
 * always map to the same key, and any change to them misses the cache. The
 * label is display-only and deliberately excluded.
 */
export function previewCacheKey(preset: VoicePreset, text: string): string {
  const { engineId, voiceId, mode, settings, libraryVoiceId } = preset;
  return fnv1a64Hex(stableStringify({ preset: { engineId, voiceId, mode, settings, libraryVoiceId }, text }));
}
