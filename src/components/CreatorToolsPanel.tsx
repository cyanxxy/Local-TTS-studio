import { useState } from "react";
import { ChevronDown, Download, FileCode2, FileJson, Subtitles } from "lucide-react";
import {
  CREATOR_PRESETS,
  PAUSE_MAX,
  PAUSE_MIN,
  PAUSE_STEP,
  SPEED_MAX,
  SPEED_MIN,
  SPEED_STEP,
} from "../constants";
import type {
  AudioExportOptions,
  CaptionExportFormat,
  CreatorPresetId,
  ExportAudioFormat,
  ExportSampleRate,
} from "../types";

interface CreatorToolsPanelProps {
  preset: CreatorPresetId;
  onPresetChange: (preset: CreatorPresetId) => void;
  speed: number;
  onSpeedChange: (value: number) => void;
  pauseCommaSec: number;
  onPauseCommaSecChange: (value: number) => void;
  pauseSentenceSec: number;
  onPauseSentenceSecChange: (value: number) => void;
  pauseParagraphSec: number;
  onPauseParagraphSecChange: (value: number) => void;
  pronunciationLexicon: string;
  onPronunciationLexiconChange: (value: string) => void;
  exportOptions: AudioExportOptions;
  onExportFormatChange: (format: ExportAudioFormat) => void;
  onExportSampleRateChange: (rate: ExportSampleRate) => void;
  onExportBitrateKbpsChange: (bitrate: number) => void;
  onMasteringEnabledChange: (enabled: boolean) => void;
  hasAudio: boolean;
  onDownloadAudio: () => void;
  onDownloadCaptions: (format: CaptionExportFormat) => void;
}

const EXPORT_FORMAT_OPTIONS: Array<{ value: ExportAudioFormat; label: string }> = [
  { value: "wav-pcm24", label: "WAV 24-bit" },
  { value: "wav-pcm16", label: "WAV 16-bit" },
  { value: "wav-f32", label: "WAV Float 32" },
  { value: "mp3", label: "MP3" },
];

const EXPORT_SAMPLE_RATE_OPTIONS: Array<{ value: ExportSampleRate; label: string }> = [
  { value: "source", label: "Source" },
  { value: 44100, label: "44.1 kHz" },
  { value: 48000, label: "48 kHz" },
];

const BITRATE_OPTIONS = [128, 192, 256, 320] as const;

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-2xs font-semibold uppercase tracking-[0.15em] text-text-muted mb-2">
      {children}
    </div>
  );
}

export function CreatorToolsPanel({
  preset,
  onPresetChange,
  speed,
  onSpeedChange,
  pauseCommaSec,
  onPauseCommaSecChange,
  pauseSentenceSec,
  onPauseSentenceSecChange,
  pauseParagraphSec,
  onPauseParagraphSecChange,
  pronunciationLexicon,
  onPronunciationLexiconChange,
  exportOptions,
  onExportFormatChange,
  onExportSampleRateChange,
  onExportBitrateKbpsChange,
  onMasteringEnabledChange,
  hasAudio,
  onDownloadAudio,
  onDownloadCaptions,
}: CreatorToolsPanelProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="glass rounded-[20px] overflow-hidden">
      <button
        onClick={() => setOpen((value) => !value)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-white/40 transition-colors"
      >
        <span className="text-xs font-semibold uppercase tracking-widest text-text-muted">
          Creator Toolkit
        </span>
        <ChevronDown
          size={14}
          className={`text-text-muted transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="flex flex-col gap-4 border-t border-black/5 px-4 pb-4 animate-fade-up sm:gap-5">
          {/* Preset */}
          <div className="pt-3">
            <label className="text-xs font-semibold uppercase tracking-widest text-text-muted">
              Platform Preset
            </label>
            <select
              className="mt-2 w-full rounded-lg border border-black/10 bg-white/60 backdrop-blur-sm px-2.5 py-2 text-xs text-text-primary"
              value={preset}
              onChange={(event) => onPresetChange(event.target.value as CreatorPresetId)}
            >
              <option value="custom">Custom</option>
              {Object.values(CREATOR_PRESETS).map((presetItem) => (
                <option key={presetItem.id} value={presetItem.id}>
                  {presetItem.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-text-muted">
              {preset === "custom" ? "Manual creator settings." : CREATOR_PRESETS[preset].description}
            </p>
          </div>

          {/* Timing */}
          <div className="space-y-3">
            <SectionLabel>Timing</SectionLabel>

            <div>
              <div className="flex items-baseline justify-between mb-1">
                <label className="text-xs font-medium text-text-secondary">
                  Base Speed
                </label>
                <span className="font-mono text-sm text-text-primary">{speed.toFixed(2)}x</span>
              </div>
              <input
                type="range"
                min={SPEED_MIN}
                max={SPEED_MAX}
                step={SPEED_STEP}
                value={speed}
                onChange={(event) => onSpeedChange(parseFloat(event.target.value))}
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <div className="flex items-baseline justify-between mb-1">
                  <label className="text-xs font-medium text-text-secondary">Comma</label>
                  <span className="font-mono text-xs text-text-muted">{pauseCommaSec.toFixed(2)}s</span>
                </div>
                <input
                  type="range"
                  min={PAUSE_MIN}
                  max={PAUSE_MAX}
                  step={PAUSE_STEP}
                  value={pauseCommaSec}
                  onChange={(event) => onPauseCommaSecChange(parseFloat(event.target.value))}
                />
              </div>
              <div>
                <div className="flex items-baseline justify-between mb-1">
                  <label className="text-xs font-medium text-text-secondary">Sentence</label>
                  <span className="font-mono text-xs text-text-muted">{pauseSentenceSec.toFixed(2)}s</span>
                </div>
                <input
                  type="range"
                  min={PAUSE_MIN}
                  max={PAUSE_MAX}
                  step={PAUSE_STEP}
                  value={pauseSentenceSec}
                  onChange={(event) => onPauseSentenceSecChange(parseFloat(event.target.value))}
                />
              </div>
              <div>
                <div className="flex items-baseline justify-between mb-1">
                  <label className="text-xs font-medium text-text-secondary">Paragraph</label>
                  <span className="font-mono text-xs text-text-muted">{pauseParagraphSec.toFixed(2)}s</span>
                </div>
                <input
                  type="range"
                  min={PAUSE_MIN}
                  max={PAUSE_MAX}
                  step={PAUSE_STEP}
                  value={pauseParagraphSec}
                  onChange={(event) => onPauseParagraphSecChange(parseFloat(event.target.value))}
                />
              </div>
            </div>
          </div>

          {/* Pronunciation */}
          <div>
            <SectionLabel>Pronunciation</SectionLabel>
            <textarea
              className="w-full min-h-16 rounded-lg border border-black/10 bg-white/60 backdrop-blur-sm px-2.5 py-2 text-sm text-text-primary resize-y placeholder:text-text-muted/50"
              placeholder={`route=r-ow-t\nGIF=jiff\nSQL=sequel`}
              value={pronunciationLexicon}
              onChange={(event) => onPronunciationLexiconChange(event.target.value)}
            />
            <p className="mt-1 text-xs text-text-muted">
              One rule per line: word=replacement
            </p>
          </div>

          {/* Export */}
          <div className="border-t border-black/5 pt-4 space-y-3">
            <SectionLabel>Export</SectionLabel>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <label className="text-xs font-medium text-text-secondary">Format</label>
                <select
                  className="mt-1 w-full rounded-lg border border-black/10 bg-white/60 backdrop-blur-sm px-2.5 py-2 text-xs text-text-primary"
                  value={exportOptions.format}
                  onChange={(event) => onExportFormatChange(event.target.value as ExportAudioFormat)}
                >
                  {EXPORT_FORMAT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs font-medium text-text-secondary">Sample Rate</label>
                <select
                  className="mt-1 w-full rounded-lg border border-black/10 bg-white/60 backdrop-blur-sm px-2.5 py-2 text-xs text-text-primary"
                  value={String(exportOptions.sampleRate)}
                  onChange={(event) => {
                    const raw = event.target.value;
                    const parsed = raw === "source" ? "source" : Number(raw);
                    onExportSampleRateChange(parsed as ExportSampleRate);
                  }}
                >
                  {EXPORT_SAMPLE_RATE_OPTIONS.map((option) => (
                    <option key={String(option.value)} value={String(option.value)}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {exportOptions.format === "mp3" && (
              <div className="max-w-full sm:max-w-[50%]">
                <label className="text-xs font-medium text-text-secondary">Bitrate</label>
                <select
                  className="mt-1 w-full rounded-lg border border-black/10 bg-white/60 backdrop-blur-sm px-2.5 py-2 text-xs text-text-primary"
                  value={exportOptions.bitrateKbps}
                  onChange={(event) => onExportBitrateKbpsChange(parseInt(event.target.value, 10))}
                >
                  {BITRATE_OPTIONS.map((value) => (
                    <option key={value} value={value}>
                      {value} kbps
                    </option>
                  ))}
                </select>
              </div>
            )}

            <label className="flex cursor-pointer items-start gap-2 text-sm text-text-secondary select-none">
              <input
                type="checkbox"
                checked={exportOptions.mastering.enabled}
                onChange={(event) => onMasteringEnabledChange(event.target.checked)}
                className="accent-accent"
              />
              Normalize loudness for voiceover
            </label>

            <div className="grid grid-cols-2 gap-2 pt-1 sm:grid-cols-4">
              <button
                type="button"
                onClick={onDownloadAudio}
                disabled={!hasAudio}
                className={`w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-xs font-medium transition-colors ${
                  hasAudio
                    ? "glass-accent text-white"
                    : "bg-border text-text-muted cursor-not-allowed"
                }`}
              >
                <Download size={12} />
                Audio
              </button>
              <button
                type="button"
                onClick={() => onDownloadCaptions("srt")}
                disabled={!hasAudio}
                className={`w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-xs font-medium border transition-colors ${
                  hasAudio
                    ? "border-white/55 bg-white/40 backdrop-blur-sm text-text-secondary hover:bg-white/60 hover:text-text-primary"
                    : "border-border text-text-muted cursor-not-allowed"
                }`}
              >
                <Subtitles size={12} />
                SRT
              </button>
              <button
                type="button"
                onClick={() => onDownloadCaptions("vtt")}
                disabled={!hasAudio}
                className={`w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-xs font-medium border transition-colors ${
                  hasAudio
                    ? "border-white/55 bg-white/40 backdrop-blur-sm text-text-secondary hover:bg-white/60 hover:text-text-primary"
                    : "border-border text-text-muted cursor-not-allowed"
                }`}
              >
                <FileCode2 size={12} />
                VTT
              </button>
              <button
                type="button"
                onClick={() => onDownloadCaptions("json")}
                disabled={!hasAudio}
                className={`w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-xs font-medium border transition-colors ${
                  hasAudio
                    ? "border-white/55 bg-white/40 backdrop-blur-sm text-text-secondary hover:bg-white/60 hover:text-text-primary"
                    : "border-border text-text-muted cursor-not-allowed"
                }`}
              >
                <FileJson size={12} />
                JSON
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
