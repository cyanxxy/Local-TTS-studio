import {
  CHATTERBOX_DEFAULT_REFERENCE_ID,
  type ChatterboxWorkerOutMessage,
} from "./chatterboxProtocol";
import {
  ChatterboxReferenceError,
  decodeChatterboxWav,
  digestChatterboxReference,
  prepareChatterboxReference,
} from "./chatterboxReference";
import { chatterboxClipVoice } from "../models/chatterbox";

/**
 * The reference clips Chatterbox can clone, kept in memory for the session.
 *
 * A clip is addressed by the `voice` string in the engine's settings, which is
 * derived from the clip's content, so changing the audio changes the voice and
 * any Reader audio made with it. The clip itself is never persisted here: a
 * voice id whose clip is gone falls back to the default voice.
 *
 * Seam for the Voice Library: it can supply stored clips through
 * `setChatterboxClipResolver` and the engine settings keep naming them by the
 * same id; nothing else in the engine path needs to change.
 */
export interface ChatterboxClip {
  /** The engine `voice` value. */
  id: string;
  name: string;
  /** What the worker will keep of the clip (at most 10 s). */
  durationSec: number;
  /** Mono PCM as decoded; the worker resamples, trims and normalises it. */
  audio: Float32Array;
  samplingRate: number;
}

export type ChatterboxClipResolver = (id: string) => ChatterboxClip | undefined;

const clips = new Map<string, ChatterboxClip>();
const listeners = new Set<() => void>();
let snapshot: readonly ChatterboxClip[] = [];
let resolver: ChatterboxClipResolver | null = null;

function publish(): void {
  snapshot = [...clips.values()];
  for (const listener of [...listeners]) listener();
}

export function subscribeChatterboxClips(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getChatterboxClips(): readonly ChatterboxClip[] {
  return snapshot;
}

export function getChatterboxClip(id: string): ChatterboxClip | undefined {
  return clips.get(id) ?? resolver?.(id);
}

/** Lets another store (the Voice Library) provide clips by voice id. Pass null to detach. */
export function setChatterboxClipResolver(next: ChatterboxClipResolver | null): void {
  resolver = next;
}

export function removeChatterboxClip(id: string): void {
  if (clips.delete(id)) publish();
}

/**
 * Reads a WAV file as a reference voice. Rejects with a message fit for the UI
 * when the file is not a readable WAV or the clip is too short, too quiet or
 * too long to clone from.
 */
export async function addChatterboxClipFromWav(buffer: ArrayBuffer, name: string): Promise<ChatterboxClip> {
  let decoded: ReturnType<typeof decodeChatterboxWav>;
  try {
    decoded = decodeChatterboxWav(buffer);
  } catch {
    throw new ChatterboxReferenceError("That file is not a WAV recording this app can read.");
  }
  // Prepared here only to validate; the worker prepares the clip again from the original.
  const prepared = prepareChatterboxReference(decoded.audio, decoded.samplingRate);
  const digest = await digestChatterboxReference(prepared.audio);
  const clip: ChatterboxClip = {
    id: chatterboxClipVoice(digest.slice(0, 16), name),
    name,
    durationSec: prepared.durationSec,
    audio: decoded.audio,
    samplingRate: decoded.samplingRate,
  };
  clips.set(clip.id, clip);
  publish();
  return clip;
}

const sentToWorker = new WeakMap<Worker, Map<string, Promise<void>>>();

/**
 * Makes `referenceId` known to `worker`, sending the clip once per worker and
 * waiting until the worker has accepted it. The default voice needs nothing.
 */
export function ensureChatterboxReference(worker: Worker, referenceId: string): Promise<void> {
  if (referenceId === CHATTERBOX_DEFAULT_REFERENCE_ID) return Promise.resolve();
  const known = sentToWorker.get(worker) ?? new Map<string, Promise<void>>();
  sentToWorker.set(worker, known);
  const pending = known.get(referenceId);
  if (pending) return pending;

  const clip = getChatterboxClip(referenceId);
  if (!clip) {
    return Promise.reject(new Error("This cloned voice is no longer loaded. Choose its WAV file again."));
  }
  const request = new Promise<void>((resolve, reject) => {
    const settle = (finish: () => void) => {
      worker.removeEventListener("message", onMessage as EventListener);
      worker.removeEventListener("error", onError);
      finish();
    };
    const onMessage = (event: MessageEvent<ChatterboxWorkerOutMessage>) => {
      const message = event.data;
      if (message.type === "REFERENCE_READY" && message.referenceId === referenceId) {
        settle(resolve);
      } else if (message.type === "ERROR" && message.scope === "reference" && message.referenceId === referenceId) {
        settle(() => reject(new Error(message.message)));
      }
    };
    const onError = () => settle(() => reject(new Error("Chatterbox stopped while loading the voice clip.")));
    worker.addEventListener("message", onMessage as EventListener);
    worker.addEventListener("error", onError);
    // A copy: the transfer empties it, and the clip must stay for a replacement worker.
    const audio = clip.audio.slice();
    worker.postMessage(
      { type: "SET_REFERENCE", referenceId, audio, samplingRate: clip.samplingRate },
      { transfer: [audio.buffer] },
    );
  });
  known.set(referenceId, request);
  // A failed attempt may be retried, for example after the worker restarts.
  request.catch(() => known.delete(referenceId));
  return request;
}
