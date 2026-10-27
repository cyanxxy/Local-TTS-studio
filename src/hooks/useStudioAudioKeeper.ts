import { useCallback, useEffect, useRef } from "react";
import type { CachedReaderAudioChunk } from "../lib/readerDocument";
import type { UseAudioPlayerReturn } from "./useAudioPlayer";

interface StudioAudioSnapshot {
  chunks: CachedReaderAudioChunk[];
  currentTime: number;
  playbackRate: number;
  synthesisComplete: boolean;
}

interface Options {
  /** Studio is the page on screen. */
  isStudioPage: boolean;
  player: Pick<
    UseAudioPlayerReturn,
    "getAudioCacheSnapshot" | "getContentEpoch" | "getCurrentTime" | "getPlaybackSnapshot" | "restoreAudioCache"
  >;
  setShowPlayer: (show: boolean) => void;
}

/**
 * Studio and the Reader share one audio player, and the Reader empties it as
 * it enters each section. This keeps Studio's audio across a visit to the
 * Reader: `keep` is called just before the Reader first takes the player and
 * holds what Studio had generated, and returning to Studio puts it back, at
 * the position it was left at (paused).
 *
 * The snapshot holds references to the player's PCM buffers, not copies.
 */
export function useStudioAudioKeeper({ isStudioPage, player, setShowPlayer }: Options) {
  const { getAudioCacheSnapshot, getContentEpoch, getCurrentTime, getPlaybackSnapshot, restoreAudioCache } = player;
  const snapshotRef = useRef<StudioAudioSnapshot | null>(null);
  // Whether the player's contents are the Reader's. Studio owns it until the
  // Reader first takes it over.
  const readerOwnsPlayerRef = useRef(false);
  // The player's content epoch right after the last put-back, while the
  // player still holds exactly that audio.
  const putBackEpochRef = useRef<number | null>(null);

  const keep = useCallback(() => {
    if (readerOwnsPlayerRef.current) return;
    readerOwnsPlayerRef.current = true;
    const chunks = getAudioCacheSnapshot();
    if (chunks.length === 0) {
      snapshotRef.current = null;
      return;
    }
    const playback = getPlaybackSnapshot();
    snapshotRef.current = {
      chunks,
      currentTime: getCurrentTime(),
      playbackRate: playback.playbackRate,
      synthesisComplete: playback.synthesisComplete,
    };
  }, [getAudioCacheSnapshot, getCurrentTime, getPlaybackSnapshot]);

  // Studio's script was replaced while the Reader had the player (an import
  // that finished there), so what was kept no longer speaks it. Returns false
  // when Studio still owns the player: its audio is then the caller's to clear.
  const dropKept = useCallback(() => {
    if (!readerOwnsPlayerRef.current) return false;
    snapshotRef.current = null;
    return true;
  }, []);

  // Put-back audio is Studio's earlier generation, not a new one finishing.
  const isPutBackAudio = useCallback(() => (
    putBackEpochRef.current !== null && putBackEpochRef.current === getContentEpoch()
  ), [getContentEpoch]);

  useEffect(() => {
    if (!isStudioPage || !readerOwnsPlayerRef.current) return;
    readerOwnsPlayerRef.current = false;
    const snapshot = snapshotRef.current;
    snapshotRef.current = null;
    if (!snapshot) return;
    restoreAudioCache(snapshot.chunks, {
      currentTime: snapshot.currentTime,
      playbackRate: snapshot.playbackRate,
      synthesisComplete: snapshot.synthesisComplete,
    });
    putBackEpochRef.current = getContentEpoch();
    setShowPlayer(true);
  }, [getContentEpoch, isStudioPage, restoreAudioCache, setShowPlayer]);

  return { keepStudioAudio: keep, dropKeptStudioAudio: dropKept, isPutBackStudioAudio: isPutBackAudio };
}
