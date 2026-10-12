/**
 * The worker for the single-session phoneme models (Kitten, Paradee, Piper),
 * built on the shared worker kit: each model's worker file only says how to
 * load and how to synthesize one chunk, and this module supplies chunk
 * planning, over-long chunk splitting, tuning, word timings and AUDIO_CHUNK
 * emission. Protocol rules (serialized loads, superseded generations posting
 * nothing, soft ABORT, CANCEL closing the worker) come from createWorkerRuntime.
 */
import type { ChunkPauseKind, InferenceBackend } from "../../types";
import type { TextChunk } from "../../lib/chunking";
import { ChunkTooLongError } from "../../lib/styleTtsRuntime";
import { resolveSentenceSpeed, tuneChunkText } from "../../lib/textTuning";
import { emitAudioChunk, resolveChunkPauseSec, type WordTiming } from "./emit";
import type { GenerationTicket } from "./generation";
import { createLoadProgress, type LoadProgress } from "./progress";
import { generationMeta } from "./protocol";
import { createWorkerRuntime, type GenerateMessage, type WorkerRuntime, type WorkerRuntimeOptions } from "./runtime";

export interface PhonemeChunkAudio {
  audio: Float32Array;
  /** Offsets relative to the synthesized chunk text. */
  wordTimings?: WordTiming[];
}

export interface LoadedPhonemeModel {
  backend: InferenceBackend;
  voices: string[];
  sampleRate: number;
  planChunks(text: string): TextChunk[];
  /** Throws ChunkTooLongError, before any inference, when the text needs too many tokens. */
  synthesize(text: string, voice: string, speed: number): Promise<PhonemeChunkAudio>;
  dispose(): Promise<void>;
}

export interface PhonemeEngine {
  /** Used in error messages, such as "Kitten TTS". */
  label: string;
  /** Pinned byte sizes of every file a cold load downloads, keyed like `progress.update`. */
  expectedBytes: Readonly<Record<string, number>>;
  /** Download (or read from cache), create the session and warm it up. */
  load(progress: LoadProgress): Promise<LoadedPhonemeModel>;
  /** Drop the model's downloaded files (LOAD with forceReload). */
  clearCache(): Promise<void>;
}

interface QueuedChunk {
  text: string;
  start: number;
  end: number;
  pauseAfterSec: number;
  pauseKind: ChunkPauseKind;
}

const SPLIT_PAUSE_SEC = 0.14;

/**
 * Split an over-long chunk near its middle, at a clause mark when one is close
 * and otherwise at whitespace, so both halves keep exact source offsets.
 */
export function splitChunkInHalf(source: string, chunk: QueuedChunk): [QueuedChunk, QueuedChunk] | null {
  const text = source.slice(chunk.start, chunk.end);
  const middle = Math.floor(text.length / 2);
  let cut = -1;
  let bestDistance = Infinity;
  for (let index = 1; index < text.length; index += 1) {
    if (!/\s/.test(text[index])) continue;
    const clause = /[,;:—]/.test(text[index - 1]);
    const distance = Math.abs(index - middle) * (clause ? 0.5 : 1);
    if (distance < bestDistance) {
      bestDistance = distance;
      cut = index;
    }
  }
  if (cut < 0) return null;
  const leftEnd = chunk.start + text.slice(0, cut).trimEnd().length;
  const rightStart = chunk.start + cut + (text.slice(cut).length - text.slice(cut).trimStart().length);
  if (leftEnd <= chunk.start || rightStart >= chunk.end) return null;
  return [
    { text: source.slice(chunk.start, leftEnd), start: chunk.start, end: leftEnd, pauseAfterSec: SPLIT_PAUSE_SEC, pauseKind: "comma" },
    { text: source.slice(rightStart, chunk.end), start: rightStart, end: chunk.end, pauseAfterSec: chunk.pauseAfterSec, pauseKind: chunk.pauseKind },
  ];
}


/** Downloads and session creation fill the bar up to here; READY completes it. */
const LOAD_PROGRESS_MAX = 99;

export function startPhonemeWorker(engine: PhonemeEngine, options?: WorkerRuntimeOptions): WorkerRuntime {
  let model: LoadedPhonemeModel | null = null;
  const runtime: WorkerRuntime = createWorkerRuntime({ load, generate }, options);
  const { port, generations } = runtime;

  async function load({ forceReload = false }: { forceReload?: boolean }): Promise<void> {
    if (model && !forceReload) {
      port.post({ type: "READY", voices: [...model.voices], backend: model.backend });
      return;
    }
    // Dropped before the first await, so a GENERATE that arrives during the
    // reload is refused instead of running on a session about to be released.
    const previous = model;
    model = null;
    const progress = createLoadProgress({
      report: (percent) => port.post({ type: "LOAD_PROGRESS", percent }),
      range: [0, LOAD_PROGRESS_MAX],
      expectedBytes: engine.expectedBytes,
    });
    try {
      // The runtime superseded the running generation when this reload
      // arrived; never release the session under its in-flight inference.
      await generations.idle();
      await previous?.dispose().catch(() => undefined);
      if (forceReload) await engine.clearCache();
      progress.reset();
      const loaded = await engine.load(progress);
      model = loaded;
      port.post({ type: "LOAD_PROGRESS", percent: 100 });
      port.post({ type: "READY", voices: [...loaded.voices], backend: loaded.backend });
    } finally {
      progress.close();
    }
  }

  async function generate(message: GenerateMessage, ticket: GenerationTicket): Promise<void> {
    const loaded = model;
    if (!loaded) throw new Error(`${engine.label} is not loaded.`);
    const queue: QueuedChunk[] = loaded.planChunks(message.text);
    if (queue.length === 0) throw new Error("Input text is empty.");

    const pronunciationRules = message.pronunciationRules ?? [];
    const emphasisStrength = message.emphasisStrength ?? 0;
    const variance = message.sentenceSpeedVariance ?? 0;
    let emitted = 0;
    let dynamicTotal = false;
    while (queue.length > 0) {
      if (!ticket.isCurrent()) return;
      const chunk = queue.shift()!;
      const tuned = tuneChunkText(chunk.text, pronunciationRules, emphasisStrength);
      const speed = resolveSentenceSpeed(message.speed, variance, chunk.text);
      let result: PhonemeChunkAudio;
      try {
        result = await loaded.synthesize(tuned, message.voice, speed);
      } catch (error) {
        const halves = error instanceof ChunkTooLongError ? splitChunkInHalf(message.text, chunk) : null;
        if (!halves) throw error;
        queue.unshift(...halves);
        dynamicTotal = true;
        continue;
      }
      if (!ticket.isCurrent()) return;

      emitted += 1;
      // Timings refer to the synthesized text, so they only map back when tuning left it unchanged.
      const wordTimings = tuned === chunk.text && result.wordTimings
        ? result.wordTimings.map((timing) => ({ ...timing, start: chunk.start + timing.start, end: chunk.start + timing.end }))
        : undefined;
      emitAudioChunk(port, {
        generationId: message.generationId,
        audio: result.audio,
        samplingRate: loaded.sampleRate,
        text: chunk.text,
        index: emitted,
        total: dynamicTotal ? 0 : emitted + queue.length,
        textStart: chunk.start,
        textEnd: chunk.end,
        pauseKind: chunk.pauseKind,
        pauseSec: resolveChunkPauseSec({
          hasFollowing: queue.length > 0,
          pauseKind: chunk.pauseKind,
          pauseAfterSec: chunk.pauseAfterSec,
          pauseOverridesSec: message.pauseOverridesSec,
          finalPauseSec: message.finalPauseSec,
        }),
        wordTimings,
      });
    }
    port.post({ type: "GENERATION_COMPLETE", ...generationMeta(message.generationId) });
  }

  return runtime;
}
