import { useEffect, useEffectEvent, useRef } from "react";
import type { PlaybackClock } from "../lib/playbackClock";
import {
  createSilentWav,
  MEDIA_SESSION_SEEK_SECONDS,
  setActionHandlers,
  setNowPlaying,
  setPlaybackState,
  setPositionState,
  type NowPlaying,
} from "../lib/mediaSession";

/** The transport the OS media keys drive. */
export interface MediaSessionTransport {
  play: () => void;
  pause: () => void;
  /** Moves by `deltaSeconds`; negative goes back. */
  seekBy: (deltaSeconds: number) => void;
  seekTo: (seconds: number) => void;
  /** Absent when there is nothing before / after to go to. */
  previous?: () => void;
  next?: () => void;
}

interface Options {
  /** Publish to the OS; false withdraws everything this hook published. */
  enabled: boolean;
  nowPlaying: NowPlaying | null;
  isPlaying: boolean;
  /** Length of what is loaded; grows while it is still streaming. */
  duration: number;
  playbackRate: number;
  clock: PlaybackClock;
  getCurrentTime: () => number;
  transport: MediaSessionTransport;
}

/** A jump in the playback position larger than this is a seek, not playback. */
const POSITION_DRIFT_SECONDS = 1;
/** While audio streams in its duration grows; the OS widget need not hear every chunk. */
const DURATION_REPORT_INTERVAL_MS = 2_000;

/**
 * Publishes playback to the operating system: Now Playing metadata, the
 * position, and the play/pause/seek/previous/next keys.
 *
 * Reader audio is Web Audio, which Chromium does not count as media, so while
 * enabled a silent looping `<audio>` element plays and pauses in step with the
 * reader. That is what makes the page appear in the OS controls at all.
 */
export function useMediaSession({
  enabled,
  nowPlaying,
  isPlaying,
  duration,
  playbackRate,
  clock,
  getCurrentTime,
  transport,
}: Options): void {
  const dispatch = useEffectEvent((action: (current: MediaSessionTransport) => void) => action(transport));
  // The handlers are reinstalled only when a key appears or disappears.
  const hasPrevious = transport.previous !== undefined;
  const hasNext = transport.next !== undefined;
  const silentRef = useRef<HTMLAudioElement | null>(null);
  const reportedRef = useRef({ duration: 0, position: 0, at: 0 });

  useEffect(() => {
    if (!enabled) return;
    const withdraw = setActionHandlers({
      play: () => dispatch((t) => t.play()),
      pause: () => dispatch((t) => t.pause()),
      stop: () => dispatch((t) => t.pause()),
      seekbackward: (details) => dispatch((t) => t.seekBy(-(details.seekOffset ?? MEDIA_SESSION_SEEK_SECONDS))),
      seekforward: (details) => dispatch((t) => t.seekBy(details.seekOffset ?? MEDIA_SESSION_SEEK_SECONDS)),
      seekto: (details) => {
        const seekTime = details.seekTime;
        if (typeof seekTime === "number") dispatch((t) => t.seekTo(seekTime));
      },
      previoustrack: hasPrevious ? () => dispatch((t) => t.previous?.()) : undefined,
      nexttrack: hasNext ? () => dispatch((t) => t.next?.()) : undefined,
    });
    return () => {
      withdraw();
      setPlaybackState("none");
      setPositionState(null);
      setNowPlaying(null);
    };
  }, [enabled, hasNext, hasPrevious]);

  useEffect(() => {
    if (enabled) setNowPlaying(nowPlaying);
  }, [enabled, nowPlaying]);

  // The silent element that makes the page a media player.
  useEffect(() => {
    if (!enabled || typeof Audio === "undefined" || typeof URL.createObjectURL !== "function") return;
    const url = URL.createObjectURL(new Blob([createSilentWav()], { type: "audio/wav" }));
    const element = new Audio(url);
    element.loop = true;
    silentRef.current = element;
    return () => {
      silentRef.current = null;
      element.pause();
      element.removeAttribute("src");
      element.load();
      URL.revokeObjectURL(url);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    setPlaybackState(isPlaying ? "playing" : "paused");
    const element = silentRef.current;
    if (!element) return;
    if (isPlaying) void element.play().catch(() => undefined);
    else element.pause();
  }, [enabled, isPlaying]);

  const report = useEffectEvent((position: number) => {
    reportedRef.current = { duration, position, at: Date.now() };
    setPositionState({ duration, position, playbackRate });
  });

  // The position, whenever what the OS extrapolates from changes (play state,
  // speed, the book part) and, throttled, as streaming audio grows the length.
  const durationRef = useRef(duration);
  useEffect(() => {
    if (!enabled) return;
    const lengthOnly = durationRef.current !== duration;
    durationRef.current = duration;
    const wait = DURATION_REPORT_INTERVAL_MS - (Date.now() - reportedRef.current.at);
    if (lengthOnly && wait > 0) {
      const timer = window.setTimeout(() => report(getCurrentTime()), wait);
      return () => window.clearTimeout(timer);
    }
    report(getCurrentTime());
  }, [duration, enabled, getCurrentTime, isPlaying, nowPlaying, playbackRate]);

  // A seek moves the position faster than playback would; tell the OS.
  const onTick = useEffectEvent(() => {
    const last = reportedRef.current;
    const actual = clock.getTime();
    const expected = last.position + (isPlaying ? ((Date.now() - last.at) / 1_000) * playbackRate : 0);
    if (Math.abs(actual - expected) > POSITION_DRIFT_SECONDS) report(actual);
  });
  useEffect(() => {
    if (!enabled) return;
    return clock.subscribe(() => onTick());
  }, [clock, enabled]);
}
