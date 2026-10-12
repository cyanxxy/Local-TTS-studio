import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LocalTtsCacheInfo } from "../electron";
import type { StatusTone } from "../components/localRuntime/utils";
import { MIN_TEXT_LENGTH } from "../constants";
import type { EngineRuntime, SynthesisRequest } from "../shared/engineRuntime";
import type { GenerationStats, GenerationTuningSettings, ModelState } from "../types";
import { audio8ErrorMessage, audio8RequestId, streamAudio8Synthesis } from "./audio8Synthesis";
import type { UseAudioPlayerReturn } from "./useAudioPlayer";
import { useSynthesisQueue } from "./useSynthesisQueue";

interface Options {
  active: boolean;
  text: string;
  voice: string;
  /** Sampling for the surface generation; null fields leave the model's own. */
  sampling?: { seed: number | null; temperature: number | null };
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

export interface Audio8Runtime extends EngineRuntime<"audio8"> {
  cacheInfo: LocalTtsCacheInfo | null;
  cacheBusy: boolean;
  cacheStatus: CacheStatus | null;
  clearCache: () => void;
}

const INITIAL_STATE: ModelState = { ready: false, loading: false, downloadProgress: 0, error: null, backend: null };
const INITIAL_STATS: GenerationStats = { firstLatency: null, processingTime: 0, charsPerSec: 0, rtf: 0, totalDuration: 0, currentDuration: 0 };
const BRIDGE_MISSING = "Audio8 local inference requires the Electron app.";
const BRIDGE_MISSING_STATE: ModelState = { ...INITIAL_STATE, error: BRIDGE_MISSING };

export function useAudio8Runtime({ active, text, voice, sampling, generationSettings, player, setShowPlayer }: Options): Audio8Runtime {
  const [modelState, setModelState] = useState<ModelState>(INITIAL_STATE);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState(0);
  const [stats, setStats] = useState<GenerationStats>(INITIAL_STATS);
  const [error, setError] = useState<string | null>(null);
  const [cacheInfo, setCacheInfo] = useState<LocalTtsCacheInfo | null>(null);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheStatus, setCacheStatus] = useState<CacheStatus | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);
  // Aborting the running generation cancels its bridge request in flight.
  const activeGeneration = useRef<AbortController | null>(null);
  const generationAttempt = useRef<GenerationAttempt | null>(null);
  const loadAttempt = useRef<LoadAttempt | null>(null);
  const mounted = useRef(true);
  const bridge = window.electron?.audio8;
  // The player's functions are stable for its lifetime, so depending on them
  // (rather than on the player object, which changes with its state) keeps
  // every callback below stable while audio streams.
  const { beginStream, endStream, reset: resetPlayer, scheduleChunk, stopAll } = player;
  const { queue, busy: synthesisBusy, holdForeground } = useSynthesisQueue(isGenerating);

  // The preload bridge and the player's functions never change while the page
  // is open, so this runs its cleanup on unmount only.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      activeGeneration.current?.abort();
      activeGeneration.current = null;
      generationAttempt.current = null;
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
    if (!active || !bridge) return;
    // Reusing the in-flight (or settled) attempt is what makes reactivation
    // free. Switching to another model and back re-runs this effect, and
    // StrictMode double-invokes it in development; starting over each time
    // would issue a second 572 MiB download. Only `retryLoad` bumps the
    // revision, so only `retryLoad` starts a new attempt.
    if (loadAttempt.current?.revision === loadRevision) return;
    const attempt: LoadAttempt = { revision: loadRevision, requestId: audio8RequestId("load") };
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
      setModelState({ ...INITIAL_STATE, error: audio8ErrorMessage(cause) });
    });
  }, [active, bridge, loadRevision, refreshCacheInfo]);

  useEffect(() => {
    if (!active || !bridge) return;
    let current = true;
    // The size readout is informational, so a failed stat is ignored.
    bridge.getCacheInfo().then((info) => {
      if (current && mounted.current) setCacheInfo(info);
    }, () => undefined);
    return () => {
      current = false;
    };
  }, [active, bridge]);

  const cancelActiveGeneration = useCallback(() => {
    activeGeneration.current?.abort();
    activeGeneration.current = null;
    generationAttempt.current = null;
    setIsGenerating(false);
    endStream();
  }, [endStream]);

  useEffect(() => {
    if (!active && activeGeneration.current) cancelActiveGeneration();
  }, [active, cancelActiveGeneration]);

  const resetGeneratedAudio = useCallback(() => {
    cancelActiveGeneration();
    resetPlayer();
    setShowPlayer(false);
    setGenerationProgress(0);
    setStats(INITIAL_STATS);
    setError(null);
  }, [cancelActiveGeneration, resetPlayer, setShowPlayer]);

  // Without the preload bridge there is nothing to load; say why.
  const visibleModelState = bridge ? modelState : BRIDGE_MISSING_STATE;
  const canGenerate = visibleModelState.ready
    && !isGenerating
    && !synthesisBusy
    && text.trim().length >= MIN_TEXT_LENGTH;
  const handleGenerate = useCallback(() => {
    if (!canGenerate || !bridge) return;
    holdForeground();
    activeGeneration.current?.abort();
    const generation = new AbortController();
    activeGeneration.current = generation;
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
    const isCurrent = () => activeGeneration.current === generation;
    void (async () => {
      try {
        const passages = streamAudio8Synthesis(
          bridge,
          { text, voice, tuning: generationSettings, sampling },
          generation.signal,
          (requestId, chunkIndex, chunkCount) => {
            generationAttempt.current = { requestId, chunkIndex, chunkCount };
          },
        );
        for await (const passage of passages) {
          if (!isCurrent()) return;
          await scheduleChunk(passage);
          const playedSeconds = passage.audio.length / passage.samplingRate;
          synthesizedSeconds += playedSeconds - (passage.pauseAfterSec ?? 0);
          playbackSeconds += playedSeconds;
          processedCharacters += passage.text.length;
          const elapsed = (performance.now() - started) / 1000;
          firstLatency ??= elapsed;
          setGenerationProgress((passage.index / passage.total) * 100);
          setStats({ firstLatency, processingTime: elapsed, charsPerSec: processedCharacters / elapsed, rtf: elapsed / synthesizedSeconds, totalDuration: playbackSeconds, currentDuration: playbackSeconds });
        }
        if (isCurrent()) {
          activeGeneration.current = null;
          generationAttempt.current = null;
          setIsGenerating(false);
          endStream({ completed: true });
        }
      } catch (cause) {
        if (!isCurrent()) return;
        activeGeneration.current = null;
        generationAttempt.current = null;
        setIsGenerating(false);
        endStream();
        setError(audio8ErrorMessage(cause));
      }
    })();
  }, [
    beginStream,
    bridge,
    canGenerate,
    endStream,
    generationSettings,
    holdForeground,
    resetPlayer,
    sampling,
    scheduleChunk,
    setShowPlayer,
    text,
    voice,
  ]);

  const synthesize = useCallback((request: SynthesisRequest<"audio8">) => queue.enqueue((signal) => {
    if (!bridge) throw new Error(BRIDGE_MISSING);
    return streamAudio8Synthesis(
      bridge,
      {
        text: request.text,
        voice: request.settings.voice,
        tuning: request.tuning,
        sampling: {
          seed: request.seed ?? request.settings.seed,
          temperature: request.settings.temperature,
        },
      },
      signal,
    );
  }, request.signal), [bridge, queue]);

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
        if (mounted.current) setCacheStatus({ tone: "error", text: audio8ErrorMessage(cause) });
      })
      .finally(() => {
        if (mounted.current) setCacheBusy(false);
      });
  }, [bridge, cacheBusy, cancelActiveGeneration, refreshCacheInfo]);

  return useMemo(() => ({ id: "audio8", modelState: visibleModelState, canGenerate, isGenerating, generationProgress, stats, error, handleGenerate, handleStop, cancelActiveGeneration, resetGeneratedAudio, retryLoad, synthesize, cacheInfo, cacheBusy, cacheStatus, clearCache }), [visibleModelState, canGenerate, isGenerating, generationProgress, stats, error, handleGenerate, handleStop, cancelActiveGeneration, resetGeneratedAudio, retryLoad, synthesize, cacheInfo, cacheBusy, cacheStatus, clearCache]);
}
