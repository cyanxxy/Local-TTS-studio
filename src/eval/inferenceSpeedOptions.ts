import type { ModelType } from "../types";

const DEFAULT_TEXT = [
  "Local text to speech should feel immediate even when the model is running entirely on device.",
  "This benchmark measures warm model generation throughput through the same worker path used by the app.",
  "It includes several sentences so chunking, batching, and worker transfer costs are visible in the result.",
  "The output is designed for repeatable speed comparisons after runtime changes.",
].join(" ");

export interface ParsedInferenceSpeedOptions {
  model: ModelType | "both";
  iterations: number;
  warmups: number;
  quality: number;
  speed: number;
  timeoutMs: number;
  text: string;
}

function readPositiveNumber(params: URLSearchParams, name: string, fallback: number): number {
  const value = Number(params.get(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readNonNegativeNumber(params: URLSearchParams, name: string, fallback: number): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function parseInferenceSpeedOptions(search: string): ParsedInferenceSpeedOptions {
  const params = new URLSearchParams(search);
  const model = params.get("model");

  return {
    model: model === "kokoro" || model === "supertonic" ? model : "both",
    iterations: Math.max(1, Math.floor(readPositiveNumber(params, "iterations", 3))),
    warmups: Math.floor(readNonNegativeNumber(params, "warmups", 1)),
    quality: Math.max(1, Math.floor(readPositiveNumber(params, "quality", 5))),
    speed: readPositiveNumber(params, "speed", 1),
    timeoutMs: readPositiveNumber(params, "timeoutMs", 15 * 60 * 1000),
    text: params.get("text")?.trim() || DEFAULT_TEXT,
  };
}
