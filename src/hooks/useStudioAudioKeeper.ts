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
    "getAudioCacheSnapshot" | "getCurrentTime" | "getPlaybackSnapshot" | "restoreAudioCache"
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
  const { getAudioCacheSnapshot, getCurrentTime, getPlaybackSnapshot, restoreAudioCache } = player;
  const snapshotRef = useRef<StudioAudioSnapshot | null>(null);
  // Whether the player's contents are the Reader's. Studio owns it until the
  // Reader first takes it over.
  const readerOwnsPlayerRef = useRef(false);

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
    setShowPlayer(true);
  }, [isStudioPage, restoreAudioCache, setShowPlayer]);

  return { keepStudioAudio: keep };
}
