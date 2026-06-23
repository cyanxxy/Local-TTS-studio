import type { ChunkPauseKind, PronunciationRule } from "../types";
import { SPEED_MAX, SPEED_MIN } from "../constants";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeEmphasisMarkers(text: string): string {
  return text
    .replace(/\[\[([^[\]]+)\]\]/g, "*$1*")
    .replace(/\*\*([^*]+)\*\*/g, "*$1*");
}

function applySingleRule(text: string, rule: PronunciationRule): string {
  const from = rule.from.trim();
  const to = rule.to.trim();
  if (!from || !to) return text;

  const escaped = escapeRegExp(from);
  const alnumBoundary = /^[A-Za-z0-9]/.test(from) && /[A-Za-z0-9]$/.test(from);
  const source = alnumBoundary ? `\\b${escaped}\\b` : escaped;
  return text.replace(new RegExp(source, "gi"), () => to);
}

export function applyPronunciationRules(text: string, rules: PronunciationRule[]): string {
  if (rules.length === 0) return text;

  const ordered = [...rules]
    .filter((rule) => rule.from.trim().length > 0 && rule.to.trim().length > 0)
    .sort((a, b) => b.from.length - a.from.length);

  return ordered.reduce((acc, rule) => applySingleRule(acc, rule), text);
}

export function applyEmphasisMarkup(text: string, emphasisStrength: number): string {
  const normalized = normalizeEmphasisMarkers(text);
  const cleanedStrength = clamp(emphasisStrength, 0, 1);

  const stripped = normalized.replace(/\*([^*]+)\*/g, "$1");
  if (cleanedStrength <= 0) return stripped;

  const repeatCount = cleanedStrength >= 0.66 ? 2 : 1;
  return normalized.replace(/\*([^*]+)\*/g, (_match, inner: string) => {
    const spoken = inner.trim();
    if (!spoken) return "";
    return Array.from({ length: repeatCount + 1 }, () => spoken).join(", ");
  });
}

export function tuneChunkText(
  text: string,
  pronunciationRules: PronunciationRule[],
  emphasisStrength: number,
): string {
  const withPronunciation = applyPronunciationRules(text, pronunciationRules);
  return applyEmphasisMarkup(withPronunciation, emphasisStrength);
}

export function resolvePauseSeconds(
  pauseKind: ChunkPauseKind,
  defaultPauseSec: number,
  overrides?: Partial<Record<ChunkPauseKind, number>>,
): number {
  if (overrides && typeof overrides[pauseKind] === "number" && Number.isFinite(overrides[pauseKind])) {
    return clamp(overrides[pauseKind] ?? 0, 0, 2);
  }
  return clamp(defaultPauseSec, 0, 2);
}

export function resolveSentenceSpeed(
  baseSpeed: number,
  sentenceSpeedVariance: number,
  text: string,
): number {
  const normalizedBaseSpeed = clamp(baseSpeed, SPEED_MIN, SPEED_MAX);
  const variance = clamp(sentenceSpeedVariance, 0, 0.5);
  if (variance <= 0) return normalizedBaseSpeed;

  const words = text.trim().length > 0 ? text.trim().split(/\s+/).length : 0;
  if (words === 0) return normalizedBaseSpeed;

  if (words <= 6) return clamp(normalizedBaseSpeed * (1 + variance), SPEED_MIN, SPEED_MAX);
  if (words >= 24) return clamp(normalizedBaseSpeed * (1 - variance), SPEED_MIN, SPEED_MAX);

  // Smooth interpolation from short to long sentence behavior.
  const t = (words - 6) / (24 - 6);
  const multiplier = (1 + variance) * (1 - t) + (1 - variance) * t;
  return clamp(normalizedBaseSpeed * multiplier, SPEED_MIN, SPEED_MAX);
}
