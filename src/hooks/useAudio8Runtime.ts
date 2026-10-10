import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LocalTtsCacheInfo } from "../electron";
import type { StatusTone } from "../components/localRuntime/utils";
import { MIN_TEXT_LENGTH } from "../constants";
import { concatFloat32Arrays, createSilence } from "../lib/audio";
import { resolvePauseSeconds, tuneChunkText } from "../lib/textTuning";
import { chunkAudio8Text } from "../models/audio8";
import type { GenerationStats, GenerationTuningSettings, ModelState } from "../types";
import type { UseAudioPlayerReturn } from "./useAudioPlayer";

interface Options {
  active: boolean;
  text: string;
  voice: string;
  generationSettings: GenerationTuningSettings;
  player: UseAudioPlayerReturn;
  setShowPlayer: (show: boolean) => void;
}

interface CacheStatus {
  tone: StatusTone;
  text: string;
}

/** One `bridge.load()` call, shared by every activation that observes it. */
interface LoadAttempt {
  revision: number;
  requestId: string;
}

interface GenerationAttempt {
  requestId: string;
  chunkIndex: number;
  chunkCount: number;
}

const INITIAL_STATE: ModelState = { ready: false, loading: false, downloadProgress: 0, error: null, backend: null };
const INITIAL_STATS: GenerationStats = { firstLatency: null, processingTime: 0, charsPerSec: 0, rtf: 0, totalDuration: 0, currentDuration: 0 };

function id(kind: string): string {
  return `audio8-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function errorMessage(error: unknown): string {
  // `ipcRenderer.invoke` wraps every main-process rejection as
  // "Error invoking remote method '<channel>': Error: <message>". The channel
  // name is noise to the reader, so strip the wrapper and keep the cause.
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

export function useAudio8Runtime({ active, text, voice, generationSettings, player, setShowPlayer }: Options) {
  const [modelState, setModelState] = useState<ModelState>(INITIAL_STATE);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState(0);
  const [stats, setStats] = useState<GenerationStats>(INITIAL_STATS);
  const [error, setError] = useState<string | null>(null);
  const [cacheInfo, setCacheInfo] = useState<LocalTtsCacheInfo | null>(null);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheStatus, setCacheStatus] = useState<CacheStatus | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);
  const generationVersion = useRef(0);
  const activeRequest = useRef<string | null>(null);
  const generationAttempt = useRef<GenerationAttempt | null>(null);
  const loadAttempt = useRef<LoadAttempt | null>(null);
  const mounted = useRef(true);
  const bridge = window.electron?.audio8;
  // The player's functions are stable for its lifetime, so depending on them
  // (rather than on the player object, which changes with its state) keeps
  // every callback below stable while audio streams.
  const { beginStream, endStream, reset: resetPlayer, scheduleChunk, stopAll } = player;

  // The preload bridge and the player's functions never change while the page
  // is open, so this runs its cleanup on unmount only.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generationVersion.current += 1;
      const requestId = activeRequest.current;
      activeRequest.current = null;
      generationAttempt.current = null;
      if (requestId && bridge) void bridge.cancel({ requestId }).catch(() => undefined);
      endStream();
    };
  }, [bridge, endStream]);

  const refreshCacheInfo = useCallback(async () => {
    if (!bridge) return;
    try {
      const info = await bridge.getCacheInfo();
      if (mounted.current) setCacheInfo(info);
    } catch {
      // The size readout is informational. A failed stat must not be presented
      // as a synthesis failure, and must not hide a model that loads fine.
    }
  }, [bridge]);

  // Download progress belongs to the load that is running, not to the effect
  // pass that started it: subscribing once for the lifetime of the bridge means
  // a load stays observable across a deactivate/reactivate cycle.
  useEffect(() => {
    if (!bridge) return;
    return bridge.subscribeProgress((event) => {
      if (loadAttempt.current?.requestId === event.requestId) {
        setModelState((state) => state.ready
          ? state
          : { ...state, loading: true, downloadProgress: event.percent, error: null });
        return;
      }
      const generation = generationAttempt.current;
      if (generation?.requestId !== event.requestId) return;
      const chunkProgress = Math.max(0, Math.min(100, event.percent)) / 100;
      setGenerationProgress(((generation.chunkIndex + chunkProgress) / generation.chunkCount) * 100);
    });
  }, [bridge]);

  useEffect(() => {
    if (!active) return;
    if (!bridge) {
      setModelState({ ...INITIAL_STATE, error: "Audio8 local inference requires the Electron app." });
      return;
    }
    // Reusing the in-flight (or settled) attempt is what makes reactivation
    // free. Switching to another model and back re-runs this effect, and
    // StrictMode double-invokes it in development; starting over each time
    // would issue a second 572 MiB download. Only `retryLoad` bumps the
    // revision, so only `retryLoad` starts a new attempt.
    if (loadAttempt.current?.revision === loadRevision) return;
    const attempt: LoadAttempt = { revision: loadRevision, requestId: id("load") };
    loadAttempt.current = attempt;
    setModelState({ ...INITIAL_STATE, loading: true });
    // Deliberately not cancelled on deactivate or unmount: the download is
    // shared process-wide and abandoning it mid-way would waste everything
    // already fetched. The attempt keeps reporting into state either way, so
    // a load that fails while Audio8 is deselected still surfaces its error
    // instead of leaving the runtime stuck on `loading`.
    void bridge.load({ requestId: attempt.requestId }).then(() => {
      if (!mounted.current || loadAttempt.current !== attempt) return;
      setModelState({ ready: true, loading: false, downloadProgress: 100, error: null, backend: null });
      void refreshCacheInfo();
    }, (cause: unknown) => {
      if (!mounted.current || loadAttempt.current !== attempt) return;
      setModelState({ ...INITIAL_STATE, error: errorMessage(cause) });
    });
  }, [active, bridge, loadRevision, refreshCacheInfo]);

  useEffect(() => {
    if (active) void refreshCacheInfo();
  }, [active, refreshCacheInfo]);

  const cancelActiveGeneration = useCallback(() => {
    generationVersion.current += 1;
    const requestId = activeRequest.current;
    activeRequest.current = null;
    generationAttempt.current = null;
    if (requestId && bridge) void bridge.cancel({ requestId }).catch(() => undefined);
    setIsGenerating(false);
    endStream();
  }, [bridge, endStream]);

  useEffect(() => {
    if (!active && activeRequest.current) cancelActiveGeneration();
  }, [active, cancelActiveGeneration]);

  const resetGeneratedAudio = useCallback(() => {
    cancelActiveGeneration();
    resetPlayer();
    setShowPlayer(false);
    setGenerationProgress(0);
    setStats(INITIAL_STATS);
    setError(null);
  }, [cancelActiveGeneration, resetPlayer, setShowPlayer]);

  const canGenerate = modelState.ready && !isGenerating && text.trim().length >= MIN_TEXT_LENGTH;
  const handleGenerate = useCallback(() => {
    if (!canGenerate || !bridge) return;
    const version = ++generationVersion.current;
    const started = performance.now();
    let synthesizedSeconds = 0;
    let playbackSeconds = 0;
    let processedCharacters = 0;
    let firstLatency: number | null = null;
    setIsGenerating(true);
    setGenerationProgress(0);
    setStats(INITIAL_STATS);
    setError(null);
    resetPlayer();
    beginStream();
    setShowPlayer(true);
    // The same passages the Reader previews for Audio8.
    const chunks = chunkAudio8Text(text);
    void (async () => {
      try {
        for (let index = 0; index < chunks.length; index += 1) {
          if (version !== generationVersion.current) return;
          const chunk = chunks[index];
          const requestId = id("generate");
          activeRequest.current = requestId;
          generationAttempt.current = { requestId, chunkIndex: index, chunkCount: chunks.length };
          const tuned = tuneChunkText(chunk.text, generationSettings.pronunciationRules ?? [], generationSettings.emphasisStrength ?? 0);
          const result = await bridge.generate({ requestId, text: tuned, voice });
          if (version !== generationVersion.current) return;
          // `Audio8GenerateResult` promises both fields, but nothing validates
          // the payload as it crosses IPC — the declaration is the renderer's
          // assertion about the main process, not a checked contract. Both
          // failures are silent rather than loud without this guard:
          // `new Float32Array(undefined)` yields an empty array, and a zero
          // sample rate turns every derived duration into NaN. A generation
          // that "succeeds" with no audio is the worst outcome here.
          if (!(result.audio instanceof ArrayBuffer) || !result.sampleRate) throw new Error("Audio8 returned invalid local audio.");
          const generated = new Float32Array(result.audio);
          const pauseSec = index + 1 === chunks.length ? 0 : resolvePauseSeconds(chunk.pauseKind, chunk.pauseAfterSec, generationSettings.pauseOverridesSec);
          const audio = pauseSec > 0 ? concatFloat32Arrays([generated, createSilence(pauseSec, result.sampleRate)]) : generated;
          await scheduleChunk({ audio, samplingRate: result.sampleRate, text: chunk.text, index: index + 1, total: chunks.length, textStart: chunk.start, textEnd: chunk.end, pauseAfterSec: pauseSec, pauseKind: chunk.pauseKind });
          synthesizedSeconds += generated.length / result.sampleRate;
          playbackSeconds += audio.length / result.sampleRate;
          processedCharacters += chunk.text.length;
          const elapsed = (performance.now() - started) / 1000;
          firstLatency ??= elapsed;
          setGenerationProgress(((index + 1) / chunks.length) * 100);
          setStats({ firstLatency, processingTime: elapsed, charsPerSec: processedCharacters / elapsed, rtf: elapsed / synthesizedSeconds, totalDuration: playbackSeconds, currentDuration: playbackSeconds });
        }
        if (version === generationVersion.current) {
          activeRequest.current = null;
          generationAttempt.current = null;
          setIsGenerating(false);
          endStream({ completed: true });
        }
      } catch (cause) {
        if (version !== generationVersion.current) return;
        activeRequest.current = null;
        generationAttempt.current = null;
        setIsGenerating(false);
        endStream();
        setError(errorMessage(cause));
      }
    })();
  }, [
    beginStream,
    bridge,
    canGenerate,
    endStream,
    generationSettings,
    resetPlayer,
    scheduleChunk,
    setShowPlayer,
    text,
    voice,
  ]);

  const handleStop = useCallback(() => {
    cancelActiveGeneration();
    stopAll();
  }, [cancelActiveGeneration, stopAll]);
  const retryLoad = useCallback(() => setLoadRevision((revision) => revision + 1), []);

  const clearCache = useCallback(() => {
    if (!bridge || cacheBusy) return;
    setCacheBusy(true);
    setCacheStatus({ tone: "info", text: "Clearing the Audio8 model cache…" });
    cancelActiveGeneration();
    void bridge.clearCache()
      .then(async (result) => {
        await refreshCacheInfo();
        if (!mounted.current) return;
        setModelState({
          ...INITIAL_STATE,
          error: "Audio8 is unloaded because its local cache was cleared. Retry to download it again.",
        });
        setCacheStatus(result.cleared
          ? { tone: "success", text: "Audio8 model cache cleared. Retry when you want to download it again." }
          : { tone: "info", text: "Audio8 was unloaded. No cached model files were found." });
      }, (cause: unknown) => {
        if (mounted.current) setCacheStatus({ tone: "error", text: errorMessage(cause) });
      })
      .finally(() => {
        if (mounted.current) setCacheBusy(false);
      });
  }, [bridge, cacheBusy, cancelActiveGeneration, refreshCacheInfo]);

  return useMemo(() => ({ modelState, canGenerate, isGenerating, generationProgress, stats, error, handleGenerate, handleStop, cancelActiveGeneration, resetGeneratedAudio, retryLoad, cacheInfo, cacheBusy, cacheStatus, clearCache }), [modelState, canGenerate, isGenerating, generationProgress, stats, error, handleGenerate, handleStop, cancelActiveGeneration, resetGeneratedAudio, retryLoad, cacheInfo, cacheBusy, cacheStatus, clearCache]);
}
