import { createAbortError, createAsyncChannel } from "../shared/asyncChannel";
import type { SynthesisChunk } from "../shared/engineRuntime";
import type { GenerationTuningSettings, WorkerInMessage, WorkerOutMessage } from "../types";

/** A GENERATE request without the routing fields this module fills in. */
export type WorkerGenerateRequest = Omit<Extract<WorkerInMessage, { type: "GENERATE" }>, "type" | "generationId">;
export type WorkerAudioChunk = Extract<WorkerOutMessage, { type: "AUDIO_CHUNK" }>;

export interface WorkerGenerationObserver {
  onChunk: (chunk: WorkerAudioChunk) => void;
  onComplete: () => void;
  onError: (message: string) => void;
}

export function workerEventMessage(event: Event, fallback: string): string {
  if (event instanceof ErrorEvent && event.message) return event.message;
  if (event.type === "messageerror") return `${fallback} The worker sent an unreadable message.`;
  return fallback;
}

/** The worker GENERATE fields for `text` spoken with `voice` and the Creator tuning. */
export function workerGenerateRequest(
  text: string,
  voice: string,
  tuning: GenerationTuningSettings,
): WorkerGenerateRequest {
  return {
    text,
    voice,
    language: tuning.language,
    speed: tuning.speed,
    quality: tuning.quality,
    pauseOverridesSec: tuning.pauseOverridesSec,
    sentenceSpeedVariance: tuning.sentenceSpeedVariance,
    pronunciationRules: tuning.pronunciationRules,
    emphasisStrength: tuning.emphasisStrength,
  };
}

/**
 * Posts one GENERATE to a synthesis worker and routes the worker's replies for
 * it to `observer`. Replies tagged with another generation are ignored, so this
 * can listen beside the surface generation's own listener.
 *
 * Every terminal reply (completion, a generation error, a worker crash) detaches
 * the listeners before the observer hears it. Returns `detach`, which stops
 * listening without telling the worker anything.
 */
export function observeWorkerGeneration(
  worker: Worker,
  generationId: string,
  request: WorkerGenerateRequest,
  observer: WorkerGenerationObserver,
  failureMessage: string,
): () => void {
  let attached = true;
  const detach = () => {
    if (!attached) return;
    attached = false;
    worker.removeEventListener("message", handleMessage as EventListener);
    worker.removeEventListener("error", handleWorkerError);
    worker.removeEventListener("messageerror", handleWorkerError);
  };
  const fail = (message: string) => {
    detach();
    observer.onError(message);
  };
  function handleMessage(event: MessageEvent<WorkerOutMessage>) {
    const message = event.data;
    if ("generationId" in message && message.generationId !== undefined && message.generationId !== generationId) {
      return;
    }
    switch (message.type) {
      case "AUDIO_CHUNK":
        observer.onChunk(message);
        break;
      case "GENERATION_COMPLETE":
        detach();
        observer.onComplete();
        break;
      case "ERROR":
        fail(message.message);
        break;
    }
  }
  function handleWorkerError(event: Event) {
    fail(workerEventMessage(event, failureMessage));
  }

  worker.addEventListener("message", handleMessage as EventListener);
  worker.addEventListener("error", handleWorkerError);
  worker.addEventListener("messageerror", handleWorkerError);
  try {
    worker.postMessage({ type: "GENERATE", generationId, ...request } satisfies WorkerInMessage);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  return detach;
}

/**
 * How long a soft ABORT may go unanswered. A worker normally answers as soon
 * as its in-flight inference returns; one that never does is stuck (a GPU
 * call that does not come back) and is replaced instead.
 */
export const WORKER_ABORT_TIMEOUT_MS = 5_000;

/**
 * Stops `generationId` on `worker` without closing it or unloading its model,
 * so the next GENERATE starts without a reload. The worker answers with
 * ABORTED once the generation has settled.
 *
 * `onUnresponsive` runs when no ABORTED arrives within `timeoutMs`, or when
 * the worker refuses the message: the caller then replaces the worker. It
 * does not run when the worker crashes meanwhile, because whoever owns the
 * worker already hears that. Callers should check that the worker is still
 * the one they use before replacing it, since it may have been replaced since.
 */
export function abortWorkerGeneration(
  worker: Worker,
  generationId: string,
  onUnresponsive: () => void,
  timeoutMs = WORKER_ABORT_TIMEOUT_MS,
): void {
  const timer = setTimeout(() => {
    stopWatching();
    onUnresponsive();
  }, timeoutMs);
  function stopWatching() {
    clearTimeout(timer);
    worker.removeEventListener("message", handleMessage as EventListener);
    worker.removeEventListener("error", stopWatching);
    worker.removeEventListener("messageerror", stopWatching);
  }
  function handleMessage(event: MessageEvent<WorkerOutMessage>) {
    const message = event.data;
    if (message.type === "ABORTED" && message.generationId === generationId) stopWatching();
  }

  worker.addEventListener("message", handleMessage as EventListener);
  worker.addEventListener("error", stopWatching);
  worker.addEventListener("messageerror", stopWatching);
  try {
    worker.postMessage({ type: "ABORT", generationId } satisfies WorkerInMessage);
  } catch {
    stopWatching();
    onUnresponsive();
  }
}

interface StreamWorkerGenerationOptions {
  worker: Worker;
  generationId: string;
  request: WorkerGenerateRequest;
  signal: AbortSignal;
  /** Aborts when the worker is terminated or replaced; the request then fails. */
  lifetime: AbortSignal;
  /**
   * Runs when the worker does not answer the soft ABORT sent after `signal`
   * aborts (or the consumer stops reading). The caller replaces the worker,
   * unless something else has already done so.
   */
  onUnresponsive: () => void;
  /** Used when a worker crash gives no reason of its own. */
  failureMessage: string;
  /** The error when the worker goes away mid-request. */
  stoppedMessage: string;
}

/** `observeWorkerGeneration` as an abortable audio stream. */
export function streamWorkerGeneration({
  worker,
  generationId,
  request,
  signal,
  lifetime,
  onUnresponsive,
  failureMessage,
  stoppedMessage,
}: StreamWorkerGenerationOptions): AsyncIterable<SynthesisChunk> {
  let finished = false;
  let detachWorker = () => undefined as void;
  const finish = () => {
    finished = true;
    detachWorker();
    signal.removeEventListener("abort", onAbort);
    lifetime.removeEventListener("abort", onRetired);
  };
  const stopWorker = () => {
    if (finished) return;
    finish();
    abortWorkerGeneration(worker, generationId, onUnresponsive);
  };
  const channel = createAsyncChannel<SynthesisChunk>({ onReturn: stopWorker });
  function onAbort() {
    stopWorker();
    channel.fail(signal.reason ?? createAbortError());
  }
  function onRetired() {
    finish();
    channel.fail(new Error(stoppedMessage));
  }

  if (signal.aborted) {
    channel.fail(signal.reason);
    return channel;
  }
  if (lifetime.aborted) {
    channel.fail(new Error(stoppedMessage));
    return channel;
  }
  signal.addEventListener("abort", onAbort, { once: true });
  lifetime.addEventListener("abort", onRetired, { once: true });
  detachWorker = observeWorkerGeneration(worker, generationId, request, {
    onChunk: (chunk) => channel.push({
      audio: chunk.audio,
      samplingRate: chunk.samplingRate,
      text: chunk.text,
      index: chunk.index,
      total: chunk.total,
      textStart: chunk.textStart,
      textEnd: chunk.textEnd,
      pauseAfterSec: chunk.pauseAfterSec,
      pauseKind: chunk.pauseKind,
    }),
    onComplete: () => {
      finish();
      channel.close();
    },
    onError: (message) => {
      finish();
      channel.fail(new Error(message));
    },
  }, failureMessage);
  return channel;
}
