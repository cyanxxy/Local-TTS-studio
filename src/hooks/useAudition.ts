import { useCallback, useEffect, useRef, useState } from "react";
import { toStandaloneArrayBuffer } from "../lib/wavCodec";

/** The slice of HTMLAudioElement an audition needs; tests pass fakes. */
export interface AuditionAudio {
  play: () => Promise<unknown> | void;
  pause: () => void;
  onended: ((event: Event) => void) | null;
  onerror: ((event: Event | string) => void) | null;
}

export type CreateAuditionAudio = (url: string) => AuditionAudio;

const createBrowserAudio: CreateAuditionAudio = (url) => new Audio(url);

export interface UseAuditionReturn {
  /** The key of the clip that is playing, or null. */
  playingKey: string | null;
  /** Play WAV bytes under `key`, stopping whatever played before. Resolves when playback starts. */
  play: (key: string, wav: Uint8Array) => Promise<void>;
  stop: () => void;
}

/**
 * Plays short WAV clips (voice previews) one at a time, apart from the main
 * player, and releases each clip's object URL when it ends or is replaced.
 */
export function useAudition(createAudio: CreateAuditionAudio = createBrowserAudio): UseAuditionReturn {
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const currentRef = useRef<{ key: string; audio: AuditionAudio; url: string } | null>(null);

  const release = useCallback(() => {
    const current = currentRef.current;
    if (!current) return;
    currentRef.current = null;
    current.audio.onended = null;
    current.audio.onerror = null;
    current.audio.pause();
    URL.revokeObjectURL(current.url);
  }, []);

  const stop = useCallback(() => {
    release();
    setPlayingKey(null);
  }, [release]);

  const play = useCallback(async (key: string, wav: Uint8Array) => {
    release();
    const url = URL.createObjectURL(new Blob([toStandaloneArrayBuffer(wav)], { type: "audio/wav" }));
    const audio = createAudio(url);
    const entry = { key, audio, url };
    currentRef.current = entry;
    const finish = () => {
      if (currentRef.current !== entry) return;
      release();
      setPlayingKey(null);
    };
    audio.onended = finish;
    audio.onerror = finish;
    setPlayingKey(key);
    try {
      await audio.play();
    } catch (error) {
      finish();
      throw error;
    }
  }, [createAudio, release]);

  useEffect(() => release, [release]);

  return { playingKey, play, stop };
}
