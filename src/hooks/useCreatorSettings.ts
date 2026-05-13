import { useCallback, useMemo, useState } from "react";
import {
  CREATOR_PRESETS,
  DEFAULT_TARGET_LUFS,
  DEFAULT_TRUE_PEAK_DB,
} from "../constants";
import { parsePronunciationRules, type CreatorState, type PersistedCreatorState } from "../lib/appState";
import type {
  AudioExportOptions,
  CreatorPresetId,
  ExportAudioFormat,
  ExportSampleRate,
  GenerationTuningSettings,
} from "../types";

interface UseCreatorSettingsOptions {
  initialState: CreatorState;
  quality: number;
}

interface UseCreatorSettingsReturn {
  creatorPreset: CreatorPresetId;
  speed: number;
  pauseCommaSec: number;
  pauseSentenceSec: number;
  pauseParagraphSec: number;
  pronunciationLexicon: string;
  generationSettings: GenerationTuningSettings;
  exportOptions: AudioExportOptions;
  persistedState: PersistedCreatorState;
  onCreatorPresetChange: (preset: CreatorPresetId) => void;
  onSpeedChange: (value: number) => void;
  onPauseCommaChange: (value: number) => void;
  onPauseSentenceChange: (value: number) => void;
  onPauseParagraphChange: (value: number) => void;
  onPronunciationLexiconChange: (value: string) => void;
  onExportFormatChange: (value: ExportAudioFormat) => void;
  onExportSampleRateChange: (value: ExportSampleRate) => void;
  onExportBitrateChange: (value: number) => void;
  onMasteringEnabledChange: (value: boolean) => void;
}

export function useCreatorSettings({
  initialState,
  quality,
}: UseCreatorSettingsOptions): UseCreatorSettingsReturn {
  const [creatorPreset, setCreatorPreset] = useState<CreatorPresetId>(initialState.preset);
  const [speed, setSpeed] = useState(initialState.speed);
  const [pauseCommaSec, setPauseCommaSec] = useState(initialState.pauseCommaSec);
  const [pauseSentenceSec, setPauseSentenceSec] = useState(initialState.pauseSentenceSec);
  const [pauseParagraphSec, setPauseParagraphSec] = useState(initialState.pauseParagraphSec);
  const [pronunciationLexicon, setPronunciationLexicon] = useState(initialState.pronunciationLexicon);
  const [exportFormat, setExportFormat] = useState<ExportAudioFormat>(initialState.exportFormat);
  const [exportSampleRate, setExportSampleRate] = useState<ExportSampleRate>(initialState.exportSampleRate);
  const [exportBitrateKbps, setExportBitrateKbps] = useState(initialState.exportBitrateKbps);
  const [masteringEnabled, setMasteringEnabled] = useState(initialState.masteringEnabled);

  const pronunciationRules = useMemo(
    () => parsePronunciationRules(pronunciationLexicon),
    [pronunciationLexicon],
  );

  const generationSettings = useMemo<GenerationTuningSettings>(() => ({
    speed,
    quality,
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
    speed,
  ]);

  const exportOptions = useMemo<AudioExportOptions>(() => ({
    format: exportFormat,
    sampleRate: exportSampleRate,
    bitrateKbps: exportBitrateKbps,
    mastering: {
      enabled: masteringEnabled,
      targetLufs: DEFAULT_TARGET_LUFS,
      truePeakDb: DEFAULT_TRUE_PEAK_DB,
    },
  }), [exportBitrateKbps, exportFormat, exportSampleRate, masteringEnabled]);

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

  const withCustomPreset = useCallback((action: () => void) => {
    markPresetAsCustom();
    action();
  }, [markPresetAsCustom]);

  const persistedState = useMemo<PersistedCreatorState>(() => ({
    preset: creatorPreset,
    speed,
    pauseCommaSec,
    pauseSentenceSec,
    pauseParagraphSec,
    pronunciationLexicon,
    exportFormat,
    exportSampleRate,
    exportBitrateKbps,
    masteringEnabled,
  }), [
    creatorPreset,
    exportBitrateKbps,
    exportFormat,
    exportSampleRate,
    masteringEnabled,
    pauseCommaSec,
    pauseParagraphSec,
    pauseSentenceSec,
    pronunciationLexicon,
    speed,
  ]);

  return {
    creatorPreset,
    speed,
    pauseCommaSec,
    pauseSentenceSec,
    pauseParagraphSec,
    pronunciationLexicon,
    generationSettings,
    exportOptions,
    persistedState,
    onCreatorPresetChange: applyPreset,
    onSpeedChange: (value: number) => withCustomPreset(() => setSpeed(value)),
    onPauseCommaChange: (value: number) => withCustomPreset(() => setPauseCommaSec(value)),
    onPauseSentenceChange: (value: number) => withCustomPreset(() => setPauseSentenceSec(value)),
    onPauseParagraphChange: (value: number) => withCustomPreset(() => setPauseParagraphSec(value)),
    onPronunciationLexiconChange: (value: string) => withCustomPreset(() => setPronunciationLexicon(value)),
    onExportFormatChange: (value: ExportAudioFormat) => withCustomPreset(() => setExportFormat(value)),
    onExportSampleRateChange: (value: ExportSampleRate) => withCustomPreset(() => setExportSampleRate(value)),
    onExportBitrateChange: (value: number) => withCustomPreset(() => setExportBitrateKbps(value)),
    onMasteringEnabledChange: (value: boolean) => withCustomPreset(() => setMasteringEnabled(value)),
  };
}
