/**
 * The worker protocol (LOAD / GENERATE / CANCEL in; LOAD_PROGRESS, READY,
 * AUDIO_CHUNK, GENERATION_COMPLETE, CANCELLED and ERROR out) for the
 * single-session phoneme models, so each model's worker file only says how to
 * load and how to synthesize one chunk. Behaviour matches supertonic3.worker.ts:
 * serialized loads, epoch-based invalidation, CANCEL closes the worker, pauses
 * are rendered into the PCM, and generate errors never change model state.
 * As in the shared worker kit (src/workers/kit/runtime.ts), a superseded
 * generation posts nothing more, not even its error.
 * Unlike the older workers, inference calls are also serialized, so a GENERATE
 * that replaces a running one never overlaps session.run, and a reload waits
 * for the run in flight before releasing the session.
 */
import type { ChunkPauseKind, InferenceBackend, WorkerInMessage } from "../types";
import { concatFloat32Arrays, createSilence } from "./audio";
import type { TextChunk } from "./chunking";
import { resolvePauseSeconds, resolveSentenceSpeed, tuneChunkText } from "./textTuning";
import { ChunkTooLongError, type StyleTtsOutMessage, type WordTiming } from "./styleTtsRuntime";

type GenerateMessage = Extract<WorkerInMessage, { type: "GENERATE" }>;

export interface StyleTtsChunkAudio {
  audio: Float32Array;
  /** Offsets relative to the synthesized chunk text. */
  wordTimings?: WordTiming[];
}

export interface LoadedStyleTtsModel {
  backend: InferenceBackend;
  voices: string[];
  sampleRate: number;
  planChunks(text: string): TextChunk[];
  /** Throws ChunkTooLongError, before any inference, when the text needs too many tokens. */
  synthesize(text: string, voice: string, speed: number): Promise<StyleTtsChunkAudio>;
  dispose(): Promise<void>;
}

export interface StyleTtsEngine {
  /** Used in error messages, such as "Kitten TTS". */
  label: string;
  /** Download (or read from cache), create the session and warm it up. */
  load(onProgress: (fraction: number) => void): Promise<LoadedStyleTtsModel>;
  /** Drop the model's downloaded files (LOAD with forceReload). */
  clearCache(): Promise<void>;
}

export interface StyleTtsWorkerScope {
  onmessage: ((event: MessageEvent<WorkerInMessage>) => void) | null;
  postMessage(message: unknown, options?: StructuredSerializeOptions): void;
  close(): void;
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

function finalPauseSeconds(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(5, value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function startStyleTtsWorker(engine: StyleTtsEngine, scope: StyleTtsWorkerScope): void {
  let model: LoadedStyleTtsModel | null = null;
  let activeGenerationEpoch = 0;
  let loadQueue: Promise<void> = Promise.resolve();
  let activeGenerationTask: Promise<void> | null = null;
  let synthesisQueue: Promise<unknown> = Promise.resolve();

  function runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = synthesisQueue.catch(() => undefined).then(task);
    synthesisQueue = run;
    return run;
  }

  function post(message: StyleTtsOutMessage): void {
    if (message.type === "AUDIO_CHUNK") {
      scope.postMessage(message, { transfer: [message.audio.buffer as ArrayBuffer] });
    } else {
      scope.postMessage(message);
    }
  }

  async function loadModel(forceReload: boolean): Promise<void> {
    if (model && !forceReload) {
      post({ type: "READY", voices: [...model.voices], backend: model.backend });
      return;
    }
    activeGenerationEpoch += 1;
    if (activeGenerationTask) await activeGenerationTask.catch(() => undefined);
    await synthesisQueue.catch(() => undefined);
    const previous = model;
    model = null;
    await previous?.dispose().catch(() => undefined);
    if (forceReload) await engine.clearCache();

    post({ type: "LOAD_PROGRESS", percent: 0 });
    let lastPercent = 0;
    const loaded = await engine.load((fraction) => {
      const percent = Math.max(0, Math.min(99, fraction * 100));
      if (Math.abs(percent - lastPercent) < 0.5 && percent !== 0) return;
      lastPercent = percent;
      post({ type: "LOAD_PROGRESS", percent });
    });
    model = loaded;
    post({ type: "LOAD_PROGRESS", percent: 100 });
    post({ type: "READY", voices: [...loaded.voices], backend: loaded.backend });
  }

  function enqueueModelLoad(forceReload: boolean): Promise<void> {
    const request = loadQueue.catch(() => undefined).then(() => loadModel(forceReload));
    loadQueue = request;
    return request;
  }

  async function generate(message: GenerateMessage, epoch: number): Promise<void> {
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
      if (epoch !== activeGenerationEpoch) return;
      const chunk = queue.shift()!;
      const tuned = tuneChunkText(chunk.text, pronunciationRules, emphasisStrength);
      const speed = resolveSentenceSpeed(message.speed, variance, chunk.text);
      let result: StyleTtsChunkAudio | null;
      try {
        result = await runExclusive(() => (
          epoch === activeGenerationEpoch ? loaded.synthesize(tuned, message.voice, speed) : Promise.resolve(null)
        ));
      } catch (error) {
        const halves = error instanceof ChunkTooLongError ? splitChunkInHalf(message.text, chunk) : null;
        if (!halves) throw error;
        queue.unshift(...halves);
        dynamicTotal = true;
        continue;
      }
      if (!result || epoch !== activeGenerationEpoch) return;

      const pauseSec = queue.length === 0
        ? finalPauseSeconds(message.finalPauseSec)
        : resolvePauseSeconds(chunk.pauseKind, chunk.pauseAfterSec, message.pauseOverridesSec);
      emitted += 1;
      // Timings refer to the synthesized text, so they only map back when tuning left it unchanged.
      const wordTimings = tuned === chunk.text && result.wordTimings
        ? result.wordTimings.map((timing) => ({ ...timing, start: chunk.start + timing.start, end: chunk.start + timing.end }))
        : undefined;
      post({
        type: "AUDIO_CHUNK",
        generationId: message.generationId,
        audio: pauseSec > 0 ? concatFloat32Arrays([result.audio, createSilence(pauseSec, loaded.sampleRate)]) : result.audio,
        samplingRate: loaded.sampleRate,
        text: chunk.text,
        index: emitted,
        total: dynamicTotal ? 0 : emitted + queue.length,
        textStart: chunk.start,
        textEnd: chunk.end,
        pauseAfterSec: pauseSec,
        pauseKind: chunk.pauseKind,
        ...(wordTimings ? { wordTimings } : {}),
      });
    }
    if (epoch === activeGenerationEpoch) {
      post({ type: "GENERATION_COMPLETE", generationId: message.generationId });
    }
  }

  scope.onmessage = (event) => {
    const message = event.data;
    if (message.type === "CANCEL") {
      activeGenerationEpoch += 1;
      post({ type: "CANCELLED" });
      scope.close();
      return;
    }
    if (message.type === "LOAD") {
      void enqueueModelLoad(Boolean(message.forceReload)).catch((error: unknown) => {
        post({ type: "ERROR", scope: "load", message: errorMessage(error) });
      });
      return;
    }
    if (message.type === "GENERATE") {
      // Supersedes the running generation at once; its loop stops at its next epoch check.
      const epoch = ++activeGenerationEpoch;
      const task = generate(message, epoch);
      activeGenerationTask = task;
      void task
        .catch((error: unknown) => {
          // A superseded generation posts nothing more, not even its error.
          if (epoch !== activeGenerationEpoch) return;
          post({ type: "ERROR", scope: "generate", generationId: message.generationId, message: errorMessage(error) });
        })
        .finally(() => {
          if (activeGenerationTask === task) activeGenerationTask = null;
        });
    }
  };
}
