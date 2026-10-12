import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type {
  LocalTtsCacheInfo,
  LocalTtsGenerateResult,
  LocalTtsModel,
  LocalTtsProgressEvent,
  LocalTtsProbeResult,
} from "../electron";
import { useQwen3Runtime } from "../contexts/Qwen3RuntimeContext";
import type { GenerationStats } from "../types";
import { useAudioPlayer } from "../hooks/useAudioPlayer";
import { useQwen3Warmup } from "../hooks/useQwen3Warmup";
import { createLocalAudioAssembler, createLocalRequestId } from "../lib/localTtsStream";
import { scheduleNextUiFrame } from "../lib/uiScheduling";
import { clearStagedReference, useStagedReference, type StagedReference } from "../lib/voiceLibrary/stagedReference";
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
  qwen3SupportsInstruct,
  qwen3UsesVoiceClone,
  qwen3UsesVoiceDesign,
} from "./localRuntime/modelOptions";
import {
  MAX_LOCAL_TTS_TEXT_LENGTH,
  MAX_REFERENCE_AUDIO_FILE_BYTES,
  MAX_REFERENCE_CODES_FILE_BYTES,
  exceedsUnicodeScalarLimit,
} from "../../electron/localTtsLimits";
import {
  arrayBufferToBase64,
  float32ChunksToWavUrl,
  formatBytes,
  sha256Hex,
  wavDurationSeconds,
  type Float32AudioChunk,
  type StatusTone,
} from "./localRuntime/utils";

interface LocalRuntimePageProps {
  active?: boolean;
  model: LocalTtsModel;
  name: string;
  releaseDate: string;
  params: string;
  highlights: readonly string[];
  links: ReadonlyArray<{ label: string; href: string }>;
  initialText?: string;
}

type StatusMessage = { tone: StatusTone; text: string } | null;

const DEFAULT_LOCAL_RUNTIME_TEXT = "Everything you hear is generated right here on this machine.";
// Mirrors the Rust bridge: it rejects Qwen references over 20 seconds (the
// transcript must match the whole clip) and warns below 3 seconds.
const QWEN3_REFERENCE_MAX_SECONDS = 20;
const QWEN3_REFERENCE_RECOMMENDED_MIN_SECONDS = 3;

function qwen3ReferenceGuidance(durationSec: number | null): StatusMessage {
  if (durationSec === null) return { tone: "success", text: "Reference WAV loaded." };
  const duration = `${durationSec.toFixed(1)} s`;
  if (durationSec > QWEN3_REFERENCE_MAX_SECONDS) {
    return {
      tone: "error",
      text: `This clip is ${duration}. Qwen3 accepts at most ${QWEN3_REFERENCE_MAX_SECONDS} seconds; trim the clip and its transcript together.`,
    };
  }
  if (durationSec < QWEN3_REFERENCE_RECOMMENDED_MIN_SECONDS) {
    return {
      tone: "info",
      text: `This clip is only ${duration}. Cloning works best with ${QWEN3_REFERENCE_RECOMMENDED_MIN_SECONDS}-${QWEN3_REFERENCE_MAX_SECONDS} seconds of clear speech.`,
    };
  }
  return { tone: "success", text: `Reference WAV loaded (${duration}).` };
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
  const warning = generated.warnings?.length ? ` ${generated.warnings.join(" ")}` : "";
  return `Generated ${generated.durationSec.toFixed(2)}s audio${device} in ${generated.elapsedSec.toFixed(2)}s${suffix}.${warning}`;
}

function formatStartingGenerationStatus(model: LocalTtsModel, profileLabel: string, provider: string): string {
  if (model !== "qwen3") return "Starting local generation...";
  return `Starting Qwen3 ${profileLabel} with ${provider}.`;
}

function LocalRuntimePageBody({
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

  // A reference the Voice Library sent here. It is taken during render, so the
  // page never paints the old reference first, and then released.
  const stagedNeutts = useStagedReference("neutts");
  const [takenStaged, setTakenStaged] = useState<StagedReference | null>(null);
  if (model === "neutts" && stagedNeutts && stagedNeutts !== takenStaged) {
    setTakenStaged(stagedNeutts);
    setReferenceText(stagedNeutts.transcript);
    setReferenceAudioName(`${stagedNeutts.name} (Voice Library)`);
    setReferenceWavBase64(stagedNeutts.wavBase64);
    setReferenceCodesBase64(null);
    setReferenceAudioGuidance({ tone: "success", text: "Reference loaded from the Voice Library." });
  }
  useEffect(() => {
    if (takenStaged) clearStagedReference("neutts");
  }, [takenStaged]);

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
  // The PCM of the finished request, kept to build its WAV once at completion.
  const streamedAudioChunksRef = useRef<Float32AudioChunk[]>([]);
  const streamedAudioSampleRateRef = useRef<number | null>(null);
  const scheduledAudioChunkCountRef = useRef(0);
  // Puts streamed audio back in order. It never changes, so the bridge
  // subscription survives re-renders; its sink tracks the latest props.
  const [assembler] = useState(() => createLocalAudioAssembler());
  const pendingChunkStatusRef = useRef<StatusMessage>(null);
  const chunkStatusFlushCancelRef = useRef<(() => void) | null>(null);
  const pendingGenerationProgressRef = useRef<LocalTtsProgressEvent | null>(null);
  const generationProgressFlushCancelRef = useRef<(() => void) | null>(null);
  const audioPlayer = useAudioPlayer();
  const {
    beginStream: beginAudioStream,
    download: downloadAudio,
    endStream: endAudioStream,
    getCurrentTime: getPlaybackTime,
    reset: resetAudioPlayer,
    scheduleChunk: scheduleAudioChunk,
    skip: skipPlayback,
    stopAll: stopAudioPlayer,
    togglePlay,
    totalDuration: playerTotalDuration,
  } = audioPlayer;

  const electronAvailable = !!window.electron?.localTts;
  const qwen3VoiceClone = qwen3UsesVoiceClone(qwen3.profile.repo);
  const qwen3VoiceDesign = qwen3UsesVoiceDesign(qwen3.profile.repo);

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
    assembler.reset();
    chunkStatusFlushCancelRef.current?.();
    chunkStatusFlushCancelRef.current = null;
    pendingChunkStatusRef.current = null;
    resetAudioPlayer();
    setAudioUrl(null);
    setResult(null);
  }, [assembler, resetAudioPlayer]);

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
    const requestId = createLocalRequestId(model, "probe");

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
  useQwen3Warmup(model === "qwen3" && electronAvailable, generateBusy, qwen3);

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
    assembler.setSink((part) => {
      const sampleRate = part.sampleRate;
      const chunkNumber = part.chunkIndex + 1;
      if (part.kind === "gap") {
        // The WAV is rebuilt from the retained chunks, so the silence joins the
        // chunk it follows.
        const followed = streamedAudioChunksRef.current[part.chunkIndex];
        if (followed) followed.silenceAfterSamples += part.samples.length;
      } else {
        streamedAudioSampleRateRef.current = sampleRate;
        streamedAudioChunksRef.current[part.chunkIndex] = {
          audio: part.samples.buffer as ArrayBuffer,
          sampleCount: part.samples.length,
          silenceAfterSamples: 0,
        };
        scheduledAudioChunkCountRef.current += 1;
      }
      // A gap carries its chunk's label, so it extends that chunk's segment
      // instead of adding a segment of silence.
      void scheduleAudioChunk({
        audio: part.samples,
        samplingRate: sampleRate,
        text: `${name} chunk ${chunkNumber}`,
        index: chunkNumber,
        total: part.declaredTotal > 0 ? part.declaredTotal : chunkNumber,
        textStart: 0,
        textEnd: 0,
        pauseAfterSec: part.pauseAfterSec,
      }).catch((err: unknown) => {
        if (!mountedRef.current) return;
        setStatus({ tone: "error", text: err instanceof Error ? err.message : String(err) });
      });
      if (part.kind === "gap") return;

      if (part.declaredTotal > 0 && scheduledAudioChunkCountRef.current === part.declaredTotal) {
        const completeChunks = streamedAudioChunksRef.current.slice(0, part.declaredTotal);
        setNewAudioUrl(float32ChunksToWavUrl(completeChunks, sampleRate));
      }
      // Chunks can arrive many times per frame: show only the latest status
      // once per frame instead of re-rendering this whole page for each one.
      pendingChunkStatusRef.current = {
        tone: "info",
        text: part.declaredTotal > 0
          ? `Received audio chunk ${chunkNumber}/${part.declaredTotal}.`
          : `Received streaming audio chunk ${chunkNumber}.`,
      };
      chunkStatusFlushCancelRef.current?.();
      chunkStatusFlushCancelRef.current = scheduleNextUiFrame(() => {
        chunkStatusFlushCancelRef.current = null;
        const next = pendingChunkStatusRef.current;
        pendingChunkStatusRef.current = null;
        if (next && mountedRef.current) setStatus(next);
      });
    });
  }, [assembler, name, scheduleAudioChunk, setNewAudioUrl]);

  useEffect(() => {
    if (!electronAvailable || !window.electron?.localTts) return;

    return window.electron.localTts.subscribeAudioChunk((event) => {
      if (!mountedRef.current) return;
      if (event.model !== model) return;
      if (event.requestId !== activeRequestIdRef.current) return;
      if (activeRequestGenerationVersionRef.current !== generationVersionRef.current) return;
      assembler.accept(event);
    });
  }, [assembler, electronAvailable, model]);

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
    if (exceedsUnicodeScalarLimit(text, MAX_LOCAL_TTS_TEXT_LENGTH)) return false;
    if (model === "neutts") {
      return referenceText.trim().length > 0 && (!!referenceCodesBase64 || !!referenceWavBase64);
    }
    if (model === "qwen3" && qwen3VoiceClone) {
      return qwen3.modelPath.trim().length > 0
        && qwen3.readiness !== "missing"
        && qwen3.referenceText.trim().length > 0
        && !!qwen3.referenceAudioBase64;
    }
    if (model === "qwen3" && qwen3VoiceDesign) {
      return qwen3.modelPath.trim().length > 0
        && qwen3.readiness !== "missing"
        && qwen3.instruct.trim().length > 0;
    }
    if (model === "qwen3") {
      return qwen3.modelPath.trim().length > 0 && qwen3.readiness !== "missing";
    }
    return true;
  }, [
    model,
    qwen3.instruct,
    qwen3.modelPath,
    qwen3.readiness,
    qwen3.referenceAudioBase64,
    qwen3.referenceText,
    qwen3VoiceClone,
    qwen3VoiceDesign,
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

  const handleQwen3SeedChange = useCallback((nextSeed: number | null) => {
    invalidateGeneration();
    qwen3.setSeed(nextSeed);
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
      const lowerName = file.name.toLowerCase();
      if (!lowerName.endsWith(".npy") && !lowerName.endsWith(".wav")) {
        throw new Error("NeuTTS references must be a WAV clip or pre-encoded .npy code file.");
      }
      const maxBytes = lowerName.endsWith(".npy")
        ? MAX_REFERENCE_CODES_FILE_BYTES
        : MAX_REFERENCE_AUDIO_FILE_BYTES;
      if (file.size > maxBytes) {
        throw new Error(`The reference file exceeds the ${formatBytes(maxBytes)} upload limit.`);
      }
      const buffer = await file.arrayBuffer();

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
      if (file.size > MAX_REFERENCE_AUDIO_FILE_BYTES) {
        throw new Error(
          `The reference WAV exceeds the ${formatBytes(MAX_REFERENCE_AUDIO_FILE_BYTES)} upload limit.`,
        );
      }
      const buffer = await file.arrayBuffer();
      const signature = await sha256Hex(buffer);
      if (!isCurrentPageVersion(pageVersion)) return;
      const durationSec = wavDurationSeconds(buffer);
      qwen3.setReferenceAudio(file.name, arrayBufferToBase64(buffer), signature, durationSec);
      setQwen3ReferenceAudioGuidance(qwen3ReferenceGuidance(durationSec));
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
    const requestId = createLocalRequestId(model, "generate");

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
          if (!qwen3VoiceDesign) payload.speaker = qwen3.speaker;
          payload.instruct = qwen3SupportsInstruct(qwen3.profile.repo)
            ? qwen3.instruct.trim() || undefined : undefined;
        }
        payload.language = qwen3.language;
        payload.temperature = qwen3.temperature;
        payload.topK = qwen3.topK;
        payload.maxNewTokens = qwen3.maxNewTokens;
        if (qwen3.seed !== null) payload.seed = qwen3.seed;
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
      const completeChunks = chunks.filter((chunk): chunk is Float32AudioChunk => !!chunk);
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
    qwen3VoiceDesign,
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

  // An effect event always sees the latest runtime and player state, so the
  // document listener below changes only when the page is shown or hidden.
  const handleLocalRuntimeShortcut = useEffectEvent((event: KeyboardEvent) => {
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

    if (!primaryModifier && !event.altKey && event.code === "Space" && playerTotalDuration > 0) {
      event.preventDefault();
      void togglePlay();
      return;
    }

    if (!primaryModifier && event.altKey && playerTotalDuration > 0) {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        skipPlayback(-10);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        skipPlayback(10);
      }
    }
  });

  useEffect(() => {
    if (!active) return;
    const listener = (event: KeyboardEvent) => handleLocalRuntimeShortcut(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, [active]);

  const activeSegmentNumber = useMemo(() => {
    if (!audioPlayer.activeSegmentId) return null;
    const index = audioPlayer.segments.findIndex((segment) => segment.id === audioPlayer.activeSegmentId);
    return index >= 0 ? index + 1 : null;
  }, [audioPlayer.activeSegmentId, audioPlayer.segments]);
  const playerStats = useMemo<GenerationStats>(() => {
    const processingTime = result?.elapsedSec ?? 0;
    const duration = playerTotalDuration || result?.durationSec || 0;
    return {
      firstLatency: null,
      processingTime,
      charsPerSec: processingTime > 0 ? text.trim().length / processingTime : 0,
      rtf: result && result.durationSec > 0 ? result.elapsedSec / result.durationSec : 0,
      totalDuration: duration,
      // See the note in useQwen3LocalRuntime: sampled, not tracked, so the stats
      // object does not churn on every animation frame.
      currentDuration: getPlaybackTime(),
    };
  }, [getPlaybackTime, playerTotalDuration, result, text]);
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
      <section className="flex flex-col gap-4 rounded-[22px] surface p-4 transition-all duration-300 sm:p-6 lg:col-span-3">
        <div>
          <h2 className="text-xl font-display font-semibold text-text-primary">{name}</h2>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span className="rounded-full border border-border bg-text-primary/[0.04] px-2.5 py-1 font-mono text-2xs text-text-muted">
              {releaseDate}
            </span>
            <span className="rounded-full border border-border bg-text-primary/[0.04] px-2.5 py-1 font-mono text-2xs text-text-muted">
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
          <label className="block text-sm font-semibold text-text-secondary">
            Text
          </label>
          <textarea
            value={text}
            onChange={(event) => handleTextChange(event.target.value)}
            className="w-full min-h-32 px-3 py-2 rounded-xl border border-black/10 bg-surface/55 text-sm text-text-primary focus:ring-1 focus:ring-accent focus:border-accent outline-none transition-all selection:bg-accent/40 selection:text-white"
            placeholder="Type or paste text to synthesize…"
          />
          {exceedsUnicodeScalarLimit(text, MAX_LOCAL_TTS_TEXT_LENGTH) && (
            <p className="text-xs text-danger" role="status">
              Local runtimes accept at most {MAX_LOCAL_TTS_TEXT_LENGTH.toLocaleString()} characters per request. Split longer text into smaller sections.
            </p>
          )}
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
          qwen3Seed={qwen3.seed}
          onQwen3SeedChange={handleQwen3SeedChange}
        />

        {generateBusy && generationProgress && (
          <div className="flex flex-col gap-2 rounded-xl border border-black/10 bg-surface/55 p-3 text-sm text-text-primary">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-text-secondary">
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
                ? "bg-border/50 text-text-muted cursor-not-allowed"
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
              className="w-full rounded-2xl border border-border bg-text-primary/[0.04] px-5 py-2.5 text-sm font-semibold text-text-primary transition-all duration-200 hover:bg-text-primary/[0.07] sm:w-auto"
            >
              Cancel
            </button>
          )}
        </div>

        {(audioUrl || audioPlayer.totalDuration > 0) && (
          <div className="border border-black/10 rounded-xl p-3 bg-surface/55">
            <p className="text-sm font-semibold text-text-secondary mb-2">Output</p>
            <AudioPlayer
              embedded
              isPlaying={audioPlayer.isPlaying}
              clock={audioPlayer.clock}
              totalDuration={audioPlayer.totalDuration}
              segmentCount={audioPlayer.segments.length}
              activeSegmentNumber={activeSegmentNumber}
              stats={playerStats}
              isGenerating={generateBusy}
              onTogglePlay={togglePlay}
              onSeek={audioPlayer.seek}
              onSkipBackward={() => skipPlayback(-10)}
              onSkipForward={() => skipPlayback(10)}
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

/**
 * A page's state belongs to the model it is showing, so switching models
 * mounts a fresh page rather than resetting this one's state by hand.
 */
export function LocalRuntimePage(props: LocalRuntimePageProps) {
  return <LocalRuntimePageBody key={props.model} {...props} />;
}
