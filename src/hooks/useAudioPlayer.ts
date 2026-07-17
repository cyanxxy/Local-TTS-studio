import { useState, useRef, useCallback, useEffect } from "react";
import type { AudioExportOptions, CaptionExportFormat } from "../types";
import type { CachedReaderAudioChunk } from "../lib/readerDocument";
import { AUDIO_PLAYER_MAX_BUFFER_SECONDS } from "../constants";
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
  currentTime: number;
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
  const [currentTime, setCurrentTime] = useState(0);
  const [totalDuration, setTotalDuration] = useState(0);
  const [playbackRate, setPlaybackRateState] = useState(1);
  const [segments, setSegments] = useState<AudioSegment[]>([]);
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);

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

  const updateActiveSegment = useCallback((timeSec: number) => {
    const chunks = allChunksRef.current;
    if (chunks.length === 0) {
      setActiveSegmentId(null);
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
    setActiveSegmentId(timeSec >= chunk.startSec && timeSec < chunk.endSec ? chunk.segmentId : null);
  }, []);

  const syncCurrentTime = useCallback((nextTime: number) => {
    const clamped = clamp(nextTime, 0, totalDurationRef.current);
    currentTimeRef.current = clamped;
    setCurrentTime(clamped);
    updateActiveSegment(clamped);
    return clamped;
  }, [updateActiveSegment]);

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

  const pruneBufferedAudio = useCallback(() => {
    let retainedDuration = 0;

    for (let index = allChunksRef.current.length - 1; index >= 0; index -= 1) {
      const chunk = allChunksRef.current[index];
      if (!chunk.audioBuffer) continue;

      const duration = chunk.endSec - chunk.startSec;
      if (retainedDuration === 0 || retainedDuration + duration <= AUDIO_PLAYER_MAX_BUFFER_SECONDS) {
        retainedDuration += duration;
        continue;
      }

      chunk.audioBuffer = undefined;
    }
  }, []);

  const findChunkIndexAtTime = useCallback((timeSec: number): number => {
    const chunks = allChunksRef.current;
    for (let index = 0; index < chunks.length; index += 1) {
      if (chunks[index].endSec > timeSec) {
        return index;
      }
    }
    return chunks.length;
  }, []);

  const scheduleBufferedChunks = useCallback((ctx: AudioContext, seekTimeSec?: number) => {
    if (allChunksRef.current.length === 0) return;

    const liveTime = isPlayingRef.current ? getLiveTimelineTime() : currentTimeRef.current;
    const horizonSec = liveTime + AUDIO_PLAYER_MAX_BUFFER_SECONDS;
    const playbackRate = playbackRateRef.current;
    let nextPlay = nextPlayTimeRef.current;
    let cursor = scheduleCursorRef.current;
    let firstChunkSeekTime = seekTimeSec;

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
    pruneBufferedAudio();
  }, [ensureAudioBuffer, getLiveTimelineTime, pruneBufferedAudio, registerSource]);

  const replayFromOffset = useCallback(async (seekTimeSec: number, shouldPlay: boolean) => {
    const ctx = getContext();
    const clampedSeek = clamp(seekTimeSec, 0, totalDurationRef.current);
    const operation = ++playbackOperationRef.current;

    interruptedRef.current = true;
    stopAllNodes();
    nextPlayTimeRef.current = 0;
    scheduleCursorRef.current = findChunkIndexAtTime(clampedSeek);
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
    pruneBufferedAudio();
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
    pruneBufferedAudio();
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
    setCurrentTime(restoredTime);
    updateActiveSegment(restoredTime);
    pruneBufferedAudio();
  }, [cancelTimelineStateFlush, findChunkIndexAtTime, pruneBufferedAudio, stopAllNodes, updateActiveSegment]);

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
    timelineAnchorRef.current = 0;
    contextAnchorRef.current = 0;
    interruptedRef.current = false;
    autoPlayOnChunkRef.current = true;
    streamCompleteRef.current = true;
    setError(null);

    setSegments([]);
    setActiveSegmentId(null);

    setIsPlaying(false);
    isPlayingRef.current = false;

    syncCurrentTime(0);
    syncTotalDuration(0);
  }, [cancelTimelineStateFlush, stopAllNodes, syncCurrentTime, syncTotalDuration]);

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
    setActiveSegmentId(null);
  }, [stopAllNodes, syncCurrentTime]);

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
    currentTime,
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
