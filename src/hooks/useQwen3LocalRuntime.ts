import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  LocalTtsAudioChunkEvent,
  LocalTtsGenerateResult,
  LocalTtsProgressEvent,
  LocalTtsProbeResult,
} from "../electron";
import { MIN_TEXT_LENGTH } from "../constants";
import { useQwen3Runtime } from "../contexts/Qwen3RuntimeContext";
import type { TextChunk } from "../lib/chunking";
import { buildQwen3RequestSections, buildQwen3TextUnits } from "../lib/qwenChunking";
import { scheduleNextUiFrame } from "../lib/uiScheduling";
import type { GenerationStats, ModelState } from "../types";
import type { UseAudioPlayerReturn } from "./useAudioPlayer";
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

interface UseQwen3LocalRuntimeReturn {
  modelState: ModelState;
  canGenerate: boolean;
  isGenerating: boolean;
  generationProgress: number;
  stats: GenerationStats;
  error: string | null;
  handleGenerate: () => void;
  handleStop: () => void;
  retryLoad: () => void;
  resetGeneratedAudio: () => void;
  cancelActiveGeneration: () => void;
}

const LOCAL_MODEL = "qwen3";
const QWEN_SECTION_JOIN_PAUSE_SEC = 0.2;

function requestId(kind: "probe" | "generate" | "job"): string {
  return `${LOCAL_MODEL}-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function playbackSamples(chunk: ReceivedAudioChunk): Float32Array {
  const samples = new Float32Array(chunk.audio, 0, chunk.sampleCount);
  const output = new Float32Array(samples.length + Math.max(0, chunk.silenceAfterSamples));
  for (let index = 0; index < samples.length; index += 1) {
    output[index] = Number.isFinite(samples[index]) ? samples[index] : 0;
  }
  return output;
}

function message(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
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
}: UseQwen3LocalRuntimeOptions): UseQwen3LocalRuntimeReturn {
  const settings = useQwen3Runtime();
  const refreshSetup = settings.refreshSetup;
  const [runtime, setRuntime] = useState<LocalTtsProbeResult | null>(null);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
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
  const chunksRef = useRef<ReceivedAudioChunk[]>([]);
  const sampleRateRef = useRef<number | null>(null);
  const scheduledCountRef = useRef(0);
  const activeRequestUnitOffsetRef = useRef(0);
  const activeRequestUnitCountRef = useRef(1);
  const pendingProgressRef = useRef<LocalTtsProgressEvent | null>(null);
  const cancelProgressFlushRef = useRef<(() => void) | null>(null);
  const warmedKeyRef = useRef<string | null>(null);
  const warmingKeyRef = useRef<string | null>(null);
  const activeTextUnitsRef = useRef<TextChunk[]>([]);
  const bridge = window.electron?.localTts;
  const electronAvailable = enabled && !!bridge;
  const beginStream = player.beginStream;
  const endStream = player.endStream;
  const getAudioChunkCount = player.getAudioChunkCount;
  const resetPlayer = player.reset;
  const scheduleChunk = player.scheduleChunk;
  const stopAll = player.stopAll;
  const truncateAudioChunks = player.truncateAudioChunks;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const clearGeneratedResult = useCallback(() => {
    chunksRef.current = [];
    sampleRateRef.current = null;
    scheduledCountRef.current = 0;
    activeRequestUnitOffsetRef.current = 0;
    activeRequestUnitCountRef.current = 1;
    activeTextUnitsRef.current = [];
    resetPlayer();
    setResult(null);
    setProgress(null);
    setGenerationProgress(0);
  }, [resetPlayer]);

  const cancelActiveGeneration = useCallback(() => {
    const active = activeRequestRef.current;
    if (!active || !bridge) return;
    stopAll();
    void Promise.resolve(bridge.cancel({ model: LOCAL_MODEL, requestId: active })).catch(() => undefined);
  }, [bridge, stopAll]);

  const resetGeneratedAudio = useCallback(() => {
    generationVersionRef.current += 1;
    cancelActiveGeneration();
    activeRequestRef.current = null;
    activeRequestVersionRef.current = null;
    clearGeneratedResult();
    setShowPlayer(false);
    setError(null);
    setGenerateBusy(false);
    setGenerationProgress(0);
  }, [cancelActiveGeneration, clearGeneratedResult, setShowPlayer]);

  // Generated audio and errors belong to the exact synthesis configuration
  // that produced them. Clear the shared player when any audible Qwen setting
  // changes so old speech is never presented as the newly selected voice.
  useEffect(() => {
    generationVersionRef.current += 1;
    cancelActiveGeneration();
    activeRequestRef.current = null;
    activeRequestVersionRef.current = null;
    pendingProgressRef.current = null;
    cancelProgressFlushRef.current?.();
    cancelProgressFlushRef.current = null;
    setGenerateBusy(false);
    setError(null);
    clearGeneratedResult();
    setShowPlayer(false);
  }, [
    cancelActiveGeneration,
    clearGeneratedResult,
    setShowPlayer,
    settings.instruct,
    settings.language,
    settings.maxNewTokens,
    settings.modelPath,
    settings.profile.mode,
    settings.profile.repo,
    settings.referenceAudioBase64,
    settings.referenceText,
    settings.speaker,
    settings.temperature,
    settings.topK,
  ]);

  const runProbe = useCallback(async () => {
    if (!enabled || !bridge) return;
    const version = ++runtimeVersionRef.current;
    const id = requestId("probe");
    activeProbeRef.current = id;
    setRuntimeBusy(true);
    setError(null);
    try {
      const next = await bridge.probe({ model: LOCAL_MODEL, requestId: id });
      if (!mountedRef.current || runtimeVersionRef.current !== version || activeProbeRef.current !== id) return;
      setRuntime(next);
      if (!next.ready) setError(next.message);
    } catch (nextError) {
      if (!mountedRef.current || runtimeVersionRef.current !== version || activeProbeRef.current !== id) return;
      setRuntime(null);
      setError(message(nextError));
    } finally {
      if (mountedRef.current && runtimeVersionRef.current === version && activeProbeRef.current === id) {
        activeProbeRef.current = null;
        setRuntimeBusy(false);
      }
    }
  }, [bridge, enabled]);

  const retryLoad = useCallback(() => {
    if (!enabled) return;
    void Promise.allSettled([runProbe(), refreshSetup()]);
  }, [enabled, refreshSetup, runProbe]);

  useEffect(() => {
    if (enabled) {
      retryLoad();
      return;
    }
    runtimeVersionRef.current += 1;
    generationVersionRef.current += 1;
    cancelProgressFlushRef.current?.();
    pendingProgressRef.current = null;
    cancelActiveGeneration();
    activeRequestRef.current = null;
    activeRequestVersionRef.current = null;
    activeProbeRef.current = null;
    setRuntimeBusy(false);
    setGenerateBusy(false);
    setGenerationProgress(0);
    setProgress(null);
  }, [cancelActiveGeneration, enabled, retryLoad]);

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
      if (event.sampleCount <= 0 || event.audio.byteLength !== event.sampleCount * Float32Array.BYTES_PER_ELEMENT) return;
      if (event.index === 0 || sampleRateRef.current !== event.sampleRate) {
        chunksRef.current = [];
        sampleRateRef.current = event.sampleRate;
        scheduledCountRef.current = 0;
      }
      chunksRef.current[event.index] = {
        audio: event.audio,
        sampleCount: event.sampleCount,
        silenceAfterSamples: event.silenceAfterSamples,
        textUnitIndex: event.textUnitIndex,
        textUnitTotal: event.textUnitTotal,
      };
      const contiguous = chunksRef.current.slice(0, event.index + 1).filter((chunk): chunk is ReceivedAudioChunk => !!chunk);
      if (contiguous.length !== event.index + 1) return;
      while (scheduledCountRef.current < contiguous.length) {
        const index = scheduledCountRef.current++;
        const chunk = contiguous[index];
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
    });
  }, [bridge, electronAvailable, scheduleChunk, text]);

  useEffect(() => () => {
    cancelProgressFlushRef.current?.();
    cancelActiveGeneration();
  }, [cancelActiveGeneration]);

  const settingsReady = settings.modelPath.trim().length > 0
    && settings.readiness !== "missing"
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
    && !textTooLong
    && text.trim().length >= MIN_TEXT_LENGTH;

  const stats = useMemo<GenerationStats>(() => {
    const processingTime = result?.elapsedSec ?? 0;
    return {
      firstLatency: null,
      processingTime,
      charsPerSec: processingTime > 0 ? text.trim().length / processingTime : 0,
      rtf: result && result.durationSec > 0 ? result.elapsedSec / result.durationSec : 0,
      totalDuration: player.totalDuration || result?.durationSec || 0,
      currentDuration: player.currentTime,
    };
  }, [player.currentTime, player.totalDuration, result, text]);

  const handleGenerate = useCallback(() => {
    if (!canGenerate || !bridge) return;
    const version = generationVersionRef.current;
    const requestSections = buildQwen3RequestSections(text);
    if (requestSections.length === 0) return;
    clearGeneratedResult();
    activeTextUnitsRef.current = settings.profile.mode === "customVoice"
      ? buildQwen3TextUnits(text)
      : requestSections.map((section) => ({
        text: section.text,
        start: section.start,
        end: section.end,
        pauseAfterSec: section.pauseAfterSec,
        pauseKind: section.pauseKind,
      }));
    setShowPlayer(true);
    beginStream();
    setGenerateBusy(true);
    setGenerationProgress(0);
    setError(null);
    const jobId = requestId("job");
    const basePayload: Record<string, unknown> = {
      mode: settings.profile.mode,
      modelRepo: settings.profile.repo,
      modelPath: settings.modelPath.trim(),
      language: settings.language,
      temperature: settings.temperature,
      topK: settings.topK,
      maxNewTokens: settings.maxNewTokens,
    };
    if (settings.profile.mode === "customVoice") {
      basePayload.speaker = settings.speaker;
      basePayload.instruct = settings.instruct;
    }

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
          activeRequestUnitOffsetRef.current = settings.profile.mode === "customVoice"
            ? section.unitStart
            : sectionIndex;
          activeRequestUnitCountRef.current = settings.profile.mode === "customVoice"
            ? section.unitEnd - section.unitStart
            : 1;
          activeSectionChunkCheckpoint = getAudioChunkCount();

          const activateRequest = (nextId: string, progressMessage: string) => {
            id = nextId;
            chunksRef.current = [];
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
              ...(settings.profile.mode === "voiceClone"
                ? uploadReference
                  ? {
                      referenceAudioBase64: settings.referenceAudioBase64,
                      referenceText: settings.referenceText.trim(),
                      referenceCacheKey: jobId,
                    }
                  : { referenceCacheKey: jobId }
                : {}),
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
              && /reference cache entry was not found/i.test(message(sectionError))
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
          if (chunksRef.current.filter(Boolean).length !== generated.audioChunkCount) {
            throw new Error("Generation returned incomplete streamed audio.");
          }
          combinedResult = mergeGenerateResults(combinedResult, generated);
          activeSectionCompleted = true;

          // Rust only knows whether a unit is final within one IPC request.
          // The renderer owns the multi-request job, so it restores the natural
          // inter-unit pause between non-final request sections for both
          // CustomVoice and voice-clone streaming.
          if (sectionIndex < requestSections.length - 1) {
            const textUnitIndex = settings.profile.mode === "customVoice"
              ? Math.max(section.unitStart, section.unitEnd - 1)
              : sectionIndex;
            const textUnit = activeTextUnitsRef.current[textUnitIndex];
            const pauseSamples = Math.max(
              1,
              Math.round(generated.sampleRate * QWEN_SECTION_JOIN_PAUSE_SEC),
            );
            await scheduleChunk({
              audio: new Float32Array(pauseSamples),
              samplingRate: generated.sampleRate,
              text: textUnit?.text ?? section.text,
              index: textUnitIndex + 1,
              total: activeTextUnitsRef.current.length || 1,
              textStart: textUnit?.start ?? section.start,
              textEnd: textUnit?.end ?? section.end,
              pauseAfterSec: QWEN_SECTION_JOIN_PAUSE_SEC,
              pauseKind: "sentence",
            });
            combinedResult = {
              ...combinedResult,
              durationSec: combinedResult.durationSec + QWEN_SECTION_JOIN_PAUSE_SEC,
            };
          }
          setGenerationProgress(((sectionIndex + 1) / requestSections.length) * 100);
        }

        if (!combinedResult) throw new Error("Qwen3 did not return any generated audio.");
        setResult(combinedResult);
        endStream();
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
    scheduleChunk,
    setShowPlayer,
    settings,
    text,
    truncateAudioChunks,
  ]);

  const handleStop = useCallback(() => {
    generationVersionRef.current += 1;
    cancelActiveGeneration();
    activeRequestRef.current = null;
    activeRequestVersionRef.current = null;
    endStream();
    clearGeneratedResult();
    setGenerateBusy(false);
    setError(null);
  }, [cancelActiveGeneration, clearGeneratedResult, endStream]);

  return {
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
  };
}
