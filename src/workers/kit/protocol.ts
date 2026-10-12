/**
 * Message plumbing shared by the browser TTS workers. Every worker posts
 * through a port so AUDIO_CHUNK transfer rules and ERROR scoping are applied
 * the same way everywhere.
 */
import type { WorkerErrorScope, WorkerOutMessage } from "../../types";

/** The part of a worker's global scope the port posts through. */
export interface WorkerPostTarget {
  postMessage(message: unknown, options?: StructuredSerializeOptions): void;
}

export interface WorkerPort {
  post(message: WorkerOutMessage): void;
  /**
   * Posts an ERROR. Load errors never carry a generation id; generate errors
   * echo the id so hosts can drop errors from generations they abandoned.
   */
  postError(scope: WorkerErrorScope, error: unknown, generationId?: string): void;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Spreads into a message: the id when there is one, nothing otherwise. */
export function generationMeta(generationId: string | undefined): { generationId?: string } {
  return generationId === undefined ? {} : { generationId };
}

function isSharedBuffer(buffer: ArrayBufferLike): boolean {
  return typeof SharedArrayBuffer !== "undefined" && buffer instanceof SharedArrayBuffer;
}

/**
 * PCM that is safe to transfer. Transferring detaches the whole underlying
 * buffer, so a Float32Array is transferred as is only when it owns all of a
 * non-shared buffer; a view into a larger or shared buffer is copied first.
 */
export function transferablePcm(audio: Float32Array): Float32Array {
  const ownsWholeBuffer = !isSharedBuffer(audio.buffer)
    && audio.byteOffset === 0
    && audio.byteLength === audio.buffer.byteLength;
  return ownsWholeBuffer ? audio : audio.slice();
}

export function createWorkerPort(target: WorkerPostTarget = self): WorkerPort {
  const post = (message: WorkerOutMessage): void => {
    if (message.type !== "AUDIO_CHUNK") {
      target.postMessage(message);
      return;
    }
    const audio = transferablePcm(message.audio);
    target.postMessage(
      audio === message.audio ? message : { ...message, audio },
      { transfer: [audio.buffer as ArrayBuffer] },
    );
  };

  return {
    post,
    postError(scope, error, generationId) {
      post({
        type: "ERROR",
        message: errorMessage(error),
        scope,
        ...(scope === "generate" ? generationMeta(generationId) : {}),
      });
    },
  };
}
