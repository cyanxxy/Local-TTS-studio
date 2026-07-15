import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  LocalTtsCacheInfo,
  LocalTtsAudioChunkEvent,
  LocalTtsGenerateResult,
  LocalTtsModel,
  LocalTtsProgressEvent,
  LocalTtsProbeResult,
} from "../electron";
import { useQwen3Runtime } from "../contexts/Qwen3RuntimeContext";
import type { GenerationStats } from "../types";
import { useAudioPlayer } from "../hooks/useAudioPlayer";
import { scheduleNextUiFrame } from "../lib/uiScheduling";
import {
  hasPrimaryShortcutModifier,
  isEditableShortcutTarget,
} from "../lib/appShortcuts";
import { AudioPlayer } from "./AudioPlayer";
import {
  LocalRuntimeModelInputs,
  LocalRuntimeQwenSetup,
} from "./localRuntime/LocalRuntimeModelInputs";
import { LocalRuntimeRuntimeSettings } from "./localRuntime/LocalRuntimeRuntimeSettings";
import { LocalRuntimeSidebar } from "./localRuntime/LocalRuntimeSidebar";
import {
  NEUTTS_OPTIONS,
  qwen3UsesVoiceClone,
} from "./localRuntime/modelOptions";
import {
  arrayBufferToBase64,
  float32ChunksToWavUrl,
  type StatusTone,
} from "./localRuntime/utils";

interface LocalRuntimePageProps {
  active?: boolean;
  model: LocalTtsModel;
  name: string;
  releaseDate: string;
  params: string;
  highlights: string[];
  links: Array<{ label: string; href: string }>;
  initialText?: string;
}

type StatusMessage = { tone: StatusTone; text: string } | null;

const DEFAULT_LOCAL_RUNTIME_TEXT = "Everything you hear is generated right here on this machine.";

interface ReceivedAudioChunk {
  audio: ArrayBuffer;
  sampleCount: number;
  silenceAfterSamples: number;
}

function buildPlaybackSamples(chunk: ReceivedAudioChunk): Float32Array {
  const samples = new Float32Array(chunk.audio, 0, chunk.sampleCount);
  const silenceAfterSamples = Math.max(0, chunk.silenceAfterSamples);
  const output = new Float32Array(samples.length + silenceAfterSamples);
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index];
    output[index] = Number.isFinite(value) ? value : 0;
  }
  return output;
}

function createLocalRequestId(model: LocalTtsModel): string {
  return `${model}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createProbeRequestId(model: LocalTtsModel): string {
  return `${model}-probe-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const GENERATION_TIMING_LABELS: Array<[string, string]> = [
  ["modelLoadSec", "load"],
  ["referenceEncodingSec", "reference"],
  ["firstAudioSec", "first audio"],
  ["inferenceSec", "inference"],
  ["outputEncodingSec", "encode"],
  ["transportEncodingSec", "transport"],
];

function formatGenerationStatus(generated: LocalTtsGenerateResult): string {
  const timings = GENERATION_TIMING_LABELS
    .map(([key, label]) => {
      const value = generated.phaseTimingsSec[key];
      return typeof value === "number" ? `${label} ${value.toFixed(2)}s` : null;
    })
    .filter((entry): entry is string => entry !== null);
  const suffix = timings.length > 0 ? ` (${timings.join(", ")})` : "";
  const device = generated.device ? ` on ${generated.device}` : "";
  const warning = generated.warnings?.[0] ? ` ${generated.warnings[0]}` : "";
  return `Generated ${generated.durationSec.toFixed(2)}s audio${device} in ${generated.elapsedSec.toFixed(2)}s${suffix}.${warning}`;
}

function formatStartingGenerationStatus(model: LocalTtsModel, profileLabel: string, provider: string): string {
  if (model !== "qwen3") return "Starting local generation...";
  return `Starting Qwen3 ${profileLabel} with ${provider}.`;
}

export function LocalRuntimePage({
  active = true,
  model,
  name,
  releaseDate,
  params,
  highlights,
  links,
  initialText,
}: LocalRuntimePageProps) {
  const qwen3 = useQwen3Runtime();
  const refreshSharedQwen3Setup = qwen3.refreshSetup;
  const [runtime, setRuntime] = useState<LocalTtsProbeResult | null>(null);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [cacheInfo, setCacheInfo] = useState<LocalTtsCacheInfo | null>(null);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [status, setStatus] = useState<StatusMessage>(null);
  const [text, setText] = useState(() => (
    initialText && initialText.trim().length > 0 ? initialText : DEFAULT_LOCAL_RUNTIME_TEXT
  ));

  const [neuttsModel, setNeuttsModel] = useState(NEUTTS_OPTIONS[0].value);
  const [referenceText, setReferenceText] = useState("");
  const [referenceAudioName, setReferenceAudioName] = useState("");
  const [referenceCodesBase64, setReferenceCodesBase64] = useState<string | null>(null);
  const [referenceWavBase64, setReferenceWavBase64] = useState<string | null>(null);
  const [referenceAudioGuidance, setReferenceAudioGuidance] = useState<StatusMessage>(null);

  const [qwen3ReferenceAudioGuidance, setQwen3ReferenceAudioGuidance] = useState<StatusMessage>(null);

  const [generateBusy, setGenerateBusy] = useState(false);
  const [generationProgress, setGenerationProgress] = useState<LocalTtsProgressEvent | null>(null);
  const [result, setResult] = useState<LocalTtsGenerateResult | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  const audioUrlRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pageVersionRef = useRef(0);
  const runtimeVersionRef = useRef(0);
  const generationVersionRef = useRef(0);
  const activeRequestIdRef = useRef<string | null>(null);
  const activeProbeRequestIdRef = useRef<string | null>(null);
  const activeRequestGenerationVersionRef = useRef<number | null>(null);
  const streamedAudioChunksRef = useRef<ReceivedAudioChunk[]>([]);
  const streamedAudioSampleRateRef = useRef<number | null>(null);
  const scheduledAudioChunkCountRef = useRef(0);
  const pendingGenerationProgressRef = useRef<LocalTtsProgressEvent | null>(null);
  const generationProgressFlushCancelRef = useRef<(() => void) | null>(null);
  const audioPlayer = useAudioPlayer();
  const {
    beginStream: beginAudioStream,
    download: downloadAudio,
    endStream: endAudioStream,
    reset: resetAudioPlayer,
    scheduleChunk: scheduleAudioChunk,
    stopAll: stopAudioPlayer,
  } = audioPlayer;

  const electronAvailable = !!window.electron?.localTts;
  const qwen3VoiceClone = qwen3UsesVoiceClone(qwen3.profile.repo);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
      }
    };
  }, []);

  const isCurrentPageVersion = useCallback((pageVersion: number) => (
    mountedRef.current && pageVersionRef.current === pageVersion
  ), []);

  const setNewAudioUrl = useCallback((nextUrl: string) => {
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
    }
    audioUrlRef.current = nextUrl;
    setAudioUrl(nextUrl);
  }, []);

  const clearGeneratedResult = useCallback(() => {
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
    streamedAudioChunksRef.current = [];
    streamedAudioSampleRateRef.current = null;
    scheduledAudioChunkCountRef.current = 0;
    resetAudioPlayer();
    setAudioUrl(null);
    setResult(null);
  }, [resetAudioPlayer]);

  const invalidateGeneration = useCallback((options: { runtimeChanged?: boolean } = {}) => {
    generationVersionRef.current += 1;
    const activeRequestId = activeRequestIdRef.current;
    if (generateBusy && activeRequestId && window.electron?.localTts) {
      void window.electron.localTts.cancel({ model, requestId: activeRequestId }).catch(() => undefined);
    }
    clearGeneratedResult();
    setGenerationProgress(null);

    if (options.runtimeChanged) {
      setRuntime(null);
      setStatus({
        tone: "info",
        text: "Runtime settings changed. Re-check the Rust runtime before generating again.",
      });
    } else if (generateBusy) {
      setStatus({
        tone: "info",
        text: "Inputs changed. The current generation is now outdated.",
      });
    }
  }, [clearGeneratedResult, generateBusy, model]);

  const cancelActiveGeneration = useCallback(async (nextStatusText: string = "Cancelling generation…") => {
    const requestId = activeRequestIdRef.current;
    if (!requestId || !window.electron?.localTts) return false;

    stopAudioPlayer();
    setStatus({ tone: "info", text: nextStatusText });
    setGenerationProgress({
      requestId,
      model,
      phase: "cancelling",
      message: nextStatusText,
    });

    try {
      await window.electron.localTts.cancel({ model, requestId });
      return true;
    } catch (err) {
      if (!mountedRef.current) return false;
      setStatus({ tone: "error", text: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }, [model, stopAudioPlayer]);

  const refreshCacheInfo = useCallback(async (pageVersion: number = pageVersionRef.current) => {
    if (!window.electron?.localTts) return;
    const info = await window.electron.localTts.getCacheInfo({ model });
    if (!isCurrentPageVersion(pageVersion)) return;
    setCacheInfo(info);
  }, [isCurrentPageVersion, model]);

  const refreshQwen3Setup = useCallback(async () => {
    if (model !== "qwen3") return;
    try {
      await refreshSharedQwen3Setup();
    } catch (err) {
      setStatus({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    }
  }, [model, refreshSharedQwen3Setup]);

  const runProbe = useCallback(async (pageVersion: number = pageVersionRef.current) => {
    if (!window.electron?.localTts) return;
    runtimeVersionRef.current += 1;
    const runtimeVersion = runtimeVersionRef.current;
    const requestId = createProbeRequestId(model);

    setRuntimeBusy(true);
    setGenerationProgress(null);
    setStatus({ tone: "info", text: "Checking local runtime…" });
    activeProbeRequestIdRef.current = requestId;
    try {
      const probe = await window.electron.localTts.probe({
        model,
        requestId,
      });
      if (
        !isCurrentPageVersion(pageVersion)
        || runtimeVersionRef.current !== runtimeVersion
        || activeProbeRequestIdRef.current !== requestId
      ) return;
      setRuntime(probe);
      setStatus({
        tone: probe.ready ? "success" : "error",
        text: probe.message,
      });
    } catch (err) {
      if (
        !isCurrentPageVersion(pageVersion)
        || runtimeVersionRef.current !== runtimeVersion
        || activeProbeRequestIdRef.current !== requestId
      ) return;
      setRuntime(null);
      setStatus({
        tone: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (
        isCurrentPageVersion(pageVersion)
        && runtimeVersionRef.current === runtimeVersion
        && activeProbeRequestIdRef.current === requestId
      ) {
        activeProbeRequestIdRef.current = null;
        setRuntimeBusy(false);
      }
    }
  }, [isCurrentPageVersion, model]);

  useEffect(() => {
    pageVersionRef.current += 1;
    runtimeVersionRef.current += 1;
    generationVersionRef.current += 1;
    activeRequestIdRef.current = null;
    activeProbeRequestIdRef.current = null;
    activeRequestGenerationVersionRef.current = null;
    setRuntime(null);
    setRuntimeBusy(false);
    setCacheInfo(null);
    setCacheBusy(false);
    setGenerationProgress(null);
    setStatus(null);
    setGenerateBusy(false);
    clearGeneratedResult();
  }, [clearGeneratedResult, model]);

  useEffect(() => {
    if (!electronAvailable) return;
    const pageVersion = pageVersionRef.current;

    const run = async () => {
      await Promise.allSettled([
        runProbe(pageVersion),
        refreshCacheInfo(pageVersion),
        refreshQwen3Setup(),
      ]);
    };

    void run();
  }, [electronAvailable, model, refreshCacheInfo, refreshQwen3Setup, runProbe]);

  // Pre-warm the selected model inside the resident Rust worker.
  const warmedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (model !== "qwen3" || !electronAvailable || generateBusy) return;
    const modelPath = qwen3.modelPath.trim();
    if (!modelPath || qwen3.readiness === "missing") return;
    const warmKey = `${qwen3.profile.repo}:${modelPath}`;
    if (warmedKeyRef.current === warmKey) return;
    warmedKeyRef.current = warmKey;
    void window.electron?.localTts?.warm?.({
      model,
      mode: qwen3.profile.mode,
      modelPath,
    }).catch(() => undefined);
  }, [electronAvailable, generateBusy, model, qwen3.modelPath, qwen3.profile, qwen3.readiness]);

  useEffect(() => {
    if (!electronAvailable || !window.electron?.localTts) return;

    const flushGenerationProgress = () => {
      const event = pendingGenerationProgressRef.current;
      if (!event) return;
      pendingGenerationProgressRef.current = null;
      setGenerationProgress(event);
      setStatus({
        tone: "info",
        text: event.elapsedSec != null
          ? `${event.message} (${event.elapsedSec.toFixed(1)}s)`
          : event.message,
      });
    };

    return window.electron.localTts.subscribeProgress((event) => {
      if (!mountedRef.current) return;
      if (event.model !== model) return;
      if (event.requestId === activeProbeRequestIdRef.current) {
        setStatus({
          tone: "info",
          text: event.elapsedSec != null
            ? `${event.message} (${event.elapsedSec.toFixed(1)}s)`
            : event.message,
        });
        return;
      }
      if (event.requestId !== activeRequestIdRef.current) return;
      if (activeRequestGenerationVersionRef.current !== generationVersionRef.current) return;

      pendingGenerationProgressRef.current = event;
      generationProgressFlushCancelRef.current?.();
      generationProgressFlushCancelRef.current = scheduleNextUiFrame(flushGenerationProgress);
    });
  }, [electronAvailable, model]);

  useEffect(() => {
    if (!electronAvailable || !window.electron?.localTts) return;

    return window.electron.localTts.subscribeAudioChunk((event: LocalTtsAudioChunkEvent) => {
      if (!mountedRef.current) return;
      if (event.model !== model) return;
      if (event.requestId !== activeRequestIdRef.current) return;
      if (activeRequestGenerationVersionRef.current !== generationVersionRef.current) return;
      if (event.sampleCount <= 0 || event.audio.byteLength !== event.sampleCount * Float32Array.BYTES_PER_ELEMENT) return;

      if (event.index === 0 || streamedAudioSampleRateRef.current !== event.sampleRate) {
        streamedAudioChunksRef.current = [];
        streamedAudioSampleRateRef.current = event.sampleRate;
      }

      streamedAudioChunksRef.current[event.index] = {
        audio: event.audio,
        sampleCount: event.sampleCount,
        silenceAfterSamples: event.silenceAfterSamples,
      };
      const contiguousChunks = streamedAudioChunksRef.current
        .slice(0, event.index + 1)
        .filter((chunk): chunk is ReceivedAudioChunk => !!chunk);
      if (contiguousChunks.length !== event.index + 1) return;

      const sampleRate = streamedAudioSampleRateRef.current ?? event.sampleRate;
      const displayTotal = event.total > 0 ? event.total : event.index + 1;
      while (scheduledAudioChunkCountRef.current < contiguousChunks.length) {
        const chunkIndex = scheduledAudioChunkCountRef.current;
        const chunk = contiguousChunks[chunkIndex];
        scheduledAudioChunkCountRef.current += 1;
        void scheduleAudioChunk({
          audio: buildPlaybackSamples(chunk),
          samplingRate: sampleRate,
          text: `${name} chunk ${chunkIndex + 1}`,
          index: chunkIndex + 1,
          total: displayTotal,
          pauseAfterSec: chunk.silenceAfterSamples / sampleRate,
        }).catch((err: unknown) => {
          if (!mountedRef.current) return;
          setStatus({ tone: "error", text: err instanceof Error ? err.message : String(err) });
        });
      }

      if (event.total > 0 && event.index + 1 === event.total) {
        setNewAudioUrl(float32ChunksToWavUrl(contiguousChunks, event.sampleRate));
      }
      setStatus({
        tone: "info",
        text: event.total > 0
          ? `Received audio chunk ${event.index + 1}/${event.total}.`
          : `Received streaming audio chunk ${event.index + 1}.`,
      });
    });
  }, [electronAvailable, model, name, scheduleAudioChunk, setNewAudioUrl]);

  useEffect(() => () => {
    if (!window.electron?.localTts) return;
    const requestId = activeRequestIdRef.current;
    if (!requestId) return;
    void window.electron.localTts.cancel({ model, requestId }).catch(() => undefined);
    activeRequestIdRef.current = null;
    activeRequestGenerationVersionRef.current = null;
  }, [model]);

  const canGenerate = useMemo(() => {
    if (text.trim().length < 10) return false;
    if (model === "neutts") {
      return referenceText.trim().length > 0 && (!!referenceCodesBase64 || !!referenceWavBase64);
    }
    if (model === "qwen3" && qwen3VoiceClone) {
      return qwen3.modelPath.trim().length > 0
        && qwen3.readiness !== "missing"
        && qwen3.referenceText.trim().length > 0
        && !!qwen3.referenceAudioBase64;
    }
    if (model === "qwen3") {
      return qwen3.modelPath.trim().length > 0 && qwen3.readiness !== "missing";
    }
    return true;
  }, [
    model,
    qwen3.modelPath,
    qwen3.readiness,
    qwen3.referenceAudioBase64,
    qwen3.referenceText,
    qwen3VoiceClone,
    referenceCodesBase64,
    referenceWavBase64,
    referenceText,
    text,
  ]);

  const handleTextChange = useCallback((nextText: string) => {
    invalidateGeneration();
    setText(nextText);
  }, [invalidateGeneration]);

  const handleNeuttsModelChange = useCallback((nextModel: string) => {
    invalidateGeneration();
    setNeuttsModel(nextModel);
  }, [invalidateGeneration]);

  const handleReferenceTextChange = useCallback((nextReferenceText: string) => {
    invalidateGeneration();
    setReferenceText(nextReferenceText);
  }, [invalidateGeneration]);

  const handleQwen3ModelChange = useCallback((nextModel: string) => {
    invalidateGeneration();
    qwen3.setProfileRepo(nextModel);
  }, [invalidateGeneration, qwen3]);

  const handleQwen3BaseModelPathChange = useCallback((nextPath: string) => {
    invalidateGeneration();
    qwen3.setModelPath(nextPath);
  }, [invalidateGeneration, qwen3]);

  const handleQwen3ChooseBaseModelPath = useCallback(async () => {
    invalidateGeneration();
    await qwen3.chooseModelPath();
  }, [invalidateGeneration, qwen3]);

  const handleQwen3DownloadModel = useCallback(async () => {
    invalidateGeneration();
    await qwen3.downloadModel();
  }, [invalidateGeneration, qwen3]);

  const handleQwen3ReferenceTextChange = useCallback((nextReferenceText: string) => {
    invalidateGeneration();
    qwen3.setReferenceText(nextReferenceText);
  }, [invalidateGeneration, qwen3]);

  const handleQwen3SpeakerChange = useCallback((nextSpeaker: string) => {
    invalidateGeneration();
    qwen3.setSpeaker(nextSpeaker);
  }, [invalidateGeneration, qwen3]);

  const handleQwen3LanguageChange = useCallback((nextLanguage: string) => {
    invalidateGeneration();
    qwen3.setLanguage(nextLanguage);
  }, [invalidateGeneration, qwen3]);

  const handleQwen3InstructChange = useCallback((nextInstruct: string) => {
    invalidateGeneration();
    qwen3.setInstruct(nextInstruct);
  }, [invalidateGeneration, qwen3]);

  const handleQwen3TemperatureChange = useCallback((nextTemperature: number) => {
    invalidateGeneration();
    qwen3.setTemperature(nextTemperature);
  }, [invalidateGeneration, qwen3]);

  const handleQwen3TopKChange = useCallback((nextTopK: number) => {
    invalidateGeneration();
    qwen3.setTopK(nextTopK);
  }, [invalidateGeneration, qwen3]);

  const handleQwen3MaxNewTokensChange = useCallback((nextMaxNewTokens: number) => {
    invalidateGeneration();
    qwen3.setMaxNewTokens(nextMaxNewTokens);
  }, [invalidateGeneration, qwen3]);

  const handleReferenceAudioChange = useCallback(async (file: File | null) => {
    const pageVersion = pageVersionRef.current;
    invalidateGeneration();

    if (!file) {
      if (!isCurrentPageVersion(pageVersion)) return;
      setReferenceAudioName("");
      setReferenceCodesBase64(null);
      setReferenceWavBase64(null);
      setReferenceAudioGuidance(null);
      return;
    }

    try {
      const buffer = await file.arrayBuffer();
      const lowerName = file.name.toLowerCase();
      if (!lowerName.endsWith(".npy") && !lowerName.endsWith(".wav")) {
        throw new Error("NeuTTS references must be a WAV clip or pre-encoded .npy code file.");
      }

      if (!isCurrentPageVersion(pageVersion)) return;
      if (lowerName.endsWith(".npy")) {
        setReferenceCodesBase64(arrayBufferToBase64(buffer));
        setReferenceWavBase64(null);
        setReferenceAudioGuidance({ tone: "success", text: "Reference code file loaded." });
        setStatus({ tone: "info", text: `Loaded reference codes: ${file.name}. Enter the matching transcript before generating.` });
      } else {
        setReferenceWavBase64(arrayBufferToBase64(buffer));
        setReferenceCodesBase64(null);
        setReferenceAudioGuidance({ tone: "success", text: "Reference WAV loaded." });
        setStatus({ tone: "info", text: `Loaded reference WAV: ${file.name}. Enter the matching transcript before generating.` });
      }
      setReferenceAudioName(file.name);
    } catch (err) {
      if (!isCurrentPageVersion(pageVersion)) return;
      setReferenceAudioName("");
      setReferenceCodesBase64(null);
      setReferenceWavBase64(null);
      setReferenceAudioGuidance(null);
      setStatus({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    }
  }, [invalidateGeneration, isCurrentPageVersion]);

  const handleQwen3ReferenceAudioChange = useCallback(async (file: File | null) => {
    const pageVersion = pageVersionRef.current;
    invalidateGeneration();

    if (!file) {
      if (!isCurrentPageVersion(pageVersion)) return;
      qwen3.setReferenceAudio("", null);
      setQwen3ReferenceAudioGuidance(null);
      return;
    }

    try {
      if (!file.name.toLowerCase().endsWith(".wav")) {
        throw new Error("Qwen3 Base voice cloning requires a WAV reference file.");
      }
      const buffer = await file.arrayBuffer();
      if (!isCurrentPageVersion(pageVersion)) return;
      qwen3.setReferenceAudio(file.name, arrayBufferToBase64(buffer));
      setQwen3ReferenceAudioGuidance({ tone: "success", text: "Reference WAV loaded." });
      setStatus({ tone: "info", text: `Loaded Qwen3 reference WAV: ${file.name}. Enter its exact transcript before generating.` });
    } catch (err) {
      if (!isCurrentPageVersion(pageVersion)) return;
      qwen3.setReferenceAudio("", null);
      setQwen3ReferenceAudioGuidance(null);
      setStatus({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    }
  }, [invalidateGeneration, isCurrentPageVersion, qwen3]);

  const runGeneration = useCallback(async () => {
    if (!window.electron?.localTts) return;
    const pageVersion = pageVersionRef.current;
    const generationVersion = generationVersionRef.current;
    const requestId = createLocalRequestId(model);

    clearGeneratedResult();
    beginAudioStream();
    setGenerateBusy(true);
    const startingStatus = formatStartingGenerationStatus(model, qwen3.profile.label, qwen3.profile.provider);
    setGenerationProgress({
      requestId,
      model,
      phase: "queued",
      message: startingStatus,
      elapsedSec: 0,
    });
    setStatus({ tone: "info", text: startingStatus });
    activeRequestIdRef.current = requestId;
    activeRequestGenerationVersionRef.current = generationVersion;

    try {
      const payload: Record<string, unknown> = { text: text.trim() };

      if (model === "neutts") {
        payload.modelRepo = neuttsModel;
        payload.referenceText = referenceText.trim();
        if (referenceCodesBase64) {
          payload.referenceCodesBase64 = referenceCodesBase64;
        } else if (referenceWavBase64) {
          payload.referenceAudioBase64 = referenceWavBase64;
        }
      } else if (model === "qwen3") {
        payload.modelRepo = qwen3.profile.repo;
        payload.mode = qwen3.profile.mode;
        payload.modelPath = qwen3.modelPath.trim();
        if (qwen3VoiceClone) {
          payload.referenceAudioBase64 = qwen3.referenceAudioBase64;
          payload.referenceText = qwen3.referenceText.trim();
        } else {
          payload.speaker = qwen3.speaker;
          payload.instruct = qwen3.instruct.trim() || undefined;
        }
        payload.language = qwen3.language;
        payload.temperature = qwen3.temperature;
        payload.topK = qwen3.topK;
        payload.maxNewTokens = qwen3.maxNewTokens;
      }

      const generated = await window.electron.localTts.generate({
        model,
        requestId,
        payload,
      });

      if (!isCurrentPageVersion(pageVersion)) return;
      if (activeRequestIdRef.current !== requestId) return;
      if (generationVersionRef.current !== generationVersion) return;
      setResult(generated);
      const expectedChunks = generated.audioChunkCount;
      const sampleRate = streamedAudioSampleRateRef.current;
      const chunks = streamedAudioChunksRef.current.slice(0, expectedChunks);
      const completeChunks = chunks.filter((chunk): chunk is ReceivedAudioChunk => !!chunk);
      if (sampleRate == null || expectedChunks <= 0 || completeChunks.length !== expectedChunks) {
        throw new Error("Generation returned incomplete streamed audio.");
      }
      setNewAudioUrl(float32ChunksToWavUrl(completeChunks, sampleRate));
      endAudioStream();
      setGenerationProgress(null);
      setStatus({
        tone: "success",
        text: formatGenerationStatus(generated),
      });
      void refreshCacheInfo(pageVersion).catch((err: unknown) => {
        console.warn("Failed to refresh local cache info:", err);
      });
    } catch (err) {
      if (!isCurrentPageVersion(pageVersion)) return;
      if (activeRequestIdRef.current !== requestId) return;
      endAudioStream();
      clearGeneratedResult();
      setGenerationProgress(null);
      const message = err instanceof Error ? err.message : String(err);
      setStatus({
        tone: /cancelled/i.test(message) ? "info" : "error",
        text: message,
      });
    } finally {
      if (isCurrentPageVersion(pageVersion) && activeRequestIdRef.current === requestId) {
        activeRequestIdRef.current = null;
        activeRequestGenerationVersionRef.current = null;
        setGenerateBusy(false);
      }
    }
  }, [
    clearGeneratedResult,
    beginAudioStream,
    endAudioStream,
    isCurrentPageVersion,
    model,
    neuttsModel,
    qwen3,
    qwen3VoiceClone,
    referenceCodesBase64,
    referenceWavBase64,
    referenceText,
    refreshCacheInfo,
    setNewAudioUrl,
    text,
  ]);

  const handleClearCache = useCallback(async (): Promise<boolean> => {
    if (!window.electron?.localTts) return false;
    const pageVersion = pageVersionRef.current;
    setCacheBusy(true);
    setStatus({ tone: "info", text: "Clearing local model cache…" });

    try {
      await window.electron.localTts.clearCache({ model });
      await refreshCacheInfo(pageVersion);
      if (!isCurrentPageVersion(pageVersion)) return false;
      setStatus({ tone: "success", text: "Local model cache cleared." });
      return true;
    } catch (err) {
      if (!isCurrentPageVersion(pageVersion)) return false;
      setStatus({ tone: "error", text: err instanceof Error ? err.message : String(err) });
      return false;
    } finally {
      if (isCurrentPageVersion(pageVersion)) {
        setCacheBusy(false);
      }
    }
  }, [isCurrentPageVersion, model, refreshCacheInfo]);

  const handleRedownload = useCallback(async () => {
    const pageVersion = pageVersionRef.current;
    const cleared = await handleClearCache();
    if (!cleared) return;
    if (!isCurrentPageVersion(pageVersion)) return;
    if (!canGenerate) {
      setStatus({
        tone: "info",
        text: "Cache cleared. Provide required inputs and generate once to re-download model files.",
      });
      return;
    }
    await runGeneration();
  }, [canGenerate, handleClearCache, isCurrentPageVersion, runGeneration]);

  const busy = runtimeBusy || cacheBusy || qwen3.setupBusy || qwen3.downloadBusy || generateBusy;
  const runtimeReady = runtime?.ready ?? false;

  useEffect(() => {
    if (!active) return;

    const handleLocalRuntimeShortcut = (event: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const primaryModifier = hasPrimaryShortcutModifier(event);

      if (primaryModifier && event.key === "Enter") {
        if (electronAvailable && runtimeReady && canGenerate && !busy) {
          event.preventDefault();
          void runGeneration();
        }
        return;
      }

      if (primaryModifier && event.key === ".") {
        if (generateBusy) {
          event.preventDefault();
          void cancelActiveGeneration();
        }
        return;
      }

      if (isEditableShortcutTarget(event.target)) return;

      if (!primaryModifier && !event.altKey && event.code === "Space" && audioPlayer.totalDuration > 0) {
        event.preventDefault();
        void audioPlayer.togglePlay();
        return;
      }

      if (!primaryModifier && event.altKey && audioPlayer.totalDuration > 0) {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          audioPlayer.skip(-10);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          audioPlayer.skip(10);
        }
      }
    };

    document.addEventListener("keydown", handleLocalRuntimeShortcut);
    return () => document.removeEventListener("keydown", handleLocalRuntimeShortcut);
  }, [
    active,
    audioPlayer,
    busy,
    canGenerate,
    cancelActiveGeneration,
    electronAvailable,
    generateBusy,
    runGeneration,
    runtimeReady,
  ]);

  const activeSegmentNumber = useMemo(() => {
    if (!audioPlayer.activeSegmentId) return null;
    const index = audioPlayer.segments.findIndex((segment) => segment.id === audioPlayer.activeSegmentId);
    return index >= 0 ? index + 1 : null;
  }, [audioPlayer.activeSegmentId, audioPlayer.segments]);
  const playerStats = useMemo<GenerationStats>(() => {
    const processingTime = result?.elapsedSec ?? 0;
    const duration = audioPlayer.totalDuration || result?.durationSec || 0;
    return {
      firstLatency: null,
      processingTime,
      charsPerSec: processingTime > 0 ? text.trim().length / processingTime : 0,
      rtf: result && result.durationSec > 0 ? result.elapsedSec / result.durationSec : 0,
      totalDuration: duration,
      currentDuration: audioPlayer.currentTime,
    };
  }, [audioPlayer.currentTime, audioPlayer.totalDuration, result, text]);
  const handleDownloadAudio = useCallback(() => {
    const url = audioUrlRef.current;
    if (url) {
      const link = document.createElement("a");
      link.href = url;
      link.download = `open-tts-${model}.wav`;
      link.click();
      return;
    }
    void downloadAudio().catch((err: unknown) => {
      setStatus({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    });
  }, [downloadAudio, model]);

  return (
    <div className="mt-6 grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-5">
      <section className="flex flex-col gap-4 rounded-[22px] glass-panel p-4 transition-all duration-300 sm:p-6 lg:col-span-3">
        <div>
          <h2 className="text-xl font-display font-semibold text-text-primary">{name}</h2>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span className="rounded-full border border-white/50 bg-white/40 px-2.5 py-1 font-mono text-2xs text-text-muted shadow-glass-sm backdrop-blur-sm">
              {releaseDate}
            </span>
            <span className="rounded-full border border-white/50 bg-white/40 px-2.5 py-1 font-mono text-2xs text-text-muted shadow-glass-sm backdrop-blur-sm">
              {params}
            </span>
          </div>
          <ul className="mt-3 space-y-1 text-sm text-text-secondary">
            {highlights.map((item) => (
              <li key={item} className="flex gap-2 leading-relaxed">
                <span aria-hidden className="mt-[0.55em] h-1 w-1 shrink-0 rounded-full bg-accent/60" />
                {item}
              </li>
            ))}
          </ul>
        </div>

        {model === "qwen3" && (
          <LocalRuntimeQwenSetup
            qwen3Profile={qwen3.profile}
            qwen3Profiles={qwen3.profiles}
            onQwen3ProfileChange={handleQwen3ModelChange}
            qwen3ModelPath={qwen3.modelPath}
            onQwen3ModelPathChange={handleQwen3BaseModelPathChange}
            qwen3Readiness={qwen3.readiness}
            qwen3SetupBusy={qwen3.setupBusy}
            qwen3DownloadBusy={qwen3.downloadBusy}
            qwen3DownloadProgress={qwen3.downloadProgress}
            qwen3Error={qwen3.error}
            onQwen3RefreshSetup={() => { void refreshQwen3Setup(); }}
            onQwen3DownloadModel={() => { void handleQwen3DownloadModel(); }}
            onQwen3ChooseModelPath={() => { void handleQwen3ChooseBaseModelPath(); }}
          />
        )}

        <div className="space-y-2">
          <label className="block text-xs font-semibold uppercase tracking-wider text-text-secondary">
            Text
          </label>
          <textarea
            value={text}
            onChange={(event) => handleTextChange(event.target.value)}
            className="w-full min-h-32 px-3 py-2 rounded-xl border border-black/10 bg-surface/55 backdrop-blur-md text-sm text-text-primary focus:ring-1 focus:ring-accent focus:border-accent outline-none transition-all selection:bg-accent/40 selection:text-white"
            placeholder="Type or paste text to synthesize…"
          />
        </div>

        {(model === "neutts" || model === "qwen3") && (
          <LocalRuntimeRuntimeSettings
            onRecheckRuntime={() => { void runProbe(pageVersionRef.current); }}
            runtime={runtime}
            runtimeBusy={runtimeBusy}
          />
        )}

        <LocalRuntimeModelInputs
          model={model}
          neuttsModel={neuttsModel}
          onNeuttsModelChange={handleNeuttsModelChange}
          referenceText={referenceText}
          onReferenceTextChange={handleReferenceTextChange}
          referenceAudioName={referenceAudioName}
          referenceAudioGuidance={referenceAudioGuidance}
          onReferenceAudioChange={handleReferenceAudioChange}
          qwen3Profile={qwen3.profile}
          qwen3Profiles={qwen3.profiles}
          onQwen3ProfileChange={handleQwen3ModelChange}
          qwen3ModelPath={qwen3.modelPath}
          onQwen3ModelPathChange={handleQwen3BaseModelPathChange}
          qwen3Readiness={qwen3.readiness}
          qwen3SetupBusy={qwen3.setupBusy}
          qwen3DownloadBusy={qwen3.downloadBusy}
          qwen3DownloadProgress={qwen3.downloadProgress}
          qwen3Error={qwen3.error}
          onQwen3RefreshSetup={() => { void refreshQwen3Setup(); }}
          onQwen3DownloadModel={() => { void handleQwen3DownloadModel(); }}
          onQwen3ChooseModelPath={() => { void handleQwen3ChooseBaseModelPath(); }}
          qwen3ReferenceAudioName={qwen3.referenceAudioName}
          qwen3ReferenceAudioGuidance={qwen3ReferenceAudioGuidance}
          onQwen3ReferenceAudioChange={handleQwen3ReferenceAudioChange}
          qwen3ReferenceText={qwen3.referenceText}
          onQwen3ReferenceTextChange={handleQwen3ReferenceTextChange}
          qwen3Speaker={qwen3.speaker}
          onQwen3SpeakerChange={handleQwen3SpeakerChange}
          qwen3Language={qwen3.language}
          onQwen3LanguageChange={handleQwen3LanguageChange}
          qwen3Instruct={qwen3.instruct}
          onQwen3InstructChange={handleQwen3InstructChange}
          qwen3Temperature={qwen3.temperature}
          onQwen3TemperatureChange={handleQwen3TemperatureChange}
          qwen3TopK={qwen3.topK}
          onQwen3TopKChange={handleQwen3TopKChange}
          qwen3MaxNewTokens={qwen3.maxNewTokens}
          onQwen3MaxNewTokensChange={handleQwen3MaxNewTokensChange}
        />

        {generateBusy && generationProgress && (
          <div className="flex flex-col gap-2 rounded-xl border border-black/10 bg-surface/55 backdrop-blur-md p-3 text-sm text-text-primary">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
                  {generationProgress.phase.replace(/_/g, " ")}
                </p>
                <p>{generationProgress.message}</p>
              </div>
              <div className="text-xs text-text-muted">
                {generationProgress.elapsedSec != null ? `${generationProgress.elapsedSec.toFixed(1)}s` : "-"}
              </div>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            onClick={runGeneration}
            disabled={!electronAvailable || !runtimeReady || !canGenerate || busy}
            className={`
              w-full rounded-2xl px-6 py-2.5 text-sm font-semibold tracking-wide transition-all duration-300 sm:w-auto
              ${!electronAvailable || !runtimeReady || !canGenerate || busy
                ? "bg-border/50 text-text-muted cursor-not-allowed backdrop-blur-sm"
                : "glass-accent text-white"
              }
            `}
          >
            {generateBusy ? "Generating…" : "Generate"}
          </button>

          {generateBusy && (
            <button
              type="button"
              onClick={() => { void cancelActiveGeneration(); }}
              className="w-full rounded-2xl border border-white/55 bg-white/40 backdrop-blur-md px-5 py-2.5 text-sm font-semibold text-text-primary shadow-glass-sm transition-all duration-200 hover:bg-white/60 hover:-translate-y-0.5 sm:w-auto"
            >
              Cancel
            </button>
          )}
        </div>

        {(audioUrl || audioPlayer.totalDuration > 0) && (
          <div className="border border-black/10 rounded-xl p-3 bg-surface/55 backdrop-blur-md">
            <p className="text-xs font-semibold uppercase tracking-widest text-text-secondary mb-2">Output</p>
            <AudioPlayer
              embedded
              isPlaying={audioPlayer.isPlaying}
              currentTime={audioPlayer.currentTime}
              totalDuration={audioPlayer.totalDuration}
              segmentCount={audioPlayer.segments.length}
              activeSegmentNumber={activeSegmentNumber}
              stats={playerStats}
              isGenerating={generateBusy}
              onTogglePlay={audioPlayer.togglePlay}
              onSeek={audioPlayer.seek}
              onSkipBackward={() => audioPlayer.skip(-10)}
              onSkipForward={() => audioPlayer.skip(10)}
              onDownload={handleDownloadAudio}
              onStop={generateBusy ? () => { void cancelActiveGeneration(); } : stopAudioPlayer}
            />
            {result && (
              <p className="text-sm mt-2 text-text-muted">
                {result.modelRepo} • {result.sampleRate} Hz • {result.durationSec.toFixed(2)}s
              </p>
            )}
            {audioPlayer.error && (
              <p className="text-sm mt-2 text-danger">{audioPlayer.error}</p>
            )}
          </div>
        )}

        {!electronAvailable && (
          <p className="text-xs text-danger">
            Available only in the desktop app — this model runs through local runtimes.
          </p>
        )}
      </section>

      <LocalRuntimeSidebar
        busy={busy}
        cacheInfo={cacheInfo}
        electronAvailable={electronAvailable}
        links={links}
        onClearCache={handleClearCache}
        onRedownload={handleRedownload}
        showRedownload={model !== "qwen3"}
        runtime={runtime}
        runtimeBusy={runtimeBusy}
        runtimeReady={runtimeReady}
        status={status}
      />
    </div>
  );
}
