import { useState, useRef, useCallback, useEffect } from "react";
import type { AudioExportOptions, CaptionExportFormat } from "../types";
import type { CachedReaderAudioChunk } from "../lib/readerDocument";
import {
  AUDIO_PLAYER_RETAIN_BEHIND_SECONDS,
  AUDIO_PLAYER_SCHEDULE_HORIZON_SECONDS,
} from "../constants";
import { PlaybackClock } from "../lib/playbackClock";
import { buildCaptionJson, buildSrt, buildVtt } from "../lib/captions";
import { downloadAudioChunks } from "../lib/audioExportClient";
import { downloadBlob } from "../lib/exportAudio";
import { scheduleNextUiFrame, type CancelScheduledUiFlush } from "../lib/uiScheduling";
import {
  buildAudioSegments,
  buildCaptionSegments,
  getChunkDuration,
  retimeStoredChunks,
  type AudioChunkData,
  type AudioSegment,
  type StoredAudioChunk,
} from "../lib/audioTimeline";

export type { AudioChunkData, AudioSegment } from "../lib/audioTimeline";

export interface UseAudioPlayerReturn {
  isPlaying: boolean;
  error: string | null;
  /**
   * Playback position. It ticks once per animation frame, so it is published
   * through an external store rather than React state — subscribe with
   * `usePlaybackTime` / `usePlaybackSelector` at the leaf that needs it, or read
   * `getCurrentTime()` imperatively from callbacks and effects.
   */
  clock: PlaybackClock;
  getCurrentTime: () => number;
  totalDuration: number;
  playbackRate: number;
  segments: AudioSegment[];
  activeSegmentId: string | null;
  scheduleChunk: (chunk: AudioChunkData) => Promise<void>;
  togglePlay: () => void;
  seek: (percentage: number) => void;
  seekTo: (seconds: number) => void;
  skip: (deltaSeconds: number) => void;
  jumpToSegment: (segmentId: string) => void;
  setPlaybackRate: (rate: number) => void;
  download: (options?: AudioExportOptions) => Promise<void>;
  downloadCaptions: (format: CaptionExportFormat) => void;
  replaceSegment: (segmentId: string, replacement: AudioChunkData) => void;
  getAudioChunkCount: () => number;
  truncateAudioChunks: (count: number) => void;
  getAudioCacheSnapshot: () => CachedReaderAudioChunk[];
  restoreAudioCache: (
    chunks: readonly CachedReaderAudioChunk[],
    options?: { currentTime?: number; playbackRate?: number },
  ) => void;
  beginStream: () => void;
  endStream: () => void;
  reset: () => void;
  stopAll: () => void;
}

const MIN_PLAYBACK_RATE = 0.75;
const MAX_PLAYBACK_RATE = 2.0;
/** Background-safe cadence for extending the playback schedule. */
const SCHEDULE_TOPUP_INTERVAL_MS = 1000;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Web Audio API playback hook.
 * Uses AudioContext with createBufferSource() for streaming Float32 chunks.
 * Does NOT use <audio> element — it cannot handle streaming PCM Float32 chunks.
 */
export function useAudioPlayer(): UseAudioPlayerReturn {
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalDuration, setTotalDuration] = useState(0);
  const [playbackRate, setPlaybackRateState] = useState(1);
  const [segments, setSegments] = useState<AudioSegment[]>([]);
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);

  // Created once and never replaced; the setter is intentionally unused.
  const [clock] = useState(() => new PlaybackClock());

  const audioContextRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef(0);
  const activeNodesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const allChunksRef = useRef<StoredAudioChunk[]>([]);
  const samplingRateRef = useRef(24000);
  const animFrameRef = useRef(0);
  const interruptedRef = useRef(false);
  const isPlayingRef = useRef(false);
  const scheduleCursorRef = useRef(0);
  const playbackRateRef = useRef(1);
  const currentTimeRef = useRef(0);
  const totalDurationRef = useRef(0);
  const timelineAnchorRef = useRef(0);
  const contextAnchorRef = useRef(0);
  const segmentCounterRef = useRef(0);
  const autoPlayOnChunkRef = useRef(true);
  const streamCompleteRef = useRef(true);
  const playbackOperationRef = useRef(0);
  // Lowest chunk index that may still hold a decoded AudioBuffer. Pruning walks
  // forward from here instead of rescanning every chunk on every frame.
  const decodedLowIndexRef = useRef(0);
  const lastActiveSegmentIdRef = useRef<string | null>(null);
  const timelineUiFlushCancelRef = useRef<CancelScheduledUiFlush | null>(null);
  const timelineSegmentsDirtyRef = useRef(false);
  const timelineDurationDirtyRef = useRef(false);

  const getContext = useCallback((): AudioContext => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }
    return audioContextRef.current;
  }, []);

  const failPlaybackStart = useCallback(() => {
    setError("Audio playback was blocked. Press Play again to enable audio output.");
    setIsPlaying(false);
    isPlayingRef.current = false;
    interruptedRef.current = false;
    autoPlayOnChunkRef.current = false;
  }, []);

  const flushTimelineState = useCallback(() => {
    timelineUiFlushCancelRef.current = null;

    if (timelineDurationDirtyRef.current) {
      timelineDurationDirtyRef.current = false;
      setTotalDuration(totalDurationRef.current);
    }

    if (timelineSegmentsDirtyRef.current) {
      timelineSegmentsDirtyRef.current = false;
      setSegments(buildAudioSegments(allChunksRef.current));
    }
  }, []);

  const queueTimelineStateFlush = useCallback(() => {
    if (timelineUiFlushCancelRef.current) return;
    timelineUiFlushCancelRef.current = scheduleNextUiFrame(flushTimelineState);
  }, [flushTimelineState]);

  const cancelTimelineStateFlush = useCallback(() => {
    if (timelineUiFlushCancelRef.current) {
      timelineUiFlushCancelRef.current();
      timelineUiFlushCancelRef.current = null;
    }
    timelineSegmentsDirtyRef.current = false;
    timelineDurationDirtyRef.current = false;
  }, []);

  const rebuildSegmentState = useCallback(() => {
    cancelTimelineStateFlush();
    setSegments(buildAudioSegments(allChunksRef.current));
  }, [cancelTimelineStateFlush]);

  const activeSegmentCursorRef = useRef(0);

  // Called on every frame, so it must not push an unchanged value into state —
  // React would still re-render this hook's consumers once per tick.
  const commitActiveSegmentId = useCallback((segmentId: string | null) => {
    if (lastActiveSegmentIdRef.current === segmentId) return;
    lastActiveSegmentIdRef.current = segmentId;
    setActiveSegmentId(segmentId);
  }, []);

  const updateActiveSegment = useCallback((timeSec: number) => {
    const chunks = allChunksRef.current;
    if (chunks.length === 0) {
      commitActiveSegmentId(null);
      return;
    }

    // Start from the cached cursor for O(1) forward playback lookups.
    let cursor = activeSegmentCursorRef.current;
    if (cursor >= chunks.length) cursor = 0;

    // Advance cursor forward if time has moved past the current chunk.
    while (cursor < chunks.length - 1 && timeSec >= chunks[cursor].endSec) {
      cursor += 1;
    }
    // Move cursor backward if time is before the current chunk (e.g., seek).
    while (cursor > 0 && timeSec < chunks[cursor].startSec) {
      cursor -= 1;
    }

    activeSegmentCursorRef.current = cursor;
    const chunk = chunks[cursor];
    commitActiveSegmentId(
      timeSec >= chunk.startSec && timeSec < chunk.endSec ? chunk.segmentId : null,
    );
  }, [commitActiveSegmentId]);

  const syncCurrentTime = useCallback((nextTime: number) => {
    const clamped = clamp(nextTime, 0, totalDurationRef.current);
    currentTimeRef.current = clamped;
    clock.set(clamped);
    updateActiveSegment(clamped);
    return clamped;
  }, [clock, updateActiveSegment]);

  const syncTotalDuration = useCallback((nextDuration: number, options: { deferUi?: boolean } = {}) => {
    const clamped = Math.max(0, nextDuration);
    totalDurationRef.current = clamped;
    if (options.deferUi) {
      timelineDurationDirtyRef.current = true;
      queueTimelineStateFlush();
    } else {
      timelineDurationDirtyRef.current = false;
      setTotalDuration(clamped);
    }
    if (currentTimeRef.current > clamped) {
      syncCurrentTime(clamped);
    }
  }, [queueTimelineStateFlush, syncCurrentTime]);

  const getLiveTimelineTime = useCallback((): number => {
    const ctx = audioContextRef.current;
    if (!ctx || !isPlayingRef.current) return currentTimeRef.current;

    const elapsed = (ctx.currentTime - contextAnchorRef.current) * playbackRateRef.current;
    return timelineAnchorRef.current + elapsed;
  }, []);

  const stopAllNodes = useCallback(() => {
    activeNodesRef.current.forEach((node) => {
      node.onended = null;
      try { node.stop(); } catch { /* already stopped */ }
      try { node.disconnect(); } catch { /* already disconnected */ }
    });
    activeNodesRef.current.clear();
  }, []);

  const registerSource = useCallback((source: AudioBufferSourceNode) => {
    activeNodesRef.current.add(source);
    source.onended = () => {
      activeNodesRef.current.delete(source);
      source.onended = null;
      try { source.disconnect(); } catch { /* already disconnected */ }
    };
  }, []);

  const copyToChannel = useCallback((buffer: AudioBuffer, data: Float32Array) => {
    buffer.getChannelData(0).set(data);
  }, []);

  const ensureAudioBuffer = useCallback((ctx: AudioContext, chunk: StoredAudioChunk): AudioBuffer => {
    if (!chunk.audioBuffer) {
      chunk.audioBuffer = ctx.createBuffer(1, chunk.audio.length, chunk.samplingRate);
      copyToChannel(chunk.audioBuffer, chunk.audio);
    }
    return chunk.audioBuffer;
  }, [copyToChannel]);

  // Releases decoded buffers that the playhead has moved past. Chunks are time
  // ordered and buffers are only ever created ahead of `decodedLowIndexRef`, so
  // this costs one step per chunk actually released rather than a full rescan.
  // A released buffer is rebuilt on demand by `ensureAudioBuffer` if the
  // listener seeks back into it; the underlying Float32 PCM is never dropped.
  const pruneBufferedAudio = useCallback((referenceTimeSec: number) => {
    const chunks = allChunksRef.current;
    const releaseBefore = referenceTimeSec - AUDIO_PLAYER_RETAIN_BEHIND_SECONDS;

    let index = Math.max(0, Math.min(decodedLowIndexRef.current, chunks.length));
    while (index < chunks.length && chunks[index].endSec < releaseBefore) {
      chunks[index].audioBuffer = undefined;
      index += 1;
    }
    decodedLowIndexRef.current = index;
  }, []);

  /** First chunk whose audio extends past `timeSec`, or `length` if none does. */
  const findChunkIndexAtTime = useCallback((timeSec: number): number => {
    const chunks = allChunksRef.current;
    let low = 0;
    let high = chunks.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (chunks[mid].endSec > timeSec) high = mid;
      else low = mid + 1;
    }
    return low;
  }, []);

  const scheduleBufferedChunks = useCallback((ctx: AudioContext, seekTimeSec?: number) => {
    if (allChunksRef.current.length === 0) return;

    const liveTime = isPlayingRef.current ? getLiveTimelineTime() : currentTimeRef.current;
    const horizonSec = liveTime + AUDIO_PLAYER_SCHEDULE_HORIZON_SECONDS;
    const playbackRate = playbackRateRef.current;
    let nextPlay = nextPlayTimeRef.current;
    let cursor = scheduleCursorRef.current;
    let firstChunkSeekTime = seekTimeSec;

    // A hidden tab or blocked main thread can delay both scheduling loops past
    // the materialised horizon. Web Audio starts a source whose `when` is in the
    // past immediately, so retaining the stale cursor would make every missed
    // chunk overlap. Re-anchor at the live timeline position and start only the
    // chunk that contains it, with the elapsed portion skipped.
    if (nextPlay > 0 && nextPlay <= ctx.currentTime) {
      nextPlay = ctx.currentTime;
      cursor = findChunkIndexAtTime(liveTime);
      firstChunkSeekTime = liveTime;
      timelineAnchorRef.current = liveTime;
      contextAnchorRef.current = ctx.currentTime;
    }

    while (cursor < allChunksRef.current.length) {
      const chunk = allChunksRef.current[cursor];
      if (chunk.startSec >= horizonSec) break;

      const chunkDuration = getChunkDuration(chunk);
      const offset = firstChunkSeekTime === undefined
        ? 0
        : Math.max(0, firstChunkSeekTime - chunk.startSec);

      firstChunkSeekTime = undefined;
      if (offset >= chunkDuration) {
        cursor += 1;
        continue;
      }

      const audioBuffer = ensureAudioBuffer(ctx, chunk);
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.playbackRate.value = playbackRate;
      source.connect(ctx.destination);
      source.start(nextPlay, offset);
      registerSource(source);

      nextPlay += Math.max(0, (chunkDuration - offset) / playbackRate);
      cursor += 1;
    }

    nextPlayTimeRef.current = nextPlay;
    scheduleCursorRef.current = cursor;
    // Safe to run on every frame: the walk resumes from the low-water mark, so
    // it does no work at all unless the playhead has actually left a chunk.
    pruneBufferedAudio(liveTime);
  }, [
    ensureAudioBuffer,
    findChunkIndexAtTime,
    getLiveTimelineTime,
    pruneBufferedAudio,
    registerSource,
  ]);

  const replayFromOffset = useCallback(async (seekTimeSec: number, shouldPlay: boolean) => {
    const ctx = getContext();
    const clampedSeek = clamp(seekTimeSec, 0, totalDurationRef.current);
    const operation = ++playbackOperationRef.current;

    interruptedRef.current = true;
    stopAllNodes();
    nextPlayTimeRef.current = 0;
    scheduleCursorRef.current = findChunkIndexAtTime(clampedSeek);
    // Seeking behind the decoded low-water mark rebuilds earlier buffers. Move
    // the pruning cursor back as well so those buffers are released again after
    // the playhead passes them.
    decodedLowIndexRef.current = Math.min(
      decodedLowIndexRef.current,
      scheduleCursorRef.current,
    );
    timelineAnchorRef.current = clampedSeek;
    contextAnchorRef.current = ctx.currentTime;

    if (allChunksRef.current.length === 0) {
      syncCurrentTime(0);
      setIsPlaying(false);
      isPlayingRef.current = false;
      interruptedRef.current = false;
      return;
    }

    syncCurrentTime(clampedSeek);

    if (!shouldPlay || clampedSeek >= totalDurationRef.current) {
      setIsPlaying(false);
      isPlayingRef.current = false;
      interruptedRef.current = false;
      return;
    }

    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        if (operation === playbackOperationRef.current) failPlaybackStart();
        return;
      }
    }

    // Stop/Reset, a newer seek, or another transport action may have happened
    // while AudioContext.resume() was pending. Never let the stale continuation
    // revive playback or replace the newer schedule.
    if (operation !== playbackOperationRef.current) return;

    nextPlayTimeRef.current = ctx.currentTime;
    timelineAnchorRef.current = clampedSeek;
    contextAnchorRef.current = ctx.currentTime;
    scheduleBufferedChunks(ctx, clampedSeek);

    setError(null);
    setIsPlaying(true);
    isPlayingRef.current = true;
    interruptedRef.current = false;
  }, [failPlaybackStart, findChunkIndexAtTime, getContext, scheduleBufferedChunks, stopAllNodes, syncCurrentTime]);

  useEffect(() => {
    const update = () => {
      if (isPlayingRef.current && audioContextRef.current) {
        scheduleBufferedChunks(audioContextRef.current);
        const live = getLiveTimelineTime();
        const clamped = syncCurrentTime(live);

        if (
          clamped >= totalDurationRef.current
          && totalDurationRef.current > 0
          && allChunksRef.current.length > 0
        ) {
          if (!streamCompleteRef.current) {
            timelineAnchorRef.current = totalDurationRef.current;
            contextAnchorRef.current = audioContextRef.current.currentTime;
            syncCurrentTime(totalDurationRef.current);
            animFrameRef.current = requestAnimationFrame(update);
            return;
          }

          setIsPlaying(false);
          isPlayingRef.current = false;
          syncCurrentTime(totalDurationRef.current);
          stopAllNodes();
          // Stop the loop — playback ended.
          return;
        }
        // Continue updating while playing.
        animFrameRef.current = requestAnimationFrame(update);
      }
      // Not playing — don't reschedule. The loop restarts when playback begins.
    };

    // Only start the loop if currently playing.
    if (isPlaying) {
      animFrameRef.current = requestAnimationFrame(update);
    }
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [isPlaying, getLiveTimelineTime, scheduleBufferedChunks, stopAllNodes, syncCurrentTime]);

  // A second, timer-driven top-up of the schedule. The animation-frame loop
  // above is the primary one, but it stops entirely in a hidden browser tab —
  // and the schedule only runs AUDIO_PLAYER_SCHEDULE_HORIZON_SECONDS ahead, so
  // relying on it alone would let audio run dry shortly after the listener
  // switches tabs. Timers are throttled in the background but never below about
  // a second, which leaves the whole horizon as slack. `getLiveTimelineTime`
  // reads from the AudioContext, so the position stays accurate either way.
  useEffect(() => {
    if (!isPlaying) return;
    const timer = window.setInterval(() => {
      const ctx = audioContextRef.current;
      if (ctx && isPlayingRef.current) scheduleBufferedChunks(ctx);
    }, SCHEDULE_TOPUP_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [isPlaying, scheduleBufferedChunks]);

  const scheduleChunk = useCallback(async (chunk: AudioChunkData) => {
    const ctx = getContext();
    const operation = playbackOperationRef.current;

    samplingRateRef.current = chunk.samplingRate;
    const chunkDuration = getChunkDuration(chunk);

    const startSec = totalDurationRef.current;
    const endSec = startSec + chunkDuration;
    const previous = allChunksRef.current.at(-1);
    const continuesSemanticSegment = previous
      && typeof chunk.textStart === "number"
      && typeof chunk.textEnd === "number"
      && previous.textStart === chunk.textStart
      && previous.textEnd === chunk.textEnd
      && previous.text === chunk.text
      && previous.index === chunk.index
      && previous.total === chunk.total;
    if (!continuesSemanticSegment) segmentCounterRef.current += 1;
    const segmentId = continuesSemanticSegment
      ? previous.segmentId
      : `segment-${segmentCounterRef.current}`;

    const storedChunk: StoredAudioChunk = {
      ...chunk,
      startSec,
      endSec,
      segmentId,
    };
    allChunksRef.current.push(storedChunk);

    syncTotalDuration(totalDurationRef.current + chunkDuration, { deferUi: true });
    timelineSegmentsDirtyRef.current = true;
    queueTimelineStateFlush();

    if (interruptedRef.current) return;

    const hasQueuedPlayback = nextPlayTimeRef.current > 0 || activeNodesRef.current.size > 0;
    if (!autoPlayOnChunkRef.current && !hasQueuedPlayback) {
      return;
    }

    if (
      isPlayingRef.current
      && nextPlayTimeRef.current > 0
      && nextPlayTimeRef.current <= ctx.currentTime
    ) {
      nextPlayTimeRef.current = ctx.currentTime;
      scheduleCursorRef.current = findChunkIndexAtTime(currentTimeRef.current);
      timelineAnchorRef.current = currentTimeRef.current;
      contextAnchorRef.current = ctx.currentTime;
    }

    if (nextPlayTimeRef.current === 0) {
      nextPlayTimeRef.current = ctx.currentTime + 0.05;
      timelineAnchorRef.current = currentTimeRef.current;
      contextAnchorRef.current = nextPlayTimeRef.current;
    }
    scheduleBufferedChunks(ctx);

    if (!autoPlayOnChunkRef.current) {
      return;
    }

    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        if (operation === playbackOperationRef.current) {
          stopAllNodes();
          nextPlayTimeRef.current = 0;
          scheduleCursorRef.current = findChunkIndexAtTime(currentTimeRef.current);
          failPlaybackStart();
        }
        return;
      }
    }

    if (operation !== playbackOperationRef.current || !autoPlayOnChunkRef.current) return;

    setError(null);
    if (!isPlayingRef.current) {
      setIsPlaying(true);
      isPlayingRef.current = true;
    }
  }, [
    failPlaybackStart,
    findChunkIndexAtTime,
    getContext,
    queueTimelineStateFlush,
    scheduleBufferedChunks,
    stopAllNodes,
    syncTotalDuration,
  ]);

  const togglePlay = useCallback(async () => {
    const ctx = getContext();

    if (isPlayingRef.current) {
      playbackOperationRef.current += 1;
      autoPlayOnChunkRef.current = false;
      const snapshot = syncCurrentTime(getLiveTimelineTime());
      timelineAnchorRef.current = snapshot;
      contextAnchorRef.current = ctx.currentTime;

      setIsPlaying(false);
      isPlayingRef.current = false;
      await ctx.suspend();
      return;
    }

    autoPlayOnChunkRef.current = true;
    const operation = ++playbackOperationRef.current;
    try {
      await ctx.resume();
    } catch {
      if (operation === playbackOperationRef.current) failPlaybackStart();
      return;
    }
    if (operation !== playbackOperationRef.current) return;
    setError(null);

    if (currentTimeRef.current >= totalDurationRef.current && totalDurationRef.current > 0) {
      await replayFromOffset(0, true);
      return;
    }

    if (activeNodesRef.current.size === 0 && allChunksRef.current.length > 0) {
      await replayFromOffset(currentTimeRef.current, true);
      return;
    }

    timelineAnchorRef.current = currentTimeRef.current;
    contextAnchorRef.current = ctx.currentTime;
    setIsPlaying(true);
    isPlayingRef.current = true;
  }, [failPlaybackStart, getContext, getLiveTimelineTime, replayFromOffset, syncCurrentTime]);

  const seekTo = useCallback((seconds: number) => {
    const shouldPlay = isPlayingRef.current;
    autoPlayOnChunkRef.current = shouldPlay;
    void replayFromOffset(seconds, shouldPlay);
  }, [replayFromOffset]);

  const seek = useCallback((percentage: number) => {
    const seekTime = totalDurationRef.current * clamp(percentage, 0, 1);
    seekTo(seekTime);
  }, [seekTo]);

  const skip = useCallback((deltaSeconds: number) => {
    seekTo(currentTimeRef.current + deltaSeconds);
  }, [seekTo]);

  const jumpToSegment = useCallback((segmentId: string) => {
    const segment = allChunksRef.current.find((entry) => entry.segmentId === segmentId);
    if (!segment) return;
    seekTo(segment.startSec);
  }, [seekTo]);

  const setPlaybackRate = useCallback((rate: number) => {
    const nextRate = clamp(rate, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE);
    if (Math.abs(nextRate - playbackRateRef.current) < 0.001) return;

    const live = getLiveTimelineTime();

    playbackRateRef.current = nextRate;
    setPlaybackRateState(nextRate);

    // Rebuild scheduling at the new rate to avoid drift/gaps for pre-scheduled nodes.
    if (isPlayingRef.current && allChunksRef.current.length > 0) {
      autoPlayOnChunkRef.current = true;
      void replayFromOffset(live, true);
      return;
    }

    if ((activeNodesRef.current.size > 0 || nextPlayTimeRef.current > 0) && allChunksRef.current.length > 0) {
      autoPlayOnChunkRef.current = false;
      void replayFromOffset(live, false);
      return;
    }

    syncCurrentTime(live);
  }, [getLiveTimelineTime, replayFromOffset, syncCurrentTime]);

  const download = useCallback(async (options?: AudioExportOptions) => {
    if (allChunksRef.current.length === 0) return;

    await downloadAudioChunks(allChunksRef.current.map((chunk) => ({
      audio: chunk.audio,
      samplingRate: chunk.samplingRate,
    })), options);
  }, []);

  const downloadCaptions = useCallback((format: CaptionExportFormat) => {
    if (allChunksRef.current.length === 0) return;

    const segments = buildCaptionSegments(allChunksRef.current);

    if (segments.length === 0) return;

    if (format === "srt") {
      downloadBlob(new Blob([buildSrt(segments)], { type: "application/x-subrip" }), "tts-captions.srt");
      return;
    }

    if (format === "vtt") {
      downloadBlob(new Blob([buildVtt(segments)], { type: "text/vtt" }), "tts-captions.vtt");
      return;
    }

    downloadBlob(new Blob([buildCaptionJson(segments)], { type: "application/json" }), "tts-timestamps.json");
  }, []);

  const replaceSegment = useCallback((segmentId: string, replacement: AudioChunkData) => {
    const index = allChunksRef.current.findIndex((chunk) => chunk.segmentId === segmentId);
    if (index < 0) return;

    let endIndex = index + 1;
    while (
      endIndex < allChunksRef.current.length
      && allChunksRef.current[endIndex].segmentId === segmentId
    ) {
      endIndex += 1;
    }

    const current = allChunksRef.current[index];
    const previousEndSec = allChunksRef.current[endIndex - 1].endSec;
    const previousDuration = previousEndSec - current.startSec;
    const replacementDuration = getChunkDuration(replacement);
    const replacementChunk: StoredAudioChunk = {
      ...current,
      ...replacement,
      segmentId: current.segmentId,
      startSec: current.startSec,
      endSec: current.startSec + replacementDuration,
      audioBuffer: undefined,
    };
    // One visible/semantic section can consist of several bounded transport
    // chunks (notably Qwen). A retake replaces the whole section, not only its
    // first transport chunk.
    allChunksRef.current.splice(index, endIndex - index, replacementChunk);

    allChunksRef.current = retimeStoredChunks(allChunksRef.current);
    const nextDuration = allChunksRef.current.at(-1)?.endSec ?? 0;

    samplingRateRef.current = replacement.samplingRate;
    const previousPlaybackTime = currentTimeRef.current;
    const playbackSnapshot = previousPlaybackTime >= previousEndSec
      ? previousPlaybackTime + replacementDuration - previousDuration
      : previousPlaybackTime > current.startSec && previousDuration > 0
        ? current.startSec + (
            ((previousPlaybackTime - current.startSec) / previousDuration) * replacementDuration
          )
        : previousPlaybackTime;
    syncTotalDuration(nextDuration);
    rebuildSegmentState();
    syncCurrentTime(playbackSnapshot);

    if (isPlayingRef.current && allChunksRef.current.length > 0) {
      autoPlayOnChunkRef.current = true;
      void replayFromOffset(playbackSnapshot, true);
    } else if ((activeNodesRef.current.size > 0 || nextPlayTimeRef.current > 0) && allChunksRef.current.length > 0) {
      autoPlayOnChunkRef.current = false;
      void replayFromOffset(playbackSnapshot, false);
    }
    // The chunk array was spliced, so the low-water mark no longer refers to
    // the chunk it was measured against.
    decodedLowIndexRef.current = 0;
    pruneBufferedAudio(playbackSnapshot);
  }, [pruneBufferedAudio, rebuildSegmentState, replayFromOffset, syncCurrentTime, syncTotalDuration]);

  const getAudioCacheSnapshot = useCallback((): CachedReaderAudioChunk[] => (
    allChunksRef.current.map((chunk) => ({
      audio: new Float32Array(chunk.audio).buffer,
      samplingRate: chunk.samplingRate,
      text: chunk.text ?? "",
      index: chunk.index ?? 0,
      total: chunk.total ?? allChunksRef.current.length,
      textStart: chunk.textStart,
      textEnd: chunk.textEnd,
      pauseAfterSec: chunk.pauseAfterSec,
      pauseKind: chunk.pauseKind,
    }))
  ), []);

  const getAudioChunkCount = useCallback(() => allChunksRef.current.length, []);

  const truncateAudioChunks = useCallback((count: number) => {
    const retainedCount = clamp(Math.floor(Number.isFinite(count) ? count : 0), 0, allChunksRef.current.length);
    if (retainedCount >= allChunksRef.current.length) return;

    const wasPlaying = isPlayingRef.current;
    const playbackSnapshot = wasPlaying ? getLiveTimelineTime() : currentTimeRef.current;
    playbackOperationRef.current += 1;
    allChunksRef.current = allChunksRef.current.slice(0, retainedCount);
    segmentCounterRef.current = new Set(allChunksRef.current.map((chunk) => chunk.segmentId)).size;
    const nextDuration = allChunksRef.current.at(-1)?.endSec ?? 0;
    const nextTime = clamp(playbackSnapshot, 0, nextDuration);
    syncTotalDuration(nextDuration);
    rebuildSegmentState();
    syncCurrentTime(nextTime);
    autoPlayOnChunkRef.current = wasPlaying && nextTime < nextDuration;
    void replayFromOffset(nextTime, autoPlayOnChunkRef.current);
    decodedLowIndexRef.current = 0;
    pruneBufferedAudio(nextTime);
  }, [
    getLiveTimelineTime,
    pruneBufferedAudio,
    rebuildSegmentState,
    replayFromOffset,
    syncCurrentTime,
    syncTotalDuration,
  ]);

  const restoreAudioCache = useCallback((
    chunks: readonly CachedReaderAudioChunk[],
    options: { currentTime?: number; playbackRate?: number } = {},
  ) => {
    playbackOperationRef.current += 1;
    stopAllNodes();
    cancelTimelineStateFlush();
    segmentCounterRef.current = 0;
    let previousSource: CachedReaderAudioChunk | undefined;
    let previousSegmentId: string | undefined;
    const restored: StoredAudioChunk[] = chunks.map((chunk) => {
      const continuesSemanticSegment = previousSource
        && typeof chunk.textStart === "number"
        && typeof chunk.textEnd === "number"
        && previousSource.textStart === chunk.textStart
        && previousSource.textEnd === chunk.textEnd
        && previousSource.text === chunk.text
        && previousSource.index === chunk.index
        && previousSource.total === chunk.total;
      if (!continuesSemanticSegment) segmentCounterRef.current += 1;
      const segmentId = continuesSemanticSegment && previousSegmentId
        ? previousSegmentId
        : `segment-${segmentCounterRef.current}`;
      previousSource = chunk;
      previousSegmentId = segmentId;
      return {
        ...chunk,
        audio: new Float32Array(chunk.audio.slice(0)),
        startSec: 0,
        endSec: 0,
        segmentId,
      };
    });
    allChunksRef.current = retimeStoredChunks(restored);
    samplingRateRef.current = restored[0]?.samplingRate ?? samplingRateRef.current;
    const duration = allChunksRef.current.at(-1)?.endSec ?? 0;
    totalDurationRef.current = duration;
    const restoredRate = clamp(options.playbackRate ?? 1, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE);
    playbackRateRef.current = restoredRate;
    setPlaybackRateState(restoredRate);
    const restoredTime = clamp(options.currentTime ?? 0, 0, duration);
    currentTimeRef.current = restoredTime;
    timelineAnchorRef.current = restoredTime;
    contextAnchorRef.current = 0;
    nextPlayTimeRef.current = 0;
    scheduleCursorRef.current = findChunkIndexAtTime(restoredTime);
    activeSegmentCursorRef.current = Math.max(0, scheduleCursorRef.current);
    autoPlayOnChunkRef.current = false;
    streamCompleteRef.current = true;
    interruptedRef.current = false;
    isPlayingRef.current = false;
    setIsPlaying(false);
    setError(null);
    setTotalDuration(duration);
    setSegments(buildAudioSegments(allChunksRef.current));
    clock.set(restoredTime);
    updateActiveSegment(restoredTime);
    decodedLowIndexRef.current = 0;
    pruneBufferedAudio(restoredTime);
  }, [cancelTimelineStateFlush, clock, findChunkIndexAtTime, pruneBufferedAudio, stopAllNodes, updateActiveSegment]);

  const beginStream = useCallback(() => {
    streamCompleteRef.current = false;
  }, []);

  const endStream = useCallback(() => {
    streamCompleteRef.current = true;

    if (
      isPlayingRef.current
      && currentTimeRef.current >= totalDurationRef.current
      && totalDurationRef.current > 0
      && allChunksRef.current.length > 0
    ) {
      playbackOperationRef.current += 1;
      setIsPlaying(false);
      isPlayingRef.current = false;
      syncCurrentTime(totalDurationRef.current);
      stopAllNodes();
    }
  }, [stopAllNodes, syncCurrentTime]);

  const reset = useCallback(() => {
    playbackOperationRef.current += 1;
    stopAllNodes();
    cancelTimelineStateFlush();

    allChunksRef.current = [];
    nextPlayTimeRef.current = 0;
    scheduleCursorRef.current = 0;
    decodedLowIndexRef.current = 0;
    timelineAnchorRef.current = 0;
    contextAnchorRef.current = 0;
    interruptedRef.current = false;
    autoPlayOnChunkRef.current = true;
    streamCompleteRef.current = true;
    setError(null);

    setSegments([]);
    commitActiveSegmentId(null);

    setIsPlaying(false);
    isPlayingRef.current = false;

    syncCurrentTime(0);
    syncTotalDuration(0);
  }, [cancelTimelineStateFlush, commitActiveSegmentId, stopAllNodes, syncCurrentTime, syncTotalDuration]);

  const stopAll = useCallback(() => {
    playbackOperationRef.current += 1;
    stopAllNodes();
    nextPlayTimeRef.current = 0;
    scheduleCursorRef.current = 0;
    timelineAnchorRef.current = 0;
    contextAnchorRef.current = 0;
    interruptedRef.current = false;
    autoPlayOnChunkRef.current = false;
    streamCompleteRef.current = true;
    setError(null);
    setIsPlaying(false);
    isPlayingRef.current = false;
    syncCurrentTime(0);
    commitActiveSegmentId(null);
  }, [commitActiveSegmentId, stopAllNodes, syncCurrentTime]);

  const getCurrentTime = useCallback(() => currentTimeRef.current, []);

  useEffect(() => {
    return () => {
      playbackOperationRef.current += 1;
      cancelAnimationFrame(animFrameRef.current);
      cancelTimelineStateFlush();
      stopAllNodes();
      if (audioContextRef.current) {
        void audioContextRef.current.close();
      }
    };
  }, [cancelTimelineStateFlush, stopAllNodes]);

  return {
    isPlaying,
    error,
    clock,
    getCurrentTime,
    totalDuration,
    playbackRate,
    segments,
    activeSegmentId,
    scheduleChunk,
    togglePlay,
    seek,
    seekTo,
    skip,
    jumpToSegment,
    setPlaybackRate,
    download,
    downloadCaptions,
    replaceSegment,
    getAudioChunkCount,
    truncateAudioChunks,
    getAudioCacheSnapshot,
    restoreAudioCache,
    beginStream,
    endStream,
    reset,
    stopAll,
  };
}
