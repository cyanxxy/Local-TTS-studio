import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type {
  LocalTtsAudioChunkEvent,
  LocalTtsGenerateResult,
  LocalTtsProgressEvent,
  LocalTtsProbeResult,
} from "../electron";
import { MIN_TEXT_LENGTH } from "../constants";
import { useQwen3Runtime } from "../contexts/Qwen3RuntimeContext";
import type { TextChunk } from "../lib/chunking";
import { buildQwen3RequestPlan } from "../lib/qwenChunking";
import { scheduleNextUiFrame } from "../lib/uiScheduling";
import type { EngineRuntime, SynthesisRequest } from "../shared/engineRuntime";
import type { GenerationStats, ModelState } from "../types";
import {
  QWEN3_AUDIO_DELIVERY_GRACE_MS,
  QWEN3_SECTION_JOIN_PAUSE_SEC,
  isPlayableQwen3Chunk,
  isQwen3ReferenceCacheMiss,
  qwen3BasePayload,
  qwen3ErrorMessage as message,
  qwen3PlaybackSamples as playbackSamples,
  qwen3ReferencePayload,
  qwen3RequestId as requestId,
  streamQwen3Synthesis,
} from "./qwen3Synthesis";
import type { UseAudioPlayerReturn } from "./useAudioPlayer";
import { useSynthesisQueue } from "./useSynthesisQueue";
import {
  MAX_LOCAL_TTS_TEXT_LENGTH,
  exceedsUnicodeScalarLimit,
} from "../../electron/localTtsLimits";

interface UseQwen3LocalRuntimeOptions {
  enabled: boolean;
  text: string;
  allowLongText?: boolean;
  player: UseAudioPlayerReturn;
  setShowPlayer: (showPlayer: boolean) => void;
}

interface ReceivedAudioChunk {
  audio: ArrayBuffer;
  sampleCount: number;
  silenceAfterSamples: number;
  textUnitIndex?: number;
  textUnitTotal?: number;
}

interface PendingAudioDelivery {
  requestId: string;
  generationVersion: number;
  expectedChunkCount: number;
  timeoutId: number;
  resolve: () => void;
  reject: (error: Error) => void;
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

export function useQwen3LocalRuntime({
  enabled,
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
  const [, setProgress] = useState<LocalTtsProgressEvent | null>(null);
  const [result, setResult] = useState<LocalTtsGenerateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const runtimeVersionRef = useRef(0);
  const generationVersionRef = useRef(0);
  const activeRequestRef = useRef<string | null>(null);
  const activeRequestVersionRef = useRef<number | null>(null);
  const activeProbeRef = useRef<string | null>(null);
  // Retain PCM only until an in-order chunk has been handed to the player.
  // A Set tracks delivery without keeping a second reference to every buffer.
  const pendingChunksRef = useRef(new Map<number, ReceivedAudioChunk>());
  const receivedChunkIndexesRef = useRef(new Set<number>());
  const sampleRateRef = useRef<number | null>(null);
  const scheduledCountRef = useRef(0);
  const activeRequestUnitOffsetRef = useRef(0);
  const activeRequestUnitCountRef = useRef(1);
  const pendingProgressRef = useRef<LocalTtsProgressEvent | null>(null);
  const cancelProgressFlushRef = useRef<(() => void) | null>(null);
  const pendingAudioDeliveryRef = useRef<PendingAudioDelivery | null>(null);
  // The player's content epoch when this runtime's generated audio entered it,
  // or null while the player holds nothing this runtime made.
  const ownedPlayerEpochRef = useRef<number | null>(null);
  const warmedKeyRef = useRef<string | null>(null);
  const warmingKeyRef = useRef<string | null>(null);
  const activeTextUnitsRef = useRef<TextChunk[]>([]);
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

  const settlePendingAudioDelivery = useCallback((error?: Error) => {
    const pending = pendingAudioDeliveryRef.current;
    if (!pending) return;
    pendingAudioDeliveryRef.current = null;
    window.clearTimeout(pending.timeoutId);
    if (error) pending.reject(error);
    else pending.resolve();
  }, []);

  const cancelPendingAudioDelivery = useCallback(() => {
    // Cancellation/version checks after the await decide whether the job should
    // continue. Resolving here simply prevents an obsolete request from waiting
    // for an event that the native bridge will no longer send.
    settlePendingAudioDelivery();
  }, [settlePendingAudioDelivery]);

  const waitForAudioDelivery = useCallback((
    activeRequestId: string,
    generationVersion: number,
    expectedChunkCount: number,
  ): Promise<void> => {
    if (receivedChunkIndexesRef.current.size === expectedChunkCount) {
      return Promise.resolve();
    }

    cancelPendingAudioDelivery();
    return new Promise<void>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        const pending = pendingAudioDeliveryRef.current;
        if (
          pending?.requestId !== activeRequestId
          || pending.generationVersion !== generationVersion
        ) return;
        settlePendingAudioDelivery(
          new Error("Generation returned incomplete streamed audio."),
        );
      }, QWEN3_AUDIO_DELIVERY_GRACE_MS);
      pendingAudioDeliveryRef.current = {
        requestId: activeRequestId,
        generationVersion,
        expectedChunkCount,
        timeoutId,
        resolve,
        reject,
      };
    });
  }, [cancelPendingAudioDelivery, settlePendingAudioDelivery]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelPendingAudioDelivery();
    };
  }, [cancelPendingAudioDelivery]);

  // Empties the shared player and forgets the streamed audio bookkeeping. It
  // touches no React state, so the settings effect below can call it.
  const releasePlayerAudio = useCallback(() => {
    pendingChunksRef.current.clear();
    receivedChunkIndexesRef.current.clear();
    sampleRateRef.current = null;
    scheduledCountRef.current = 0;
    activeRequestUnitOffsetRef.current = 0;
    activeRequestUnitCountRef.current = 1;
    activeTextUnitsRef.current = [];
    resetPlayer();
    ownedPlayerEpochRef.current = null;
  }, [resetPlayer]);

  const clearGeneratedResult = useCallback(() => {
    releasePlayerAudio();
    setResult(null);
    setProgress(null);
    setGenerationProgress(0);
  }, [releasePlayerAudio]);

  const cancelActiveGeneration = useCallback(() => {
    const active = activeRequestRef.current;
    if (!active || !bridge) return;
    stopAll();
    void Promise.resolve(bridge.cancel({ model: LOCAL_MODEL, requestId: active })).catch(() => undefined);
  }, [bridge, stopAll]);

  const resetGeneratedAudio = useCallback(() => {
    generationVersionRef.current += 1;
    cancelPendingAudioDelivery();
    cancelActiveGeneration();
    activeRequestRef.current = null;
    activeRequestVersionRef.current = null;
    clearGeneratedResult();
    setShowPlayer(false);
    setError(null);
    setGenerateBusy(false);
    setGenerationProgress(0);
  }, [cancelActiveGeneration, cancelPendingAudioDelivery, clearGeneratedResult, setShowPlayer]);

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
    setProgress(null);
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
    cancelPendingAudioDelivery();
    cancelActiveGeneration();
    activeRequestRef.current = null;
    activeRequestVersionRef.current = null;
    pendingProgressRef.current = null;
    cancelProgressFlushRef.current?.();
    cancelProgressFlushRef.current = null;
    releaseStalePlayerAudio();
  }, [appliedAudibleSettings, cancelActiveGeneration, cancelPendingAudioDelivery]);

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
      setProgress(null);
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
    cancelPendingAudioDelivery();
    cancelProgressFlushRef.current?.();
    pendingProgressRef.current = null;
    cancelActiveGeneration();
    activeRequestRef.current = null;
    activeRequestVersionRef.current = null;
    activeProbeRef.current = null;
  }, [cancelActiveGeneration, cancelPendingAudioDelivery, enabled, fetchProbe]);

  useEffect(() => {
    if (!electronAvailable || generateBusy || !bridge?.warm) return;
    const path = settings.modelPath.trim();
    if (!path || settings.readiness === "missing") return;
    const key = `${settings.profile.repo}:${path}`;
    if (warmedKeyRef.current === key || warmingKeyRef.current === key) return;
    warmingKeyRef.current = key;
    let active = true;
    void bridge.warm({
      model: LOCAL_MODEL,
      mode: settings.profile.mode,
      modelPath: path,
      modelRepo: settings.profile.repo,
    }).then((result) => {
      if (active && result.warmed) warmedKeyRef.current = key;
    }).catch(() => undefined).finally(() => {
      if (warmingKeyRef.current === key) warmingKeyRef.current = null;
    });
    return () => { active = false; };
  }, [bridge, electronAvailable, generateBusy, settings.modelPath, settings.profile, settings.readiness]);

  useEffect(() => {
    if (!electronAvailable || !bridge) return;
    return bridge.subscribeProgress((event) => {
      if (!mountedRef.current || event.model !== LOCAL_MODEL || event.requestId !== activeRequestRef.current) return;
      if (activeRequestVersionRef.current !== generationVersionRef.current) return;
      pendingProgressRef.current = event;
      cancelProgressFlushRef.current?.();
      cancelProgressFlushRef.current = scheduleNextUiFrame(() => {
        if (pendingProgressRef.current) setProgress(pendingProgressRef.current);
        pendingProgressRef.current = null;
      });
    });
  }, [bridge, electronAvailable]);

  useEffect(() => {
    if (!electronAvailable || !bridge) return;
    return bridge.subscribeAudioChunk((event: LocalTtsAudioChunkEvent) => {
      if (!mountedRef.current || event.model !== LOCAL_MODEL || event.requestId !== activeRequestRef.current) return;
      if (activeRequestVersionRef.current !== generationVersionRef.current) return;
      if (!isPlayableQwen3Chunk(event)) return;
      if (sampleRateRef.current !== event.sampleRate) {
        pendingChunksRef.current.clear();
        receivedChunkIndexesRef.current.clear();
        sampleRateRef.current = event.sampleRate;
        scheduledCountRef.current = 0;
      }
      if (!receivedChunkIndexesRef.current.has(event.index)) {
        receivedChunkIndexesRef.current.add(event.index);
        pendingChunksRef.current.set(event.index, {
          audio: event.audio,
          sampleCount: event.sampleCount,
          silenceAfterSamples: event.silenceAfterSamples,
          textUnitIndex: event.textUnitIndex,
          textUnitTotal: event.textUnitTotal,
        });
      }
      while (pendingChunksRef.current.has(scheduledCountRef.current)) {
        const index = scheduledCountRef.current++;
        const chunk = pendingChunksRef.current.get(index)!;
        pendingChunksRef.current.delete(index);
        const reportedUnitIndex = chunk.textUnitIndex
          ?? (event.total > 0 ? index : activeRequestUnitCountRef.current === 1 ? 0 : index);
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
          audio: playbackSamples(chunk),
          samplingRate: event.sampleRate,
          text: textUnit?.text ?? text,
          index: textUnitIndex + 1,
          total: activeTextUnitsRef.current.length || 1,
          textStart: textUnit?.start ?? 0,
          textEnd: textUnit?.end ?? text.length,
          pauseAfterSec: chunk.silenceAfterSamples / event.sampleRate,
        }).catch((nextError: unknown) => {
          if (mountedRef.current) setError(message(nextError));
        });
      }

      const pending = pendingAudioDeliveryRef.current;
      if (
        pending
        && pending.requestId === event.requestId
        && pending.generationVersion === generationVersionRef.current
        && receivedChunkIndexesRef.current.size === pending.expectedChunkCount
      ) {
        settlePendingAudioDelivery();
      }
    });
  }, [bridge, electronAvailable, scheduleChunk, settlePendingAudioDelivery, text]);

  useEffect(() => () => {
    cancelProgressFlushRef.current?.();
    cancelActiveGeneration();
  }, [cancelActiveGeneration]);

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

          const activateRequest = (nextId: string, progressMessage: string) => {
            id = nextId;
            pendingChunksRef.current.clear();
            receivedChunkIndexesRef.current.clear();
            scheduledCountRef.current = 0;
            activeRequestRef.current = nextId;
            activeRequestVersionRef.current = version;
            setProgress({
              requestId: nextId,
              model: LOCAL_MODEL,
              phase: "queued",
              message: progressMessage,
              elapsedSec: 0,
            });
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

          const sectionMessage = requestSections.length > 1
            ? `Generating Reader section ${sectionIndex + 1} of ${requestSections.length}.`
            : `Starting Qwen3 ${settings.profile.label} with ${settings.profile.provider}.`;
          const initiallyUploadsReference = settings.profile.mode === "voiceClone" && sectionIndex === 0;
          activateRequest(id, sectionMessage);
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
            activateRequest(
              requestId("generate"),
              `Restoring the voice reference for section ${sectionIndex + 1} of ${requestSections.length}.`,
            );
            generated = await generateSection(true);
          }
          if (
            !mountedRef.current
            || generationVersionRef.current !== version
            || activeRequestRef.current !== id
          ) return;
          await waitForAudioDelivery(id, version, generated.audioChunkCount);
          if (
            !mountedRef.current
            || generationVersionRef.current !== version
            || activeRequestRef.current !== id
          ) return;
          combinedResult = mergeGenerateResults(combinedResult, generated);
          activeSectionCompleted = true;

          // Rust only knows whether a unit is final within one IPC request.
          // The renderer owns the multi-request job, so it restores the natural
          // inter-unit pause between non-final request sections.
          if (sectionIndex < requestSections.length - 1) {
            const textUnitIndex = Math.max(section.unitStart, section.unitEnd - 1);
            const textUnit = activeTextUnitsRef.current[textUnitIndex];
            const pauseSamples = Math.max(
              1,
              Math.round(generated.sampleRate * QWEN3_SECTION_JOIN_PAUSE_SEC),
            );
            await scheduleChunk({
              audio: new Float32Array(pauseSamples),
              samplingRate: generated.sampleRate,
              text: textUnit?.text ?? section.text,
              index: textUnitIndex + 1,
              total: activeTextUnitsRef.current.length || 1,
              textStart: textUnit?.start ?? section.start,
              textEnd: textUnit?.end ?? section.end,
              pauseAfterSec: QWEN3_SECTION_JOIN_PAUSE_SEC,
              pauseKind: "sentence",
            });
            combinedResult = {
              ...combinedResult,
              durationSec: combinedResult.durationSec + QWEN3_SECTION_JOIN_PAUSE_SEC,
            };
          }
          setGenerationProgress(((sectionIndex + 1) / requestSections.length) * 100);
        }

        if (!combinedResult) throw new Error("Qwen3 did not return any generated audio.");
        setResult(combinedResult);
        endStream({ completed: true });
        setProgress(null);
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
          setProgress(null);
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
    waitForAudioDelivery,
  ]);

  const synthesize = useCallback((request: SynthesisRequest<"qwen3">) => queue.enqueue((signal) => {
    if (!bridge) throw new Error(BRIDGE_MISSING);
    return streamQwen3Synthesis(bridge, request, signal);
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
    cancelPendingAudioDelivery();
    if (activeRequestRef.current) cancelActiveGeneration();
    else stopAll();
    activeRequestRef.current = null;
    activeRequestVersionRef.current = null;
    pendingChunksRef.current.clear();
    receivedChunkIndexesRef.current.clear();
    sampleRateRef.current = null;
    scheduledCountRef.current = 0;
    pendingProgressRef.current = null;
    cancelProgressFlushRef.current?.();
    cancelProgressFlushRef.current = null;
    endStream();
    setProgress(null);
    setGenerateBusy(false);
    setError(null);
  }, [
    cancelActiveGeneration,
    cancelPendingAudioDelivery,
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
