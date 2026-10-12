import { setChatterboxClipResolver, type ChatterboxClip } from "../chatterboxClips";
import {
  CHATTERBOX_SAMPLE_RATE,
  decodeChatterboxWav,
  digestChatterboxReference,
  prepareChatterboxReference,
} from "../chatterboxReference";
import { chatterboxClipVoice } from "../../models/chatterbox";
import type { VoiceLibraryStore } from "./store";
import type { VoiceRecord } from "./types";

/**
 * Chatterbox clones saved in the Voice Library, handed to the engine through
 * its clip resolver. A clip is prepared once (24 kHz, trimmed, normalized) and
 * kept in memory; the engine names it by the same content-derived voice id
 * whether it came from a file or the library.
 */

const clips = new Map<string, ChatterboxClip>();
/** `<record id>:<reference sha256>` to the clip id, so an unchanged voice is prepared once. */
const clipIds = new Map<string, string>();
const pending = new Map<string, Promise<ChatterboxClip>>();

type ClipSource = Pick<VoiceLibraryStore, "getVoiceAudio">;

function isChatterboxClone(record: VoiceRecord): record is Extract<VoiceRecord, { kind: "cloned" }> {
  return record.kind === "cloned" && record.targets.includes("chatterbox");
}

/** The engine clip for a saved Chatterbox clone, preparing and registering it on first use. */
export function chatterboxClipForVoice(source: ClipSource, record: VoiceRecord): Promise<ChatterboxClip> {
  if (!isChatterboxClone(record)) return Promise.reject(new Error("This voice is not a Chatterbox clone."));
  const key = `${record.id}:${record.reference.sha256}`;
  const known = clipIds.get(key);
  const cached = known ? clips.get(known) : undefined;
  if (cached) return Promise.resolve(cached);
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const work = (async () => {
    const wav = await source.getVoiceAudio(record.id, "reference");
    if (!wav) throw new Error("The reference clip for this voice is missing from the library.");
    const buffer = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
    const decoded = decodeChatterboxWav(buffer);
    const prepared = prepareChatterboxReference(decoded.audio, decoded.samplingRate);
    const digest = await digestChatterboxReference(prepared.audio);
    const clip: ChatterboxClip = {
      id: chatterboxClipVoice(digest.slice(0, 16), record.name),
      name: record.name,
      durationSec: prepared.durationSec,
      audio: prepared.audio,
      samplingRate: CHATTERBOX_SAMPLE_RATE,
    };
    clips.set(clip.id, clip);
    clipIds.set(key, clip.id);
    return clip;
  })().finally(() => pending.delete(key));
  pending.set(key, work);
  return work;
}

/**
 * Registers every saved Chatterbox clone with the engine and keeps doing so as
 * the library changes, so a voice saved in an earlier session still resolves.
 * Returns a function that detaches the resolver.
 */
export function attachLibraryChatterboxClips(store: Pick<VoiceLibraryStore, "listVoices" | "getVoiceAudio" | "subscribe">): () => void {
  let active = true;
  setChatterboxClipResolver((id) => clips.get(id));
  const load = async () => {
    try {
      for (const record of await store.listVoices()) {
        if (!active) return;
        if (!isChatterboxClone(record)) continue;
        // One unreadable clip must not hide the rest.
        await chatterboxClipForVoice(store, record).catch(() => undefined);
      }
    } catch {
      // The library may be unavailable; clones then fall back to the default voice.
    }
  };
  void load();
  const unsubscribe = store.subscribe(() => { void load(); });
  return () => {
    active = false;
    unsubscribe();
    setChatterboxClipResolver(null);
  };
}

/** Test seam. */
export function resetLibraryChatterboxClips(): void {
  clips.clear();
  clipIds.clear();
  pending.clear();
}
