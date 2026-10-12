import { useCallback, useMemo, useState } from "react";
import { CREATOR_PRESETS } from "../constants";
import type { CaptionStyle, CreatorState, ExportPostState, PersistedCreatorState } from "../lib/appState";
import { LOUDNESS_PRESETS, type ExportFormat, type ExportOptions } from "../lib/exportAudio";
import {
  flattenPronunciationDictionaries,
  type PronunciationDictionary,
} from "../lib/pronunciation/dictionary";
import type { PostProcessingOptions } from "../lib/audio/postProcess";
import type { CreatorPresetId, ExportSampleRate, GenerationTuningSettings } from "../types";

interface UseCreatorSettingsOptions {
  initialState: CreatorState;
  quality: number;
  language?: string;
}

/** The pieces of the spoken-text pipeline the Creator panel controls; an engine's language completes them. */
export interface CreatorSpeechSettings {
  dictionaries: readonly PronunciationDictionary[];
  normalize: boolean;
  cleanup: boolean;
}

interface UseCreatorSettingsReturn {
  creatorPreset: CreatorPresetId;
  speed: number;
  pauseCommaSec: number;
  pauseSentenceSec: number;
  pauseParagraphSec: number;
  dictionaries: PronunciationDictionary[];
  normalizeSpeech: boolean;
  cleanupOnSpeak: boolean;
  speechSettings: CreatorSpeechSettings;
  exportPost: ExportPostState;
  loudnessPresetId: string;
  captionStyle: CaptionStyle;
  generationSettings: GenerationTuningSettings;
  exportOptions: ExportOptions;
  persistedState: PersistedCreatorState;
  onCreatorPresetChange: (preset: CreatorPresetId) => void;
  onSpeedChange: (value: number) => void;
  onPauseCommaChange: (value: number) => void;
  onPauseSentenceChange: (value: number) => void;
  onPauseParagraphChange: (value: number) => void;
  onDictionariesChange: (value: PronunciationDictionary[]) => void;
  onNormalizeSpeechChange: (value: boolean) => void;
  onCleanupOnSpeakChange: (value: boolean) => void;
  onExportFormatChange: (value: ExportFormat) => void;
  onExportSampleRateChange: (value: ExportSampleRate) => void;
  onExportBitrateChange: (value: number) => void;
  onMasteringEnabledChange: (value: boolean) => void;
  onLoudnessPresetChange: (value: string) => void;
  onExportPostChange: (patch: Partial<ExportPostState>) => void;
  onCaptionStyleChange: (value: CaptionStyle) => void;
}

/** The post-processing options for an export, or undefined while every one is off. */
function postProcessingOptions(post: ExportPostState): PostProcessingOptions | undefined {
  const active = post.trimSilence || post.headSec > 0 || post.tailSec > 0 || post.fadeInMs > 0 || post.fadeOutMs > 0;
  return active ? { ...post } : undefined;
}

export function useCreatorSettings({
  initialState,
  quality,
  language,
}: UseCreatorSettingsOptions): UseCreatorSettingsReturn {
  const [creatorPreset, setCreatorPreset] = useState<CreatorPresetId>(initialState.preset);
  const [speed, setSpeed] = useState(initialState.speed);
  const [pauseCommaSec, setPauseCommaSec] = useState(initialState.pauseCommaSec);
  const [pauseSentenceSec, setPauseSentenceSec] = useState(initialState.pauseSentenceSec);
  const [pauseParagraphSec, setPauseParagraphSec] = useState(initialState.pauseParagraphSec);
  const [dictionaries, setDictionaries] = useState(initialState.dictionaries);
  const [normalizeSpeech, setNormalizeSpeech] = useState(initialState.normalizeSpeech);
  const [cleanupOnSpeak, setCleanupOnSpeak] = useState(initialState.cleanupOnSpeak);
  const [exportFormat, setExportFormat] = useState<ExportFormat>(initialState.exportFormat);
  const [exportSampleRate, setExportSampleRate] = useState<ExportSampleRate>(initialState.exportSampleRate);
  const [exportBitrateKbps, setExportBitrateKbps] = useState(initialState.exportBitrateKbps);
  const [masteringEnabled, setMasteringEnabled] = useState(initialState.masteringEnabled);
  const [loudnessPresetId, setLoudnessPresetId] = useState(initialState.loudnessPresetId);
  const [exportPost, setExportPost] = useState(initialState.exportPost);
  const [captionStyle, setCaptionStyle] = useState(initialState.captionStyle);

  // Every enabled dictionary, whatever its language: each engine's own language
  // narrows them when the spoken-text pipeline runs (see `useEngineOrchestrator`).
  const pronunciationRules = useMemo(
    () => flattenPronunciationDictionaries(dictionaries).rules,
    [dictionaries],
  );

  const speechSettings = useMemo<CreatorSpeechSettings>(
    () => ({ dictionaries, normalize: normalizeSpeech, cleanup: cleanupOnSpeak }),
    [cleanupOnSpeak, dictionaries, normalizeSpeech],
  );

  const generationSettings = useMemo<GenerationTuningSettings>(() => ({
    speed,
    quality,
    language,
    pauseOverridesSec: {
      comma: pauseCommaSec,
      sentence: pauseSentenceSec,
      paragraph: pauseParagraphSec,
      none: 0,
    },
    pronunciationRules,
  }), [
    pauseCommaSec,
    pauseParagraphSec,
    pauseSentenceSec,
    pronunciationRules,
    quality,
    language,
    speed,
  ]);

  const exportOptions = useMemo<ExportOptions>(() => {
    const loudness = LOUDNESS_PRESETS.find((preset) => preset.id === loudnessPresetId) ?? LOUDNESS_PRESETS[0];
    const post = postProcessingOptions(exportPost);
    return {
      format: exportFormat,
      sampleRate: exportSampleRate,
      bitrateKbps: exportBitrateKbps,
      mastering: { enabled: masteringEnabled, ...loudness.mastering },
      ...(post ? { post } : {}),
    };
  }, [exportBitrateKbps, exportFormat, exportPost, exportSampleRate, loudnessPresetId, masteringEnabled]);

  const applyPreset = useCallback((preset: CreatorPresetId) => {
    setCreatorPreset(preset);
    if (preset === "custom") return;

    const defaults = CREATOR_PRESETS[preset];
    setSpeed(defaults.speed);
    setPauseCommaSec(defaults.pauseCommaSec);
    setPauseSentenceSec(defaults.pauseSentenceSec);
    setPauseParagraphSec(defaults.pauseParagraphSec);
    setExportFormat(defaults.exportFormat);
    setExportSampleRate(defaults.exportSampleRate);
    setExportBitrateKbps(defaults.exportBitrateKbps);
    setMasteringEnabled(defaults.masteringEnabled);
  }, []);

  const markPresetAsCustom = useCallback(() => {
    setCreatorPreset((current) => (current === "custom" ? current : "custom"));
  }, []);

  // Editing any one setting a preset defines turns the preset into "custom".
  // Each setter keeps its identity for the hook's lifetime, so memoized panels
  // stay memoized. The dictionary, the text toggles and the export finishing
  // options are not part of a preset and leave it alone.
  const onSpeedChange = useCallback((value: number) => {
    markPresetAsCustom();
    setSpeed(value);
  }, [markPresetAsCustom]);
  const onPauseCommaChange = useCallback((value: number) => {
    markPresetAsCustom();
    setPauseCommaSec(value);
  }, [markPresetAsCustom]);
  const onPauseSentenceChange = useCallback((value: number) => {
    markPresetAsCustom();
    setPauseSentenceSec(value);
  }, [markPresetAsCustom]);
  const onPauseParagraphChange = useCallback((value: number) => {
    markPresetAsCustom();
    setPauseParagraphSec(value);
  }, [markPresetAsCustom]);
  const onExportFormatChange = useCallback((value: ExportFormat) => {
    markPresetAsCustom();
    setExportFormat(value);
  }, [markPresetAsCustom]);
  const onExportSampleRateChange = useCallback((value: ExportSampleRate) => {
    markPresetAsCustom();
    setExportSampleRate(value);
  }, [markPresetAsCustom]);
  const onExportBitrateChange = useCallback((value: number) => {
    markPresetAsCustom();
    setExportBitrateKbps(value);
  }, [markPresetAsCustom]);
  const onMasteringEnabledChange = useCallback((value: boolean) => {
    markPresetAsCustom();
    setMasteringEnabled(value);
  }, [markPresetAsCustom]);
  const onExportPostChange = useCallback((patch: Partial<ExportPostState>) => {
    setExportPost((current) => ({ ...current, ...patch }));
  }, []);

  const persistedState = useMemo<PersistedCreatorState>(() => ({
    preset: creatorPreset,
    speed,
    pauseCommaSec,
    pauseSentenceSec,
    pauseParagraphSec,
    dictionaries,
    normalizeSpeech,
    cleanupOnSpeak,
    exportFormat,
    exportSampleRate,
    exportBitrateKbps,
    masteringEnabled,
    loudnessPresetId,
    exportPost,
    captionStyle,
  }), [
    cleanupOnSpeak,
    creatorPreset,
    dictionaries,
    exportBitrateKbps,
    exportFormat,
    exportPost,
    exportSampleRate,
    loudnessPresetId,
    masteringEnabled,
    normalizeSpeech,
    pauseCommaSec,
    pauseParagraphSec,
    pauseSentenceSec,
    captionStyle,
    speed,
  ]);

  return useMemo(() => ({
    creatorPreset,
    speed,
    pauseCommaSec,
    pauseSentenceSec,
    pauseParagraphSec,
    dictionaries,
    normalizeSpeech,
    cleanupOnSpeak,
    speechSettings,
    exportPost,
    loudnessPresetId,
    captionStyle,
    generationSettings,
    exportOptions,
    persistedState,
    onCreatorPresetChange: applyPreset,
    onSpeedChange,
    onPauseCommaChange,
    onPauseSentenceChange,
    onPauseParagraphChange,
    onDictionariesChange: setDictionaries,
    onNormalizeSpeechChange: setNormalizeSpeech,
    onCleanupOnSpeakChange: setCleanupOnSpeak,
    onExportFormatChange,
    onExportSampleRateChange,
    onExportBitrateChange,
    onMasteringEnabledChange,
    onLoudnessPresetChange: setLoudnessPresetId,
    onExportPostChange,
    onCaptionStyleChange: setCaptionStyle,
  }), [
    applyPreset,
    cleanupOnSpeak,
    creatorPreset,
    dictionaries,
    exportOptions,
    exportPost,
    generationSettings,
    loudnessPresetId,
    normalizeSpeech,
    onExportBitrateChange,
    onExportFormatChange,
    onExportPostChange,
    onExportSampleRateChange,
    onMasteringEnabledChange,
    onPauseCommaChange,
    onPauseParagraphChange,
    onPauseSentenceChange,
    onSpeedChange,
    pauseCommaSec,
    pauseParagraphSec,
    pauseSentenceSec,
    persistedState,
    captionStyle,
    speechSettings,
    speed,
  ]);
}
