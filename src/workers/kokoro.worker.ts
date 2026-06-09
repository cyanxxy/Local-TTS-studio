/**
 * Kokoro TTS Web Worker
 *
 * Runs Kokoro-82M inference off the main thread.
 * Uses kokoro-js (NOT the standard pipeline) because Kokoro
 * requires custom phonemization that kokoro-js handles internally.
 */

import type { KokoroTTS as KokoroTTSInstance } from "kokoro-js";
import type { InferenceBackend, PronunciationRule, WorkerInMessage, WorkerOutMessage } from "../types";
import { KOKORO_FALLBACK_VOICES } from "../constants";
import { concatFloat32Arrays, createSilence } from "../lib/audio";
import { normalizeRawAudioOutput } from "../lib/audioOutput";
import { buildKokoroInferenceUnits, getKokoroMaxInferenceChars } from "../lib/chunking";
import { KOKORO_ONNX_WASM_ASSETS } from "../lib/onnxWasmAssets";
import { configureKokoroOnnxRuntime } from "../lib/onnxRuntime";
import { resolvePauseSeconds, resolveSentenceSpeed, tuneChunkText } from "../lib/textTuning";
import { resolveKokoroVoice } from "../lib/voices";
import { canInitializeWebGPU } from "../lib/webgpu";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
type KokoroDtype = "fp32" | "fp16" | "q8";

const BACKEND_CONFIG: ReadonlyArray<{ backend: InferenceBackend; dtype: KokoroDtype }> = [
  { backend: "webgpu", dtype: "fp32" },
  { backend: "wasm", dtype: "q8" },
];
const KOKORO_LOAD_TIMEOUT_MS = 120_000;
const SPEED_MIN_SAFE = 0.85;
const SPEED_MAX_SAFE = 1.15;

type KokoroModule = typeof import("kokoro-js");

let tts: KokoroTTSInstance | null = null;
let voices: string[] = [];
let activeBackend: InferenceBackend | null = null;
let kokoroModulePromise: Promise<KokoroModule> | null = null;
let activeGenerationEpoch = 0;

interface KokoroChunkUnit {
  text: string;
  start?: number;
  end?: number;
  pauseAfterSec: number;
  pauseKind: "none" | "sentence" | "comma";
  depth: number;
}

function beginGeneration(): number {
  activeGenerationEpoch += 1;
  return activeGenerationEpoch;
}

function invalidateActiveGeneration(): void {
  activeGenerationEpoch += 1;
}

function isGenerationCurrent(generationEpoch: number): boolean {
  return activeGenerationEpoch === generationEpoch;
}

async function loadKokoroModule(): Promise<KokoroModule> {
  if (!kokoroModulePromise) {
    kokoroModulePromise = (async () => {
      const module = await import("kokoro-js");
      configureKokoroOnnxRuntime(module.env, KOKORO_ONNX_WASM_ASSETS);
      return module;
    })();
  }
  return kokoroModulePromise;
}

function post(msg: WorkerOutMessage) {
  if (msg.type === "AUDIO_CHUNK") {
    self.postMessage(msg, { transfer: [msg.audio.buffer as ArrayBuffer] });
  } else {
    self.postMessage(msg);
  }
}

function generationMeta(generationId: string | undefined): { generationId?: string } {
  return generationId === undefined ? {} : { generationId };
}

function clampSpeed(speed: number): number {
  return Math.max(SPEED_MIN_SAFE, Math.min(SPEED_MAX_SAFE, speed));
}

function normalizeFinalPauseSec(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(5, value));
}

function listVoices(instance: KokoroTTSInstance): string[] {
  const dynamicVoices = (instance as unknown as { voices?: Record<string, unknown> }).voices;
  if (dynamicVoices && typeof dynamicVoices === "object") {
    const keys = Object.keys(dynamicVoices);
    if (keys.length > 0) return keys;
  }

  const result = instance.list_voices();
  if (Array.isArray(result) && result.length > 0) return result;

  return [...KOKORO_FALLBACK_VOICES];
}

function buildInferenceUnits(text: string): KokoroChunkUnit[] {
  const units = buildKokoroInferenceUnits(text, getKokoroMaxInferenceChars(activeBackend));

  return units.map((unit, index) => ({
    text: unit.text,
    start: unit.start,
    end: unit.end,
    pauseAfterSec: index < units.length - 1 ? 0.2 : 0,
    pauseKind: index < units.length - 1 ? "sentence" : "none",
    depth: 0,
  }));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    promise
      .then((value) => resolve(value))
      .catch((err: unknown) => reject(err))
      .finally(() => clearTimeout(timeoutHandle));
  });
}

async function loadModel(forceReload: boolean = false) {
  if (forceReload) {
    invalidateActiveGeneration();
    tts = null;
    activeBackend = null;
  }

  if (tts && activeBackend) {
    post({ type: "READY", voices, backend: activeBackend });
    return;
  }

  try {
    post({ type: "LOAD_PROGRESS", percent: 0 });
    const { KokoroTTS } = await loadKokoroModule();
    let lastError: unknown = null;

    const progressMap = new Map<string, number>();
    for (const { backend, dtype } of BACKEND_CONFIG) {
      try {
        if (backend === "webgpu" && !(await canInitializeWebGPU())) {
          throw new Error("WebGPU device initialization failed.");
        }
        tts = await withTimeout(
          KokoroTTS.from_pretrained(MODEL_ID, {
            dtype,
            device: backend,
            progress_callback: (info: Record<string, unknown>) => {
              if (
                typeof info.file === "string"
                && info.status === "progress"
                && typeof info.total === "number"
                && info.total > 0
                && typeof info.loaded === "number"
              ) {
                progressMap.set(info.file, info.loaded / info.total);
                const total = Array.from(progressMap.values()).reduce((sum, v) => sum + v, 0);
                post({ type: "LOAD_PROGRESS", percent: (total / progressMap.size) * 100 });
              } else if (typeof info.file === "string" && info.status === "done") {
                progressMap.set(info.file, 1);
                const total = Array.from(progressMap.values()).reduce((sum, v) => sum + v, 0);
                post({ type: "LOAD_PROGRESS", percent: (total / progressMap.size) * 100 });
              }
            },
          }),
          KOKORO_LOAD_TIMEOUT_MS,
          `Kokoro ${backend} load`,
        );
        activeBackend = backend;
        break;
      } catch (err) {
        lastError = err;
        if (backend === "webgpu") {
          progressMap.clear();
          post({ type: "LOAD_PROGRESS", percent: 0 });
        }
      }
    }

    if (!tts || !activeBackend) {
      throw (lastError instanceof Error)
        ? lastError
        : new Error(lastError ? String(lastError) : "Failed to load Kokoro model");
    }

    voices = listVoices(tts);
    post({ type: "READY", voices, backend: activeBackend });
  } catch (err) {
    tts = null;
    activeBackend = null;
    post({ type: "ERROR", message: err instanceof Error ? err.message : String(err), scope: "load" });
  }
}

async function generate(
  generationId: string | undefined,
  text: string,
  voice: string,
  speed: number,
  finalPauseSec?: number,
  pauseOverridesSec?: Partial<Record<"none" | "comma" | "sentence" | "paragraph", number>>,
  sentenceSpeedVariance: number = 0,
  pronunciationRules: PronunciationRule[] = [],
  emphasisStrength: number = 0,
) {
  const ttsInstance = tts;
  if (!ttsInstance) {
    post({ type: "ERROR", message: "Model not loaded yet", scope: "generate", ...generationMeta(generationId) });
    return;
  }

  const generationEpoch = beginGeneration();
  let emitted = 0;

  try {
    const selectedVoice = resolveKokoroVoice(voice, voices);

    if (!selectedVoice) {
      post({ type: "ERROR", message: "No Kokoro voices are available.", scope: "generate", ...generationMeta(generationId) });
      return;
    }

    const normalizedSpeed = clampSpeed(speed);
    const units = buildInferenceUnits(text);
    if (units.length === 0) {
      post({ type: "ERROR", message: "Input text is empty.", scope: "generate", ...generationMeta(generationId) });
      return;
    }

    const splitForRetry = (unit: KokoroChunkUnit): KokoroChunkUnit[] => {
      const source = unit.text;
      if (source.length < 40 || unit.depth >= 2) return [unit];

      const midpoint = Math.floor(source.length / 2);
      let splitAt = -1;

      for (let i = midpoint; i < source.length; i += 1) {
        if (/[,;:!?]/.test(source[i])) {
          splitAt = i + 1;
          break;
        }
        if (splitAt === -1 && /\s/.test(source[i])) {
          splitAt = i + 1;
        }
      }

      if (splitAt === -1) {
        for (let i = midpoint; i > 10; i -= 1) {
          if (/\s/.test(source[i])) {
            splitAt = i + 1;
            break;
          }
        }
      }

      if (splitAt <= 0 || splitAt >= source.length) return [unit];

      const leftText = source.slice(0, splitAt).trim();
      const rightText = source.slice(splitAt).trim();
      if (!leftText || !rightText) return [unit];

      const leftStartLocal = source.indexOf(leftText);
      const rightStartLocal = source.indexOf(rightText, Math.max(splitAt - 2, 0));
      const leftStart = unit.start !== undefined ? unit.start + Math.max(0, leftStartLocal) : undefined;
      const rightStart = unit.start !== undefined ? unit.start + Math.max(0, rightStartLocal) : undefined;

      return [
        {
          text: leftText,
          start: leftStart,
          end: leftStart !== undefined ? leftStart + leftText.length : undefined,
          pauseAfterSec: 0.14,
          pauseKind: "comma",
          depth: unit.depth + 1,
        },
        {
          text: rightText,
          start: rightStart,
          end: rightStart !== undefined ? rightStart + rightText.length : undefined,
          pauseAfterSec: unit.pauseAfterSec,
          pauseKind: unit.pauseKind,
          depth: unit.depth + 1,
        },
      ];
    };

    const queue: KokoroChunkUnit[] = [...units];
    let hadFailure = false;
    let firstFailure: unknown = null;
    let hasDynamicTotal = false;

    while (isGenerationCurrent(generationEpoch) && queue.length > 0) {
      const unit = queue.shift();
      if (!unit || !unit.text.trim()) {
        continue;
      }

      try {
        const tunedText = tuneChunkText(unit.text, pronunciationRules, emphasisStrength);
        const unitSpeed = clampSpeed(resolveSentenceSpeed(normalizedSpeed, sentenceSpeedVariance, tunedText));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- kokoro-js voice type is a strict literal union
        const output = await ttsInstance.generate(tunedText, { voice: selectedVoice as any, speed: unitSpeed });
        if (!isGenerationCurrent(generationEpoch)) return;
        const normalized = normalizeRawAudioOutput(output as unknown as Parameters<typeof normalizeRawAudioOutput>[0]);
        const resolvedPauseSec = resolvePauseSeconds(unit.pauseKind, unit.pauseAfterSec, pauseOverridesSec);
        const currentIndex = emitted + 1;
        const hasFollowing = queue.length > 0;
        const total = hasDynamicTotal ? 0 : currentIndex + queue.length;
        const pauseSec = hasFollowing ? resolvedPauseSec : normalizeFinalPauseSec(finalPauseSec);
        const audio = pauseSec > 0
          ? concatFloat32Arrays([
            normalized.audio,
            createSilence(pauseSec, normalized.samplingRate),
          ])
          : normalized.audio;

        emitted = currentIndex;
        if (!isGenerationCurrent(generationEpoch)) return;
        post({
          type: "AUDIO_CHUNK",
          ...generationMeta(generationId),
          audio,
          samplingRate: normalized.samplingRate,
          text: unit.text,
          index: emitted,
          total,
          textStart: unit.start,
          textEnd: unit.end,
          pauseAfterSec: pauseSec,
          pauseKind: unit.pauseKind,
        });
      } catch (error) {
        const retryUnits = splitForRetry(unit);
        if (retryUnits.length > 1) {
          // Requeue split retries in-order at the front.
          hasDynamicTotal = true;
          queue.unshift(...retryUnits);
          continue;
        }

        hadFailure = true;
        if (firstFailure === null) firstFailure = error;
      }
    }

    if (!isGenerationCurrent(generationEpoch)) return;

    if (hadFailure) {
      const reason = firstFailure instanceof Error ? firstFailure.message : String(firstFailure ?? "unknown error");
      throw new Error(`Generation completed with skipped segments after ${emitted} chunks: ${reason}`);
    }

    if (emitted === 0) {
      throw new Error("Model returned no audio chunks.");
    }

    post({ type: "GENERATION_COMPLETE", ...generationMeta(generationId) });
  } catch (err) {
    if (!isGenerationCurrent(generationEpoch)) return;
    post({ type: "ERROR", message: err instanceof Error ? err.message : String(err), scope: "generate", ...generationMeta(generationId) });
  }
}

self.onmessage = (e: MessageEvent<WorkerInMessage>) => {
  const msg = e.data;
  switch (msg.type) {
    case "LOAD":
      loadModel(msg.forceReload ?? false);
      break;
    case "GENERATE":
      generate(
        msg.generationId,
        msg.text,
        msg.voice,
        msg.speed,
        msg.finalPauseSec,
        msg.pauseOverridesSec,
        msg.sentenceSpeedVariance ?? 0,
        msg.pronunciationRules ?? [],
        msg.emphasisStrength ?? 0,
      );
      break;
    case "CANCEL":
      invalidateActiveGeneration();
      break;
  }
};
