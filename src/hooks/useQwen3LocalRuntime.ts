import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type {
  LocalTtsGenerateResult,
  LocalTtsProbeResult,
} from "../electron";
import { MIN_TEXT_LENGTH } from "../constants";
import { useQwen3Runtime } from "../contexts/Qwen3RuntimeContext";
import type { TextChunk } from "../lib/chunking";
import { createLocalAudioAssembler } from "../lib/localTtsStream";
import { buildQwen3RequestPlan } from "../lib/qwenChunking";
import type { EngineRuntime, SynthesisRequest } from "../shared/engineRuntime";
import type { GenerationStats, ModelState } from "../types";
import {
  isQwen3ReferenceCacheMiss,
  qwen3BasePayload,
  qwen3ErrorMessage as message,
  qwen3ReferencePayload,
  qwen3RequestId as requestId,
  streamQwen3Synthesis,
} from "./qwen3Synthesis";
import type { UseAudioPlayerReturn } from "./useAudioPlayer";
import { useQwen3Warmup } from "./useQwen3Warmup";
import { useSynthesisQueue } from "./useSynthesisQueue";
import {
  MAX_LOCAL_TTS_TEXT_LENGTH,
  exceedsUnicodeScalarLimit,
} from "../../electron/localTtsLimits";

interface UseQwen3LocalRuntimeOptions {
  enabled: boolean;
  /**
   * A surface selects Qwen3, on screen or not. The main process then keeps its
   * model resident instead of evicting it after a minute of idling. Defaults
   * to `enabled`.
   */
  retain?: boolean;
  text: string;
  allowLongText?: boolean;
  player: UseAudioPlayerReturn;
  setShowPlayer: (showPlayer: boolean) => void;
}

const LOCAL_MODEL = "qwen3";
const BRIDGE_MISSING = "Qwen3 local inference requires the Electron app.";

function sameItems(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((item, index) => Object.is(item, right[index]));
}

function mergeGenerateResults(
  current: LocalTtsGenerateResult | null,
  next: LocalTtsGenerateResult,
): LocalTtsGenerateResult {
  if (!current) return next;
  if (current.sampleRate !== next.sampleRate) {
    throw new Error("Qwen3 returned inconsistent sample rates between Reader sections.");
  }

  const phaseTimingsSec = { ...current.phaseTimingsSec };
  for (const [phase, seconds] of Object.entries(next.phaseTimingsSec)) {
    phaseTimingsSec[phase] = (phaseTimingsSec[phase] ?? 0) + seconds;
  }
  const warnings = [...new Set([...(current.warnings ?? []), ...(next.warnings ?? [])])];

  return {
    ...current,
    ...next,
    durationSec: current.durationSec + next.durationSec,
    elapsedSec: current.elapsedSec + next.elapsedSec,
    audioChunkCount: current.audioChunkCount + next.audioChunkCount,
    phaseTimingsSec,
    ...(warnings.length > 0 ? { warnings } : { warnings: undefined }),
  };
}

/** The main process's 500 ms admission window, plus a margin for the round trip. */
export const QWEN3_ADMISSION_COOLDOWN_MS = 600;

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function useQwen3LocalRuntime({
  enabled,
  retain = enabled,
  text,
  allowLongText = false,
  player,
  setShowPlayer,
}: UseQwen3LocalRuntimeOptions): EngineRuntime<"qwen3"> {
  const settings = useQwen3Runtime();
  const refreshSetup = settings.refreshSetup;
  const [runtime, setRuntime] = useState<LocalTtsProbeResult | null>(null);
  // A probe the user asked for again. The first probe after enabling is not
  // stored here: it is pending until `probeSettled`, so the effect that starts
  // it writes no state.
  const [probeRefreshing, setProbeRefreshing] = useState(false);
  const [probeSettled, setProbeSettled] = useState(false);
  const [wasEnabled, setWasEnabled] = useState(enabled);
  const [generateBusy, setGenerateBusy] = useState(false);
  const [generationProgress, setGenerationProgress] = useState(0);
  const [result, setResult] = useState<LocalTtsGenerateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const runtimeVersionRef = useRef(0);
  const generationVersionRef = useRef(0);
  const activeRequestRef = useRef<string | null>(null);
  const activeRequestVersionRef = useRef<number | null>(null);
  const activeProbeRef = useRef<string | null>(null);
  // Puts streamed audio back in order and retains PCM only until an in-order
  // chunk has been handed to the player. It never changes, so the bridge
  // subscription below survives re-renders; its sink tracks the latest props.
  const [assembler] = useState(() => createLocalAudioAssembler());
  const activeRequestUnitOffsetRef = useRef(0);
  const activeRequestUnitCountRef = useRef(1);
  // The player's content epoch when this runtime's generated audio entered it,
  // or null while the player holds nothing this runtime made.
  const ownedPlayerEpochRef = useRef<number | null>(null);
  const activeTextUnitsRef = useRef<TextChunk[]>([]);
  // The label a chunk gets when the plan has no text unit for it. A ref, so a
  // keystroke does not resubscribe to the audio stream.
  const textRef = useRef(text);
  const bridge = window.electron?.localTts;
  const electronAvailable = enabled && !!bridge;
  const beginStream = player.beginStream;
  const endStream = player.endStream;
  const getAudioChunkCount = player.getAudioChunkCount;
  const getContentEpoch = player.getContentEpoch;
  const getPlaybackTime = player.getCurrentTime;
  const playerTotalDuration = player.totalDuration;
  const resetPlayer = player.reset;
  const scheduleChunk = player.scheduleChunk;
  const stopAll = player.stopAll;
  const truncateAudioChunks = player.truncateAudioChunks;
  const { queue, busy: synthesisBusy, holdForeground } = useSynthesisQueue(generateBusy);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Empties the shared player and forgets the streamed audio bookkeeping. It
  // touches no React state, so the settings effect below can call it.
  const releasePlayerAudio = useCallback(() => {
    assembler.reset();
    activeRequestUnitOffsetRef.current = 0;
    activeRequestUnitCountRef.current = 1;
    activeTextUnitsRef.current = [];
    resetPlayer();
    ownedPlayerEpochRef.current = null;
  }, [assembler, resetPlayer]);

  const clearGeneratedResult = useCallback(() => {
    releasePlayerAudio();
    setResult(null);
    setGenerationProgress(0);
  }, [releasePlayerAudio]);

  // Retires the running request: a new version makes the run ignore however
  // its request settles, so the main process's late "Generation cancelled."
  // rejection cannot clear or truncate audio a caller put in the player after
  // cancelling (a history replay, a picked take). It touches no React state,
  // so effects can call it. Returns whether a request was running.
  const abandonActiveRequest = useCallback((): boolean => {
    const active = activeRequestRef.current;
    if (!active || !bridge) return false;
    generationVersionRef.current += 1;
    activeRequestRef.current = null;
    activeRequestVersionRef.current = null;
    stopAll();
    void Promise.resolve(bridge.cancel({ model: LOCAL_MODEL, requestId: active })).catch(() => undefined);
    return true;
  }, [bridge, stopAll]);

  // The abandoned run skips its own cleanup, so this does it now.
  const cancelActiveGeneration = useCallback(() => {
    if (!abandonActiveRequest()) return;
    assembler.reset();
    endStream();
    setGenerateBusy(false);
  }, [abandonActiveRequest, assembler, endStream]);

  const resetGeneratedAudio = useCallback(() => {
    generationVersionRef.current += 1;
    abandonActiveRequest();
    activeRequestRef.current = null;
    activeRequestVersionRef.current = null;
    clearGeneratedResult();
    setShowPlayer(false);
    setError(null);
    setGenerateBusy(false);
    setGenerationProgress(0);
  }, [abandonActiveRequest, clearGeneratedResult, setShowPlayer]);

  // Generated audio, errors and progress belong to the exact synthesis
  // configuration that produced them, so any audible Qwen setting change
  // retires them and old speech is never presented as the new voice. This
  // hook's own state is adjusted while rendering; the bridge request and the
  // shared player live outside React and are released by the effect below.
  const audibleSettings: readonly unknown[] = [
    settings.instruct,
    settings.language,
    settings.maxNewTokens,
    settings.modelPath,
    settings.profile.mode,
    settings.profile.repo,
    // Compared by identity: never copy or scan a reference of up to 60 MB.
    settings.referenceAudioBase64,
    settings.referenceText,
    settings.seed,
    settings.speaker,
    settings.temperature,
    settings.topK,
  ];
  const [appliedAudibleSettings, setAppliedAudibleSettings] = useState(audibleSettings);
  if (!sameItems(appliedAudibleSettings, audibleSettings)) {
    setAppliedAudibleSettings(audibleSettings);
    setGenerateBusy(false);
    setError(null);
    setResult(null);
    setGenerationProgress(0);
  }

  // The shared player belongs to whichever engine drives the visible surface,
  // and Qwen3 settings are also edited from the Qwen3 setup page. The audio is
  // Qwen3's to clear only while Qwen3 drives the surface (restored Reader audio
  // included) or while the audio this runtime generated is still the player's.
  const releaseStalePlayerAudio = useEffectEvent(() => {
    const ownsPlayerAudio = ownedPlayerEpochRef.current !== null
      && ownedPlayerEpochRef.current === getContentEpoch();
    if (!enabled && !ownsPlayerAudio) return;
    releasePlayerAudio();
    setShowPlayer(false);
  });

  // Keyed on the applied settings, which change identity exactly when an
  // audible setting does.
  useEffect(() => {
    generationVersionRef.current += 1;
    abandonActiveRequest();
    activeRequestRef.current = null;
    activeRequestVersionRef.current = null;
    releaseStalePlayerAudio();
  }, [abandonActiveRequest, appliedAudibleSettings]);

  const fetchProbe = useCallback((): Promise<void> => {
    if (!enabled || !bridge) return Promise.resolve();
    const version = ++runtimeVersionRef.current;
    const id = requestId("probe");
    activeProbeRef.current = id;
    const isCurrent = () => (
      mountedRef.current && runtimeVersionRef.current === version && activeProbeRef.current === id
    );
    return bridge.probe({ model: LOCAL_MODEL, requestId: id })
      .then((next) => {
        if (!isCurrent()) return;
        setRuntime(next);
        setError(next.ready ? null : next.message);
      })
      .catch((nextError: unknown) => {
        if (!isCurrent()) return;
        setRuntime(null);
        setError(message(nextError));
      })
      .finally(() => {
        if (!isCurrent()) return;
        activeProbeRef.current = null;
        setProbeRefreshing(false);
        setProbeSettled(true);
      });
  }, [bridge, enabled]);

  const retryLoad = useCallback(() => {
    if (!enabled) return;
    if (bridge) setProbeRefreshing(true);
    setError(null);
    void Promise.allSettled([fetchProbe(), refreshSetup()]);
  }, [bridge, enabled, fetchProbe, refreshSetup]);

  // Turning the runtime off drops what an unfinished run left in state.
  if (wasEnabled !== enabled) {
    setWasEnabled(enabled);
    if (!enabled) {
      setProbeRefreshing(false);
      setProbeSettled(false);
      setGenerateBusy(false);
      setGenerationProgress(0);
    }
  }
  const runtimeBusy = probeRefreshing || (enabled && !!bridge && !probeSettled);

  // The provider reads the model inventory itself, so enabling only probes the
  // runtime; `retryLoad` is the explicit way to read both again.
  useEffect(() => {
    if (enabled) {
      void fetchProbe();
      return;
    }
    runtimeVersionRef.current += 1;
    generationVersionRef.current += 1;
    abandonActiveRequest();
    activeRequestRef.current = null;
    activeRequestVersionRef.current = null;
    activeProbeRef.current = null;
  }, [abandonActiveRequest, enabled, fetchProbe]);

  useQwen3Warmup(electronAvailable, generateBusy, settings);

  // A lease keeps the model resident in the main process for as long as a
  // surface selects it, across the idle pauses between generations. It loads
  // nothing: the pre-warm above does. Releasing the lease (the model is
  // deselected, or its folder changes) only returns it to the idle timer.
  const keepWarm = bridge?.keepWarm;
  const leaseModelPath = settings.modelPath.trim();
  const leaseRepo = settings.profile.repo;
  const leaseMode = settings.profile.mode;
  const leaseReady = settings.readiness !== "missing";
  useEffect(() => {
    if (!retain || !keepWarm || !leaseModelPath || !leaseReady) return;
    return keepWarm({ model: LOCAL_MODEL, modelRepo: leaseRepo, modelPath: leaseModelPath, mode: leaseMode });
  }, [keepWarm, leaseMode, leaseModelPath, leaseReady, leaseRepo, retain]);

  useEffect(() => {
    textRef.current = text;
  }, [text]);

  useEffect(() => {
    assembler.setSink((part) => {
      const reportedUnitIndex = part.textUnitIndex
        ?? (part.declaredTotal > 0 ? part.chunkIndex : activeRequestUnitCountRef.current === 1 ? 0 : part.chunkIndex);
      const localTextUnitIndex = Math.min(
        Math.max(0, reportedUnitIndex),
        Math.max(0, activeRequestUnitCountRef.current - 1),
      );
      const textUnitIndex = Math.min(
        activeRequestUnitOffsetRef.current + localTextUnitIndex,
        Math.max(0, activeTextUnitsRef.current.length - 1),
      );
      const textUnit = activeTextUnitsRef.current[textUnitIndex];
      void scheduleChunk({
        audio: part.samples,
        samplingRate: part.sampleRate,
        text: textUnit?.text ?? textRef.current,
        index: textUnitIndex + 1,
        total: activeTextUnitsRef.current.length || 1,
        textStart: textUnit?.start ?? 0,
        textEnd: textUnit?.end ?? textRef.current.length,
        pauseAfterSec: part.pauseAfterSec,
      }).catch((nextError: unknown) => {
        if (mountedRef.current) setError(message(nextError));
      });
    });
  }, [assembler, scheduleChunk]);

  useEffect(() => {
    if (!electronAvailable || !bridge) return;
    return bridge.subscribeAudioChunk((event) => {
      if (!mountedRef.current || event.model !== LOCAL_MODEL || event.requestId !== activeRequestRef.current) return;
      if (activeRequestVersionRef.current !== generationVersionRef.current) return;
      assembler.accept(event);
    });
  }, [assembler, bridge, electronAvailable]);

  useEffect(() => () => {
    abandonActiveRequest();
  }, [abandonActiveRequest]);

  const voiceDesignDescriptionMissing = settings.profile.mode === "voiceDesign"
    && settings.instruct.trim().length === 0;
  const settingsReady = settings.modelPath.trim().length > 0
    && settings.readiness !== "missing"
    && !voiceDesignDescriptionMissing
    && (settings.profile.mode !== "voiceClone"
      || (!!settings.referenceAudioBase64 && settings.referenceText.trim().length > 0));
  const ready = electronAvailable && (runtime?.ready ?? false) && settingsReady;
  const textTooLong = !allowLongText
    && exceedsUnicodeScalarLimit(text, MAX_LOCAL_TTS_TEXT_LENGTH);
  const combinedError = error
    ?? settings.error
    ?? (enabled && textTooLong
      ? `Qwen3 accepts at most ${MAX_LOCAL_TTS_TEXT_LENGTH.toLocaleString()} characters per request. Split this job into smaller sections.`
      : null)
    ?? (enabled && runtime?.ready && voiceDesignDescriptionMissing && !settings.setupBusy
      ? "Describe the VoiceDesign voice before generating."
      : null)
    ?? (enabled && runtime?.ready && !settingsReady && !settings.setupBusy
      ? "Select or download a valid Qwen3 model directory before generating."
      : null);
  const modelState = useMemo<ModelState>(() => ({
    ready,
    loading: enabled && (runtimeBusy || settings.setupBusy),
    downloadProgress: ready ? 100 : runtimeBusy || settings.setupBusy ? 25 : 0,
    error: combinedError,
    backend: null,
  }), [combinedError, enabled, ready, runtimeBusy, settings.setupBusy]);
  const canGenerate = ready
    && !generateBusy
    && !synthesisBusy
    && !textTooLong
    && text.trim().length >= MIN_TEXT_LENGTH;

  const stats = useMemo<GenerationStats>(() => {
    const processingTime = result?.elapsedSec ?? 0;
    return {
      firstLatency: null,
      processingTime,
      charsPerSec: processingTime > 0 ? text.trim().length / processingTime : 0,
      rtf: result && result.durationSec > 0 ? result.elapsedSec / result.durationSec : 0,
      totalDuration: playerTotalDuration || result?.durationSec || 0,
      // Sampled rather than tracked: the live position ticks every frame and no
      // consumer renders this field, so depending on it would rebuild the stats
      // object (and re-render every consumer) 60 times a second for nothing.
      currentDuration: getPlaybackTime(),
    };
  }, [getPlaybackTime, playerTotalDuration, result, text]);

  const handleGenerate = useCallback(() => {
    if (!canGenerate || !bridge) return;
    const version = generationVersionRef.current;
    const requestPlan = buildQwen3RequestPlan(text);
    const requestSections = requestPlan.sections;
    if (requestSections.length === 0) return;
    holdForeground();
    clearGeneratedResult();
    ownedPlayerEpochRef.current = getContentEpoch();
    // Every mode uses the units re-split from the exact IPC request text.
    activeTextUnitsRef.current = requestPlan.units;
    setShowPlayer(true);
    beginStream();
    setGenerateBusy(true);
    setGenerationProgress(0);
    setError(null);
    const jobId = requestId("job");
    const basePayload = qwen3BasePayload(settings, settings.seed);

    const runSections = async () => {
      let combinedResult: LocalTtsGenerateResult | null = null;
      let activeSectionIndex = 0;
      let activeSectionChunkCheckpoint = 0;
      let activeSectionCompleted = false;
      try {
        for (let sectionIndex = 0; sectionIndex < requestSections.length; sectionIndex += 1) {
          activeSectionIndex = sectionIndex;
          activeSectionCompleted = false;
          if (!mountedRef.current || generationVersionRef.current !== version) return;
          const section = requestSections[sectionIndex];
          let id = requestId("generate");
          activeRequestUnitOffsetRef.current = section.unitStart;
          activeRequestUnitCountRef.current = section.unitEnd - section.unitStart;
          activeSectionChunkCheckpoint = getAudioChunkCount();

          const activateRequest = (nextId: string) => {
            id = nextId;
            assembler.reset();
            activeRequestRef.current = nextId;
            activeRequestVersionRef.current = version;
          };
          const generateSection = (uploadReference: boolean) => bridge.generate({
            model: LOCAL_MODEL,
            requestId: id,
            continuation: {
              jobId,
              sectionIndex,
              sectionCount: requestSections.length,
            },
            payload: {
              ...basePayload,
              text: section.text,
              ...qwen3ReferencePayload(settings, jobId, uploadReference),
            },
          });

          const initiallyUploadsReference = settings.profile.mode === "voiceClone" && sectionIndex === 0;
          activateRequest(id);
          let generated: LocalTtsGenerateResult;
          try {
            generated = await generateSection(initiallyUploadsReference);
          } catch (sectionError: unknown) {
            const canRestoreReference = settings.profile.mode === "voiceClone"
              && !initiallyUploadsReference
              && isQwen3ReferenceCacheMiss(sectionError)
              && mountedRef.current
              && generationVersionRef.current === version
              && activeRequestRef.current === id;
            if (!canRestoreReference) throw sectionError;

            // A crash or eviction can replace the resident worker between
            // sections. Roll back anything attributed to the failed attempt,
            // then seed the new worker's cache once and retry this section.
            truncateAudioChunks(activeSectionChunkCheckpoint);
            activateRequest(requestId("generate"));
            generated = await generateSection(true);
          }
          if (
            !mountedRef.current
            || generationVersionRef.current !== version
            || activeRequestRef.current !== id
          ) return;
          // generate() settles only after the preload has delivered every
          // chunk of the request, so a shortfall is a failure, not a wait.
          if (assembler.receivedCount !== generated.audioChunkCount) {
            throw new Error("Generation returned incomplete streamed audio.");
          }
          combinedResult = mergeGenerateResults(combinedResult, generated);
          activeSectionCompleted = true;

          // Rust only knows whether a unit is final within one IPC request.
          // The renderer owns the multi-request job, so it restores the natural
          // inter-unit pause between non-final request sections, or the
          // longer one an inline pause asked for.
          if (section.pauseAfterSec > 0) {
            const textUnitIndex = Math.max(section.unitStart, section.unitEnd - 1);
            const textUnit = activeTextUnitsRef.current[textUnitIndex];
            const pauseSamples = Math.max(
              1,
              Math.round(generated.sampleRate * section.pauseAfterSec),
            );
            await scheduleChunk({
              audio: new Float32Array(pauseSamples),
              samplingRate: generated.sampleRate,
              text: textUnit?.text ?? section.text,
              index: textUnitIndex + 1,
              total: activeTextUnitsRef.current.length || 1,
              textStart: textUnit?.start ?? section.start,
              textEnd: textUnit?.end ?? section.end,
              pauseAfterSec: section.pauseAfterSec,
              pauseKind: "sentence",
            });
            combinedResult = {
              ...combinedResult,
              durationSec: combinedResult.durationSec + section.pauseAfterSec,
            };
          }
          setGenerationProgress(((sectionIndex + 1) / requestSections.length) * 100);
        }

        if (!combinedResult) throw new Error("Qwen3 did not return any generated audio.");
        setResult(combinedResult);
        endStream({ completed: true });
      } catch (nextError: unknown) {
        if (!mountedRef.current || generationVersionRef.current !== version) return;
        endStream();
        const nextMessage = message(nextError);
        const cancelled = /cancelled/i.test(nextMessage);
        if (!cancelled && !activeSectionCompleted) {
          truncateAudioChunks(activeSectionChunkCheckpoint);
        }
        if (combinedResult && !cancelled) {
          setResult(combinedResult);
          setShowPlayer(true);
          setError(
            requestSections.length > 1
              ? `Qwen3 stopped at section ${activeSectionIndex + 1} of ${requestSections.length}: ${nextMessage}`
              : nextMessage,
          );
        } else {
          clearGeneratedResult();
          setError(cancelled ? null : nextMessage);
        }
      } finally {
        if (mountedRef.current && generationVersionRef.current === version) {
          activeRequestRef.current = null;
          activeRequestVersionRef.current = null;
          setGenerateBusy(false);
        }
      }
    };
    void runSections();
  }, [
    assembler,
    beginStream,
    bridge,
    canGenerate,
    clearGeneratedResult,
    endStream,
    getAudioChunkCount,
    getContentEpoch,
    holdForeground,
    scheduleChunk,
    setShowPlayer,
    settings,
    text,
    truncateAudioChunks,
  ]);

  // The main process refuses a generation that starts within
  // QWEN3_ADMISSION_WINDOW_MS of the last one that finished, so every caller of
  // `synthesize` (look-ahead, audiobook export, previews) waits it out here
  // instead of each pacing itself. The surface generation counts too.
  const lastFinishedAtRef = useRef(0);
  const wasGeneratingRef = useRef(false);
  useEffect(() => {
    if (wasGeneratingRef.current && !generateBusy) lastFinishedAtRef.current = Date.now();
    wasGeneratingRef.current = generateBusy;
  }, [generateBusy]);

  const synthesize = useCallback((request: SynthesisRequest<"qwen3">) => queue.enqueue((signal) => {
    if (!bridge) throw new Error(BRIDGE_MISSING);
    return (async function* () {
      const wait = QWEN3_ADMISSION_COOLDOWN_MS - (Date.now() - lastFinishedAtRef.current);
      if (wait > 0) await waitFor(wait, signal);
      yield* streamQwen3Synthesis(bridge, request, signal);
      // Only a request that completed starts the window; a cancelled or failed
      // one clears it in the main process.
      lastFinishedAtRef.current = Date.now();
    })();
  }, request.signal), [bridge, queue]);

  const handleStop = useCallback(() => {
    const hasActiveGeneration = generateBusy || activeRequestRef.current !== null;
    if (!hasActiveGeneration) {
      // Finished audio belongs to the player until an explicit reset or a new
      // generation. Stopping playback must not throw that work away.
      stopAll();
      return;
    }

    generationVersionRef.current += 1;
    if (!abandonActiveRequest()) stopAll();
    activeRequestRef.current = null;
    activeRequestVersionRef.current = null;
    assembler.reset();
    endStream();
    setGenerateBusy(false);
    setError(null);
  }, [
    abandonActiveRequest,
    assembler,
    endStream,
    generateBusy,
    stopAll,
  ]);

  return useMemo(() => ({
    id: "qwen3",
    modelState,
    canGenerate,
    isGenerating: generateBusy,
    generationProgress,
    stats,
    error: combinedError,
    handleGenerate,
    handleStop,
    retryLoad,
    resetGeneratedAudio,
    cancelActiveGeneration,
    synthesize,
  }), [
    canGenerate,
    cancelActiveGeneration,
    combinedError,
    generateBusy,
    generationProgress,
    handleGenerate,
    handleStop,
    modelState,
    resetGeneratedAudio,
    retryLoad,
    stats,
    synthesize,
  ]);
}
